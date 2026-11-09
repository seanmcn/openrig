// An in-memory Discord for connector tests: channels, messages, threads started from messages, paging, edits,
// interaction callbacks. Only the REST behaviour the connector relies on, as Discord documents it.
import type { DiscordFile, DiscordResponse, DiscordRest } from "../../src/domain/gateway/discord/discord-rest.js";
import { DISCORD_EPOCH_MS } from "../../src/domain/gateway/discord/discord-ids.js";

export interface FakeMessage {
  id: string;
  channel_id: string;
  type: number;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  webhook_id?: string;
  components?: unknown[];
  attachments: Array<{ id: string; filename: string; url: string; content_type?: string; size: number }>;
  embeds?: unknown[];
  message_reference?: { message_id: string };
  thread?: { id: string };
}

export const BOT_ID = "900000000000000001";

export class FakeDiscord implements DiscordRest {
  private seq = 0;
  clock = Date.UTC(2026, 10, 9, 12, 0, 0);
  readonly messages = new Map<string, FakeMessage>();
  /** thread id → parent channel id */
  readonly threads = new Map<string, string>();
  readonly channels = new Set<string>();
  readonly calls: Array<{ method: string; path: string; body?: unknown; files?: DiscordFile[] }> = [];
  readonly callbacks: Array<{ id: string; token: string; body: unknown }> = [];
  /** Return a canned response for a call before the fake handles it. */
  hook?: (method: string, path: string, body?: unknown) => DiscordResponse | undefined;

  constructor(...channels: string[]) { for (const c of channels) this.channels.add(c); }

  /** A snowflake minted now (the fake's clock advances a millisecond each time). */
  nextId(): string {
    this.clock += 1;
    return ((BigInt(this.clock - DISCORD_EPOCH_MS) << 22n) | BigInt(++this.seq % 4096)).toString();
  }

  /** A message the person (or anyone) writes, as Discord stores it. */
  write(channel: string, content: string, author: FakeMessage["author"] = { id: "111111111111111111", username: "founder" }, extra: Partial<FakeMessage> = {}): FakeMessage {
    const m: FakeMessage = { id: this.nextId(), channel_id: channel, type: 0, content, author, attachments: [], ...extra };
    this.messages.set(m.id, m);
    return m;
  }

  inChannel(channel: string): FakeMessage[] {
    return [...this.messages.values()].filter((m) => m.channel_id === channel).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async request(method: string, path: string, body?: unknown, files?: DiscordFile[]): Promise<DiscordResponse> {
    this.calls.push({ method, path, body, files });
    const hooked = this.hook?.(method, path, body);
    if (hooked) return hooked;
    const url = new URL(`https://x${path}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const ok = (json: unknown, status = 200): DiscordResponse => ({ status, json });
    const err = (status: number, code: number, message: string): DiscordResponse => ({ status, json: { code, message }, code, error: message });
    const known = (c: string) => this.channels.has(c) || this.threads.has(c);

    if (method === "GET" && path === "/users/@me") return ok({ id: BOT_ID, username: "openrig", bot: true });
    if (method === "GET" && path === "/gateway/bot") return ok({ url: "wss://gateway.discord.gg" });
    if (parts[0] === "interactions" && method === "POST") {
      this.callbacks.push({ id: parts[1]!, token: parts[2]!, body });
      return { status: 204, json: {} };
    }
    if (parts[0] !== "channels") return err(404, 0, "404: Not Found");
    const channel = parts[1]!;
    if (parts.length === 2 && method === "GET") {
      if (this.threads.has(channel)) return ok({ id: channel, type: 11, parent_id: this.threads.get(channel) });
      return this.channels.has(channel) ? ok({ id: channel, type: 0, name: "openrig", guild_id: "800000000000000001" }) : err(404, 10003, "Unknown Channel");
    }
    if (!known(channel)) return err(404, 10003, "Unknown Channel");
    if (parts[2] !== "messages") return err(404, 0, "404: Not Found");
    if (parts.length === 3 && method === "POST") {
      const b = (body ?? {}) as { content?: string; components?: unknown[]; embeds?: unknown[] };
      const m: FakeMessage = { id: this.nextId(), channel_id: channel, type: 0, content: b.content ?? "", author: { id: BOT_ID, username: "openrig", bot: true },
        components: b.components ?? [], embeds: b.embeds ?? [],
        attachments: (files ?? []).map((f, i) => ({ id: `${i}`, filename: f.name, url: `https://cdn.discordapp.com/attachments/${channel}/${i}/${f.name}`, size: f.bytes.byteLength })) };
      this.messages.set(m.id, m);
      return ok(m);
    }
    if (parts.length === 3 && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      let list = this.inChannel(channel);
      if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before)).slice(-limit);
      else if (after) list = list.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
      else list = list.slice(-limit);
      return ok([...list].reverse()); // Discord pages newest first
    }
    const message = this.messages.get(parts[3]!);
    if (parts.length === 4 && method === "GET") return message && message.channel_id === channel ? ok(message) : err(404, 10008, "Unknown Message");
    if (parts.length === 4 && method === "PATCH") {
      if (!message) return err(404, 10008, "Unknown Message");
      Object.assign(message, body as object);
      return ok(message);
    }
    if (parts.length === 5 && parts[4] === "threads" && method === "POST") {
      if (!message || message.channel_id !== channel) return err(404, 10008, "Unknown Message");
      if (this.threads.has(message.id)) return err(400, 160004, "A thread has already been created for this message");
      this.threads.set(message.id, channel);
      message.thread = { id: message.id };
      return ok({ id: message.id, type: 11, parent_id: channel, name: (body as { name?: string })?.name });
    }
    return err(404, 0, "404: Not Found");
  }
}
