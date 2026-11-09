// The Discord connector's outbound half: the Slack Web API calls the gateway's chat logic makes, answered from Discord.
//
// The chat logic (delivery, receipts, thread routing, recovery, ask settlement) reaches its platform only through a
// fetch function it calls with `https://slack.com/api/<method>` requests. This module is that fetch function for
// Discord: it reads the Slack request, does the same thing with Discord's REST API, and answers in the Slack response
// shape the caller already parses. Everything above it stays as it is, so Discord behaves exactly as Slack does.
//
// What maps to what:
// - A message's ts is its snowflake's time (discord-ids.ts); a channel id is the Discord channel id.
// - A Slack thread is a Discord thread started from the root message, whose channel id is that message's id. It is
//   created on the first reply (an ask opens it at once, with its why and evidence: render.ts).
// - Channel history pages backwards with `before`, filtered to the window; thread replies page forwards with `after`.
// - An ask's posted text and blocks are kept (DiscordPostedStore), so settlement can read them back and edit the root.
// - Files: the external-upload calls are held until completion, then sent as one message with attachments.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FetchImpl } from "../slack/slack-api.js";
import { BASELINE_REQUIRED_SCOPES, FEATURE_SCOPES } from "../slack/capabilities.js";
import { slackMicros } from "../slack/state-store.js";
import { DiscordIdMap, isSnowflake } from "./discord-ids.js";
import type { DiscordChannels, DiscordFile, DiscordResponse, DiscordRest } from "./discord-rest.js";
import { DiscordRenderError, renderSlackPost, splitContent, type DiscordActionRow, type DiscordMessageBody } from "./render.js";

const SLACK_API = "https://slack.com/api/";
/** Where a held upload's bytes are "sent": never a network host; the shim keeps them until completion. */
export const UPLOAD_HOST = "https://discord-upload.openrig.invalid/";
const THREAD_ARCHIVE_MINUTES = 10080; // 7 days, the recovery window
const STATUS_BLOCK = "or-settled";

/** A Discord message as the REST API and the Gateway return it (the fields the adapter reads). */
export interface DiscordMessage {
  id: string;
  channel_id?: string;
  type?: number;
  content?: string;
  author?: { id?: string; bot?: boolean };
  webhook_id?: string;
  attachments?: Array<{ id?: string; filename?: string; url?: string; content_type?: string; size?: number }>;
  message_reference?: { message_id?: string; channel_id?: string };
  thread?: { id?: string };
}

/** The Slack shape of a Discord message. `threadTs`: the root's ts when the message is in a thread. */
export function toSlackMessage(m: DiscordMessage, ids: DiscordIdMap, opts: { threadTs?: string; posted?: DiscordPostedStore } = {}): Record<string, unknown> {
  const ts = ids.tsFor(m.id);
  const out: Record<string, unknown> = { type: "message", ts, user: m.author?.id, text: m.content ?? "" };
  // Webhook posts and every bot (OpenRig's own posts included) carry bot_id, which inbound never ingests.
  if (m.webhook_id) out.bot_id = m.webhook_id;
  else if (m.author?.bot) out.bot_id = m.author.id;
  // Only ordinary messages and replies are a person's words; system messages (joins, pins, thread notices) are not.
  if (m.type !== undefined && m.type !== 0 && m.type !== 19) out.subtype = `discord_type_${m.type}`;
  if (opts.threadTs) out.thread_ts = opts.threadTs;
  else if (m.thread?.id) out.thread_ts = ts;
  else if (m.type === 19 && isSnowflake(m.message_reference?.message_id) && (!m.message_reference?.channel_id || m.message_reference.channel_id === m.channel_id)) {
    // An inline reply to a message in the channel is a reply to that message's conversation.
    out.thread_ts = ids.tsFor(m.message_reference.message_id);
  }
  if (m.attachments?.length) {
    out.files = m.attachments.map((a) => ({ id: a.id, name: a.filename, mimetype: a.content_type, size: a.size, url_private: a.url }));
  }
  const stored = opts.posted?.get(m.id);
  if (stored) { out.text = stored.text; out.blocks = stored.blocks; }
  return out;
}

interface PostedRecord { id: string; channelId?: string; text: string; blocks: unknown[]; root: { content: string; components: DiscordActionRow[] } }

