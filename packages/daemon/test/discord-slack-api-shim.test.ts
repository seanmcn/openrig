// The Discord adapter behind the Slack Web API calls the gateway's chat logic makes: each call goes through the real
// Slack client function, into the shim, onto an in-memory Discord.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWebApi, fetchRecentMessageTexts, postChatMessage, type FetchImpl } from "../src/domain/gateway/slack/slack-api.js";
import { buildOutboundMessage, reconcileToken } from "../src/domain/gateway/slack/message.js";
import { createSlackApiShim, DiscordPostedStore } from "../src/domain/gateway/discord/slack-api-shim.js";
import { DiscordIdMap } from "../src/domain/gateway/discord/discord-ids.js";
import { DiscordChannels } from "../src/domain/gateway/discord/discord-rest.js";
import { slackMicros } from "../src/domain/gateway/slack/state-store.js";
import { BOT_ID, FakeDiscord } from "./helpers/fake-discord.js";

const CH = "700000000000000001";
const TOKEN = "discord-bot-token";
const ask = (marker = "dec-1") => buildOutboundMessage({
  qitemId: "q1", ownerNotificationKind: "human-required", summary: "Ship it?", body: "Because the build is green.",
  humanQuestions: [{ id: "ship", question: "Ship today?", options: [{ id: "yes", label: "Yes", recommended: true }, { id: "no", label: "No" }] }],
}, { sourceLabel: "openrig", mentionUserId: "111111111111111111", reconcileMarker: reconcileToken(marker) });

