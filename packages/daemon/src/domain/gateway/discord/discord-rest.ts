// The Discord REST API (v10) over fetch, with no SDK: bot-token auth, JSON or multipart bodies, and Discord's rate limits.
//
// Rate limits: each response names its bucket and how many requests it has left. A request to a route whose bucket is
// spent waits for the reset when that is short, and otherwise returns a 429 without calling Discord, so the caller's own
// retain-and-retry owns long windows (as it does for Slack). A global 429 holds every route. A 429 Discord returns is
// passed back with its retry-after, never retried here: the gateway's delivery layer decides whether to retry a post.

import type { FetchImpl } from "../slack/slack-api.js";

export const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INLINE_WAIT_MS = 2_000;

export interface DiscordResponse {
  status: number;
  /** The parsed body: an object, an array, or {} for an empty or non-JSON body. */
  json: any;
  /** Seconds to wait before trying again, on a 429. */
  retryAfterSeconds?: number;
  /** Discord's own error code (`code` in an error body), e.g. 10003 Unknown Channel. */
  code?: number;
  error?: string;
}

export interface DiscordFile { name: string; bytes: Uint8Array; contentType?: string; description?: string }

export interface DiscordRest {
  request(method: string, path: string, body?: unknown, files?: DiscordFile[]): Promise<DiscordResponse>;
}

/** The bucket key for a route: the path with ids replaced, except the top-level resource id Discord buckets by. */
function routeKey(method: string, path: string): string {
  const major = /^\/(channels|guilds|webhooks)\/(\d+)/.exec(path);
  const generic = path.replace(/\/\d{15,21}/g, "/:id").replace(/\/interactions\/:id\/[^/]+/, "/interactions/:id/:token");
  return `${method} ${generic} ${major ? major[2] : ""}`;
}

export function createDiscordRest(opts: {
  token: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgentVersion?: string;
}): DiscordRest {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** route → bucket id; bucket id → when its spent window resets. */
  const bucketOf = new Map<string, string>();
  const spentUntil = new Map<string, number>();
  let globalUntil = 0;

  return {
    async request(method, path, body, files) {
      const route = routeKey(method, path);
      const bucket = bucketOf.get(route) ?? route;
      const waitUntil = Math.max(globalUntil, spentUntil.get(bucket) ?? 0);
      const wait = waitUntil - now();
      if (wait > 0) {
        if (wait > MAX_INLINE_WAIT_MS) return { status: 429, json: {}, retryAfterSeconds: Math.ceil(wait / 1000), error: "ratelimited" };
        await sleep(wait);
      }
      const headers: Record<string, string> = {
        authorization: `Bot ${opts.token}`,
        "user-agent": `DiscordBot (https://github.com/mvschwarz/openrig, ${opts.userAgentVersion ?? "0"})`,
      };
      let payload: RequestInit["body"];
      if (files?.length) {
        const form = new FormData();
        const json = { ...(body as object | undefined), attachments: files.map((f, i) => ({ id: i, filename: f.name, ...(f.description ? { description: f.description } : {}) })) };
        form.append("payload_json", JSON.stringify(json));
        files.forEach((f, i) => form.append(`files[${i}]`, new Blob([Buffer.from(f.bytes)], { type: f.contentType ?? "application/octet-stream" }), f.name));
        payload = form;
      } else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      let res: Response;
      try {
        res = await fetchImpl(`${DISCORD_API}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      } catch (e) {
        // Never echo the request: a transport error can quote its Authorization header.
        return { status: 0, json: {}, error: `discord transport: ${(e as Error).name}` };
      }
      const h = (name: string) => res.headers.get(name);
      const bucketId = h("x-ratelimit-bucket");
      if (bucketId) bucketOf.set(route, bucketId);
      const remaining = Number(h("x-ratelimit-remaining"));
      const resetAfter = Number(h("x-ratelimit-reset-after"));
      if (h("x-ratelimit-remaining") !== null && remaining <= 0 && Number.isFinite(resetAfter)) spentUntil.set(bucketId ?? route, now() + resetAfter * 1000);
      let json: any = {};
      const text = await res.text().catch(() => "");
      if (text) { try { json = JSON.parse(text); } catch { json = {}; } }
      const out: DiscordResponse = { status: res.status, json };
      if (res.status === 429) {
        const seconds = Number(json?.retry_after ?? h("retry-after"));
        out.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1;
        if (json?.global === true || h("x-ratelimit-global") === "true") globalUntil = now() + out.retryAfterSeconds * 1000;
        else spentUntil.set(bucketId ?? route, now() + out.retryAfterSeconds * 1000);
      }
      if (res.status >= 400) {
        if (typeof json?.code === "number") out.code = json.code;
        out.error = typeof json?.message === "string" ? json.message : `http ${res.status}`;
      }
      return out;
    },
  };
}

/** Channel metadata the adapter needs: which channels are threads, and of which parent. Fed by Gateway events (guild
 *  create, thread create/update/list sync) and filled on demand from the REST API. */
export class DiscordChannels {
  private readonly parent = new Map<string, string | null>();
  constructor(private readonly rest: DiscordRest) {}

  /** Record a channel object (from an event or a lookup). Thread types 10/11/12 carry their parent. */
  note(channel: { id?: unknown; type?: unknown; parent_id?: unknown }): void {
    if (typeof channel.id !== "string") return;
    const thread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    this.parent.set(channel.id, thread && typeof channel.parent_id === "string" ? channel.parent_id : null);
  }

  /** The thread's parent channel, or null when this channel is no thread. Unknown and unreadable: null. */
  async parentOf(channelId: string): Promise<string | null> {
    if (this.parent.has(channelId)) return this.parent.get(channelId)!;
    const r = await this.rest.request("GET", `/channels/${channelId}`);
    if (r.status === 200) { this.note(r.json); return this.parent.get(channelId) ?? null; }
    return null;
  }

  isKnownThread(channelId: string): boolean {
    return Boolean(this.parent.get(channelId));
  }
}