/** The Slack text and blocks of each ask OpenRig posted, and its rendered root, keyed by the root's id: what settlement
 *  reads back and edits. Latest record wins. */
export class DiscordPostedStore {
  private readonly records = new Map<string, PostedRecord>();
  constructor(private readonly file: string) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as PostedRecord; if (r?.id) this.records.set(r.id, r); } catch { /* torn line */ }
    }
  }
  get(id: string): PostedRecord | undefined { return this.records.get(id); }
  put(r: PostedRecord): void {
    this.records.set(r.id, r);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(r) + "\n");
    } catch { /* kept for this run */ }
  }
}

/** A Discord failure as the Slack error the caller's retry and permanence rules already know. */
function slackError(r: DiscordResponse): string {
  if (r.status === 429) return "ratelimited";
  if (r.status === 0) return r.error ?? "discord transport failed";
  if (r.status === 401) return "invalid_auth";
  if (r.code === 10003) return "channel_not_found";
  if (r.code === 10008) return "message_not_found";
  if (r.code === 50001 || r.code === 50013) return "not_in_channel";
  if (r.code === 50035) return "invalid_blocks";
  if (r.status >= 500) return `discord_${r.status}`;
  return `discord_${r.code ?? r.status}`;
}

function respond(json: Record<string, unknown>, status = 200, retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterSeconds) headers["retry-after"] = String(retryAfterSeconds);
  // The scopes header keeps `rig slack`-era readers (verify, status) honest: the bot can do all of it.
  headers["x-oauth-scopes"] = [...BASELINE_REQUIRED_SCOPES, ...FEATURE_SCOPES.map((f) => f.scope)].join(",");
  return new Response(JSON.stringify(json), { status, headers });
}
const fail = (r: DiscordResponse): Response => respond({ ok: false, error: slackError(r) }, r.status === 429 || r.status >= 500 || r.status === 0 ? (r.status || 503) : 200, r.retryAfterSeconds);

function readArgs(url: URL, init?: RequestInit): Record<string, unknown> {
  if ((init?.method ?? "GET").toUpperCase() === "GET") return Object.fromEntries(url.searchParams);
  const body = typeof init?.body === "string" ? init.body : "";
  const type = String((init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "");
  if (type.includes("application/json")) { try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; } }
  const form = Object.fromEntries(new URLSearchParams(body));
  return Object.fromEntries(Object.entries(form).map(([k, v]) => {
    if (v.startsWith("[") || v.startsWith("{")) { try { return [k, JSON.parse(v)]; } catch { return [k, v]; } }
    return [k, v];
  }));
}

export interface SlackApiShimDeps {
  rest: DiscordRest;
  ids: DiscordIdMap;
  channels: DiscordChannels;
  posted: DiscordPostedStore;
  log?: (msg: string) => void;
}

/** The fetch function that answers the gateway's Slack Web API calls from Discord. Any other URL goes to `passThrough`
 *  (default: the global fetch), so an inbound file download still reaches Discord's CDN. */