describe("the Slack Web API, answered from Discord", () => {
  let dir: string;
  let discord: FakeDiscord;
  let ids: DiscordIdMap;
  let shim: FetchImpl;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dshim-"));
    discord = new FakeDiscord(CH);
    ids = new DiscordIdMap(join(dir, "ids.jsonl"));
    shim = createSlackApiShim({ rest: discord, ids, channels: new DiscordChannels(discord), posted: new DiscordPostedStore(join(dir, "posted.jsonl")) });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("posts an ask as a root with buttons and opens its thread with the why", async () => {
    const r = await postChatMessage(TOKEN, { channel: CH, ...ask() }, shim);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = discord.messages.get(ids.snowflakeFor(r.ts)!)!;
    expect(root.channel_id).toBe(CH);
    expect(root.components).toHaveLength(1);
    expect(discord.threads.get(root.id)).toBe(CH);
    expect(discord.inChannel(root.id).map((m) => m.content).join("\n")).toContain("Because the build is green.");
    expect(r.threadTs ?? null).toBeNull(); // a root, not a reply
  });

  it("a reply to a posted root goes into its thread", async () => {
    const first = await postChatMessage(TOKEN, { channel: CH, ...ask() }, shim);
    if (!first.ok) throw new Error("post failed");
    const reply = await postChatMessage(TOKEN, { channel: CH, text: "Recorded.", thread_ts: first.ts }, shim);
    expect(reply).toMatchObject({ ok: true, threadTs: first.ts });
    if (!reply.ok) return;
    expect(discord.messages.get(ids.snowflakeFor(reply.ts)!)!.channel_id).toBe(ids.snowflakeFor(first.ts));
  });

  it("a reply to the person's own message starts a thread from it", async () => {
    const theirs = discord.write(CH, "Can you check the build?");
    const reply = await postChatMessage(TOKEN, { channel: CH, text: "On it.", thread_ts: ids.tsFor(theirs.id) }, shim);
    expect(reply).toMatchObject({ ok: true, threadTs: ids.tsFor(theirs.id) });
    expect(discord.threads.get(theirs.id)).toBe(CH);
  });

  it("a reply whose root is gone posts top-level, as Slack does, so the caller closes the mapping", async () => {
    const theirs = discord.write(CH, "hello");
    const ts = ids.tsFor(theirs.id);
    discord.messages.delete(theirs.id);
    const reply = await postChatMessage(TOKEN, { channel: CH, text: "On it.", thread_ts: ts }, shim);
    expect(reply).toMatchObject({ ok: true, threadTs: null });
    if (!reply.ok) return;
    expect(discord.messages.get(ids.snowflakeFor(reply.ts)!)!.channel_id).toBe(CH);
  });

  it("a reconcile scan finds an earlier attempt by its marker", async () => {
    await postChatMessage(TOKEN, { channel: CH, ...ask("dec-9") }, shim);
    for (let i = 0; i < 3; i++) discord.write(CH, `chatter ${i}`);
    const scan = await fetchRecentMessageTexts(TOKEN, CH, undefined, shim, 2, 5000, reconcileToken("dec-9"));
    expect(scan.ok).toBe(true);
    expect(scan.texts.some((t) => t.includes(reconcileToken("dec-9")))).toBe(true);
  });

  it("channel history is newest first inside the window, with a cursor for more, and marks bot posts", async () => {
    const before = discord.write(CH, "before the window");
    const a = discord.write(CH, "one");
    const b = discord.write(CH, "two", { id: BOT_ID, username: "openrig", bot: true });
    const c = discord.write(CH, "three");
    const after = discord.write(CH, "after the window");
    const oldest = ids.tsFor(before.id);
    const latest = ids.tsFor(after.id);
    const page1 = await callWebApi("conversations.history", TOKEN, { channel: CH, oldest, latest, inclusive: false, limit: 2 }, shim, 5000, "get-query");
    expect(page1.ok).toBe(true);
    const msgs1 = page1.json.messages as Array<{ ts: string; text: string; bot_id?: string; user?: string }>;
    expect(msgs1.map((m) => m.text)).toEqual(["three", "two"]);
    expect(msgs1[1]!.bot_id).toBeTruthy();
    expect(page1.json.has_more).toBe(true);
    const cursor = (page1.json.response_metadata as { next_cursor: string }).next_cursor;
    const page2 = await callWebApi("conversations.history", TOKEN, { channel: CH, oldest, latest, limit: 2, cursor }, shim, 5000, "get-query");
    expect((page2.json.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["one"]);
    expect(page2.json.has_more).toBe(false);
    for (const id of [a.id, b.id, c.id]) expect(slackMicros(ids.tsFor(id))! > slackMicros(oldest)!).toBe(true);
  });

  it("thread replies come oldest first, each naming its root", async () => {
    const root = discord.write(CH, "Can you check?");
    const rootTs = ids.tsFor(root.id);
    await postChatMessage(TOKEN, { channel: CH, text: "On it.", thread_ts: rootTs }, shim);
    discord.write(root.id, "thanks");
    const r = await callWebApi("conversations.replies", TOKEN, { channel: CH, ts: rootTs, oldest: "0.000000", limit: 15 }, shim, 5000, "get-query");
    const msgs = r.json.messages as Array<{ text: string; thread_ts: string; user: string; bot_id?: string }>;
    expect(msgs.map((m) => m.text)).toEqual(["On it.", "thanks"]);
    expect(msgs.every((m) => m.thread_ts === rootTs)).toBe(true);
    expect(msgs[0]!.bot_id).toBeTruthy();
  });

  it("replies of a message no one has threaded yet are empty, not an error", async () => {
    const root = discord.write(CH, "solo");
    const r = await callWebApi("conversations.replies", TOKEN, { channel: CH, ts: ids.tsFor(root.id), limit: 15 }, shim, 5000, "get-query");
    expect(r.ok).toBe(true);
    expect(r.json.messages).toEqual([]);
  });

  it("settling an ask edits its root: status first, buttons kept but disabled, the hint gone", async () => {
    const posted = await postChatMessage(TOKEN, { channel: CH, ...ask() }, shim);
    if (!posted.ok) throw new Error("post failed");
    const read = await callWebApi("conversations.history", TOKEN, { channel: CH, latest: posted.ts, inclusive: true, limit: 1 }, shim, 5000, "get-query");
    const original = (read.json.messages as Array<{ ts: string; text: string; blocks: unknown[] }>)[0]!;
    expect(original.ts).toBe(posted.ts);
    expect(Array.isArray(original.blocks)).toBe(true);
    const blocks = [{ type: "context", block_id: "or-settled", elements: [{ type: "mrkdwn", text: "Answered · by founder" }] },
      ...original.blocks.filter((b) => (b as { type: string }).type !== "actions")];
    const up = await callWebApi("chat.update", TOKEN, { channel: CH, ts: posted.ts, text: `Answered · by founder\n${original.text}`, blocks }, shim);
    expect(up.ok).toBe(true);
    const root = discord.messages.get(ids.snowflakeFor(posted.ts)!)!;
    expect(root.content.startsWith("-# Answered · by founder")).toBe(true);
    expect(root.content).not.toContain("Or reply in this thread");
    const buttons = (root.components as Array<{ components: Array<{ disabled?: boolean }> }>)[0]!.components;
    expect(buttons.every((b) => b.disabled === true)).toBe(true);
    // The next read returns what was written, so a later settlement edits from it.
    const again = await callWebApi("conversations.history", TOKEN, { channel: CH, latest: posted.ts, inclusive: true, limit: 1 }, shim, 5000, "get-query");
    expect((again.json.messages as Array<{ text: string }>)[0]!.text.startsWith("Answered · by founder")).toBe(true);
  });

  it("an ask posted into the person's thread is settled where it lives", async () => {
    const theirs = discord.write(CH, "Can you check the build?");
    const posted = await postChatMessage(TOKEN, { channel: CH, ...ask(), thread_ts: ids.tsFor(theirs.id) }, shim);
    if (!posted.ok) throw new Error("post failed");
    const up = await callWebApi("chat.update", TOKEN, { channel: CH, ts: posted.ts, text: "Answered\nx",
      blocks: [{ type: "context", block_id: "or-settled", elements: [{ type: "mrkdwn", text: "Answered" }] }] }, shim);
    expect(up.ok).toBe(true);
    const msg = discord.messages.get(ids.snowflakeFor(posted.ts)!)!;
    expect(msg.channel_id).toBe(theirs.id);
    expect(msg.content.startsWith("-# Answered")).toBe(true);
  });

  it("a layout Discord can't show is invalid_blocks", async () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ type: "actions", block_id: `or-q:q${i}`, elements: [{ type: "button", action_id: "or-opt:a", text: { type: "plain_text", text: "A" } }] }));
    const r = await postChatMessage(TOKEN, { channel: CH, text: "x", blocks }, shim);
    expect(r).toMatchObject({ ok: false, status: 200, error: "invalid_blocks" });
  });

  it("Discord's rate limit reaches the caller as Slack's, with its retry-after", async () => {
    discord.hook = () => ({ status: 429, json: { retry_after: 3.2 }, retryAfterSeconds: 4 });
    const r = await callWebApi("chat.postMessage", TOKEN, { channel: CH, text: "hi" }, shim);
    expect(r).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 4 });
  });

  it("opening the event connection returns the Gateway URL", async () => {
    const r = await callWebApi("apps.connections.open", TOKEN, {}, shim);
    expect(r.ok).toBe(true);
    expect(String(r.json.url)).toMatch(/^wss:\/\/gateway\.discord\.gg\/\?v=10&encoding=json$/);
  });
});