export function createSlackApiShim(deps: SlackApiShimDeps, passThrough: FetchImpl = fetch as FetchImpl): FetchImpl {
  const { rest, ids, channels, posted } = deps;
  const log = deps.log ?? (() => {});
  const uploads = new Map<string, { filename: string; bytes?: Uint8Array }>();

  /** Post into a thread started from `rootId`, creating it first when it doesn't exist yet. `gone` when the root is gone
   *  and no thread survives it: the caller posts top-level instead, as Slack does for a deleted root. */
  async function postInThread(rootId: string, channel: string, name: string, body: DiscordMessageBody, files?: DiscordFile[]): Promise<DiscordResponse | "gone"> {
    let r = await rest.request("POST", `/channels/${rootId}/messages`, body, files);
    if (r.code !== 10003) return r;
    const created = await rest.request("POST", `/channels/${channel}/messages/${rootId}/threads`, { name, auto_archive_duration: THREAD_ARCHIVE_MINUTES });
    if (created.status === 200 || created.status === 201) channels.note(created.json);
    else if (created.code === 10008) return "gone";
    else if (created.code !== 160004) return created;
    r = await rest.request("POST", `/channels/${rootId}/messages`, body, files);
    return r;
  }

  async function postMessage(a: Record<string, unknown>): Promise<Response> {
    const channel = String(a.channel ?? "");
    let rendered;
    try {
      rendered = renderSlackPost({ text: String(a.text ?? ""), blocks: Array.isArray(a.blocks) ? a.blocks : undefined });
    } catch (e) {
      if (e instanceof DiscordRenderError) { log(`discord: refused a post Discord can't show: ${e.message}`); return respond({ ok: false, error: "invalid_blocks" }); }
      throw e;
    }
    const [first, ...rest_] = rendered.messages;
    const threadTs = typeof a.thread_ts === "string" && a.thread_ts ? a.thread_ts : undefined;
    let rootId = threadTs ? ids.snowflakeFor(threadTs) : null;
    let threaded = Boolean(rootId);
    let r: DiscordResponse | "gone";
    if (rootId) {
      r = await postInThread(rootId, channel, rendered.threadName, first!);
      if (r === "gone") { threaded = false; rootId = null; r = await rest.request("POST", `/channels/${channel}/messages`, first); }
    } else {
      r = await rest.request("POST", `/channels/${channel}/messages`, first);
    }
    if (r.status !== 200) return fail(r);
    const id = String(r.json.id);
    const ts = ids.tsFor(id);
    // The rest of the post: in the same thread, or a thread opened from this root. A part that won't post is logged; the
    // root, which carries the ask's buttons and its reconcile marker, is the post.
    for (const body of rest_) {
      const part = await postInThread(threaded ? rootId! : id, channel, rendered.threadName, body);
      if (part === "gone" || part.status !== 200) log(`discord: part of post ${ts} not posted in its thread: ${part === "gone" ? "root gone" : slackError(part)}`);
    }
    if (!threaded && rendered.opensThread && !rest_.length) {
      // An ask with no why still opens its thread, where the person answers.
      const created = await rest.request("POST", `/channels/${channel}/messages/${id}/threads`, { name: rendered.threadName, auto_archive_duration: THREAD_ARCHIVE_MINUTES });
      if (created.status === 200 || created.status === 201) channels.note(created.json);
      else log(`discord: thread for ${ts} not opened: ${slackError(created)}`);
    }
    if (rendered.ask) {
      posted.put({ id, channelId: String(r.json.channel_id ?? (threaded ? rootId : channel)), text: String(a.text ?? ""),
        blocks: Array.isArray(a.blocks) ? a.blocks : [], root: { content: first!.content, components: first!.components ?? [] } });
    }
    return respond({ ok: true, channel, ts, message: { ts, ...(threaded ? { thread_ts: threadTs } : {}) } });
  }

  async function update(a: Record<string, unknown>): Promise<Response> {
    const ts = String(a.ts ?? "");
    const id = ids.snowflakeFor(ts);
    if (!id) return respond({ ok: false, error: "message_not_found" });
    const channel = String(a.channel ?? "");
    const blocks = Array.isArray(a.blocks) ? a.blocks as Array<{ block_id?: string; type?: string; elements?: Array<{ text?: string }> }> : [];
    const record = posted.get(id);
    let body: Record<string, unknown>;
    if (record) {
      // A settled ask: its status leads, the questions and buttons stay as the record of what was asked (disabled),
      // and the reply hints, which no longer apply, go.
      const status = blocks.find((b) => b.block_id === STATUS_BLOCK)?.elements?.[0]?.text;
      const live = blocks.some((b) => b.type === "actions");
      const lines = record.root.content.split("\n").filter((line) => live || !/^-# (Or reply|Reply) in this thread/.test(line));
      const content = splitContent([status ? `-# ${renderSlackPost({ text: status }).messages[0]!.content}` : "", ...lines].filter(Boolean).join("\n"))[0]!;
      body = { content, components: record.root.components.map((row) => ({ ...row, components: row.components.map((b) => ({ ...b, disabled: !live })) })), allowed_mentions: { parse: [] } };
    } else {
      let rendered;
      try { rendered = renderSlackPost({ text: String(a.text ?? ""), blocks }); } catch { return respond({ ok: false, error: "invalid_blocks" }); }
      body = { content: rendered.messages[0]!.content, components: rendered.messages[0]!.components ?? [], allowed_mentions: { parse: [] } };
    }
    // An ask posted into a person's thread lives in that thread's channel, which its record names.
    const r = await rest.request("PATCH", `/channels/${record?.channelId ?? channel}/messages/${id}`, body);
    if (r.status !== 200) return fail(r);
    if (record) posted.put({ ...record, text: String(a.text ?? record.text), blocks });
    return respond({ ok: true, channel, ts });
  }

  /** Channel history: newest first, strictly inside (oldest, latest), `limit` per page, a cursor while there's more. */
  async function history(a: Record<string, unknown>): Promise<Response> {
    const channel = String(a.channel ?? "");
    const limit = Math.max(1, Math.min(100, Number(a.limit ?? 100) || 100));
    const inclusive = a.inclusive === true || a.inclusive === "true";
    const latest = typeof a.latest === "string" ? a.latest : undefined;
    if (inclusive && latest && limit === 1) {
      const id = ids.snowflakeFor(latest);
      if (!id) return respond({ ok: true, messages: [], has_more: false });
      const r = await rest.request("GET", `/channels/${channel}/messages/${id}`);
      if (r.code === 10008) return respond({ ok: true, messages: [], has_more: false });
      if (r.status !== 200) return fail(r);
      return respond({ ok: true, messages: [toSlackMessage(r.json, ids, { posted })], has_more: false });
    }
    const oldest = typeof a.oldest === "string" ? slackMicros(a.oldest) : null;
    const cursor = typeof a.cursor === "string" && isSnowflake(a.cursor) ? a.cursor : undefined;
    const before = cursor ?? (latest ? ids.snowflakeFor(latest) ?? DiscordIdMap.boundFor(latest) : undefined);
    const q = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
    const r = await rest.request("GET", `/channels/${channel}/messages?${q}`);
    if (r.status !== 200) return fail(r);
    const page = (Array.isArray(r.json) ? r.json : []) as DiscordMessage[];
    const latestMicros = latest ? slackMicros(latest) : null;
    const mapped = page.map((m) => toSlackMessage(m, ids, { posted }));
    const inWindow = mapped.filter((m) => {
      const t = slackMicros(m.ts)!;
      return (oldest === null || t > oldest) && (latestMicros === null || t < latestMicros || (inclusive && t === latestMicros));
    });
    const reachedOldest = inWindow.length < mapped.length;
    const more = page.length === limit && !reachedOldest;
    return respond({ ok: true, messages: inWindow, has_more: more, response_metadata: { next_cursor: more ? page.at(-1)!.id : "" } });
  }

  /** Thread replies: oldest first, after `oldest`, before `latest`, each naming its root. A message nobody has threaded
   *  has no replies; Slack would return the root alone, which every caller drops. */
  async function replies(a: Record<string, unknown>): Promise<Response> {
    const threadTs = String(a.ts ?? "");
    const threadId = ids.snowflakeFor(threadTs);
    if (!threadId) return respond({ ok: false, error: "thread_not_found" });
    const limit = Math.max(1, Math.min(100, Number(a.limit ?? 100) || 100));
    const inclusive = a.inclusive === true || a.inclusive === "true";
    const oldestTs = typeof a.oldest === "string" ? a.oldest : undefined;
    if (inclusive && oldestTs && limit === 1) {
      const id = ids.snowflakeFor(oldestTs);
      if (!id) return respond({ ok: true, messages: [], has_more: false });
      const r = await rest.request("GET", `/channels/${threadId}/messages/${id}`);
      if (r.code === 10008 || r.code === 10003) return respond({ ok: true, messages: [], has_more: false });
      if (r.status !== 200) return fail(r);
      return respond({ ok: true, messages: [toSlackMessage(r.json, ids, { threadTs, posted })], has_more: false });
    }
    const cursor = typeof a.cursor === "string" && isSnowflake(a.cursor) ? a.cursor : undefined;
    const after = cursor ?? (oldestTs ? ids.snowflakeFor(oldestTs) ?? DiscordIdMap.boundFor(oldestTs) : "0");
    const r = await rest.request("GET", `/channels/${threadId}/messages?${new URLSearchParams({ limit: String(limit), after })}`);
    if (r.code === 10003) return respond({ ok: true, messages: [], has_more: false });
    if (r.status !== 200) return fail(r);
    const page = ((Array.isArray(r.json) ? r.json : []) as DiscordMessage[]).sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
    const oldest = oldestTs ? slackMicros(oldestTs) : null;
    const latest = typeof a.latest === "string" ? slackMicros(a.latest) : null;
    const mapped = page.filter((m) => m.type !== 21).map((m) => toSlackMessage(m, ids, { threadTs, posted }));
    const inWindow = mapped.filter((m) => {
      const t = slackMicros(m.ts)!;
      return (oldest === null || t > oldest || (inclusive && t === oldest)) && (latest === null || t < latest);
    });
    const reachedLatest = latest !== null && mapped.some((m) => slackMicros(m.ts)! >= latest);
    const more = page.length === limit && !reachedLatest;
    return respond({ ok: true, messages: inWindow, has_more: more, response_metadata: { next_cursor: more ? page.at(-1)!.id : "" } });
  }

  async function completeUpload(a: Record<string, unknown>): Promise<Response> {
    const list = (Array.isArray(a.files) ? a.files : []) as Array<{ id?: string; title?: string }>;
    const files: DiscordFile[] = [];
    for (const f of list) {
      const held = uploads.get(String(f.id));
      if (!held?.bytes) return respond({ ok: false, error: "file_not_found" });
      files.push({ name: held.filename, bytes: held.bytes, ...(f.title ? { description: f.title.slice(0, 1024) } : {}) });
    }
    const channel = String(a.channel_id ?? "");
    const body = { content: splitContent(String(a.initial_comment ?? ""))[0] ?? "", allowed_mentions: { parse: [], users: [] } };
    const rootId = typeof a.thread_ts === "string" ? ids.snowflakeFor(a.thread_ts) : null;
    let r = rootId ? await postInThread(rootId, channel, "Attachments", body, files) : await rest.request("POST", `/channels/${channel}/messages`, body, files);
    if (r === "gone") r = await rest.request("POST", `/channels/${channel}/messages`, body, files);
    for (const f of list) uploads.delete(String(f.id));
    if (r.status === 413) return respond({ ok: false, error: "file_too_large" });
    if (r.status !== 200) return fail(r);
    return respond({ ok: true, files: list.map((f) => ({ id: f.id })) });
  }

  return async (input, init) => {
    const url = new URL(String(input));
    if (url.href.startsWith(UPLOAD_HOST)) {
      const held = uploads.get(url.pathname.slice(1));
      if (!held) return new Response("unknown upload", { status: 404 });
      const raw = init?.body;
      held.bytes = raw instanceof Uint8Array ? raw : new Uint8Array(await new Response(raw as ConstructorParameters<typeof Response>[0]).arrayBuffer());
      return new Response("OK", { status: 200 });
    }
    if (!url.href.startsWith(SLACK_API)) return passThrough(input, init);
    const method = url.pathname.slice("/api/".length);
    const a = readArgs(url, init);
    try {
      switch (method) {
        case "auth.test": {
          const r = await rest.request("GET", "/users/@me");
          return r.status === 200 ? respond({ ok: true, user_id: r.json.id, bot_id: r.json.id, user: r.json.username }) : fail(r);
        }
        case "apps.connections.open": {
          const r = await rest.request("GET", "/gateway/bot");
          return r.status === 200 && typeof r.json.url === "string" ? respond({ ok: true, url: `${r.json.url}/?v=10&encoding=json` }) : fail(r);
        }
        case "chat.postMessage": return await postMessage(a);
        case "chat.update": return await update(a);
        case "conversations.history": return await history(a);
        case "conversations.replies": return await replies(a);
        case "conversations.info": {
          const r = await rest.request("GET", `/channels/${String(a.channel ?? "")}`);
          return r.status === 200 ? respond({ ok: true, channel: { id: r.json.id, name: r.json.name, is_member: true } }) : fail(r);
        }
        case "files.getUploadURLExternal": {
          const fileId = `F${randomUUID().replace(/-/g, "")}`;
          uploads.set(fileId, { filename: String(a.filename ?? "file") });
          return respond({ ok: true, upload_url: `${UPLOAD_HOST}${fileId}`, file_id: fileId });
        }
        case "files.completeUploadExternal": return await completeUpload(a);
        default:
          // bots.info, users.list, conversations.list: Slack-only features (named-bot inbox, directory) Discord doesn't offer.
          return respond({ ok: false, error: "not_supported_on_discord" });
      }
    } catch (e) {
      log(`discord: ${method} failed: ${(e as Error).message}`);
      return respond({ ok: false, error: "discord_adapter_error" }, 500);
    }
  };
}
