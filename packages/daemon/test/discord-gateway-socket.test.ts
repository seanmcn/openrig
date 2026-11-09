// The Discord Gateway behind the Socket Mode socket the inbound loop reads: session handling and event translation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { createDiscordSocketFactory, GATEWAY_INTENTS } from "../src/domain/gateway/discord/gateway-socket.js";
import { DiscordIdMap } from "../src/domain/gateway/discord/discord-ids.js";
import { DiscordChannels } from "../src/domain/gateway/discord/discord-rest.js";
import { BOT_ID, FakeDiscord } from "./helpers/fake-discord.js";

const CH = "700000000000000001";
const GUILD = "800000000000000001";
const PERSON = "111111111111111111";

class Underlying implements WsLike {
  sent: Array<{ op: number; d?: any }> = [];
  closedWith: number | undefined;
  onopen: WsLike["onopen"] = null; onmessage: WsLike["onmessage"] = null; onclose: WsLike["onclose"] = null; onerror: WsLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number) { this.closedWith = code; }
  frame(p: object) { this.onmessage?.({ data: JSON.stringify(p) }); }
  dispatch(t: string, d: object, s = 1) { this.frame({ op: 0, t, s, d }); }
}

describe("the Discord Gateway as a Socket Mode socket", () => {
  let dir: string;
  let discord: FakeDiscord;
  let ids: DiscordIdMap;
  let sockets: Underlying[];
  let logs: string[];
  let factory: ReturnType<typeof createDiscordSocketFactory>;
  let envelopes: any[];
  let opened: number;
  let closes: number;

  const connect = (url = "wss://gateway.discord.gg/?v=10&encoding=json") => {
    const facing = factory(url);
    facing.onopen = () => { opened++; };
    facing.onmessage = (m) => envelopes.push(JSON.parse(String(m.data)));
    facing.onclose = () => { closes++; };
    return { facing, ws: sockets.at(-1)! };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dgw-"));
    discord = new FakeDiscord(CH);
    ids = new DiscordIdMap(join(dir, "ids.jsonl"));
    sockets = []; logs = []; envelopes = []; opened = 0; closes = 0;
    factory = createDiscordSocketFactory({ token: "tok", rest: discord, ids, channels: new DiscordChannels(discord), log: (m) => logs.push(m),
      openSocket: (url) => { const s = new Underlying(url); sockets.push(s); return s; } });
  });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  it("identifies with the intents the connector needs and opens on READY", () => {
    const { ws } = connect();
    ws.frame({ op: 10, d: { heartbeat_interval: 45000 } });
    const identify = ws.sent.find((p) => p.op === 2)!;
    expect(identify.d.token).toBe("tok");
    for (const intent of Object.values(GATEWAY_INTENTS)) expect(identify.d.intents & intent).toBe(intent);
    expect(opened).toBe(0);
    ws.dispatch("READY", { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT_ID, username: "openrig" } });
    expect(opened).toBe(1);
    expect(envelopes[0]).toMatchObject({ type: "hello" });
  });

  it("a person's post in the channel is a message event; bot and webhook posts carry bot_id", async () => {
    const { ws } = connect();
    ws.dispatch("GUILD_CREATE", { channels: [{ id: CH, type: 0 }], threads: [] });
    const id = discord.nextId();
    ws.dispatch("MESSAGE_CREATE", { id, guild_id: GUILD, channel_id: CH, type: 0, content: "hello", author: { id: PERSON } });
    ws.dispatch("MESSAGE_CREATE", { id: discord.nextId(), guild_id: GUILD, channel_id: CH, type: 0, content: "ours", author: { id: BOT_ID, bot: true } });
    ws.dispatch("MESSAGE_CREATE", { id: discord.nextId(), guild_id: GUILD, channel_id: CH, type: 0, content: "hook", author: { id: "3" }, webhook_id: "555" });
    await flush();
    const events = envelopes.filter((e) => e.type === "events_api").map((e) => e.payload.event);
    expect(events[0]).toMatchObject({ type: "message", channel: CH, user: PERSON, text: "hello", ts: ids.tsFor(id) });
    expect(events[0].bot_id).toBeUndefined();
    expect(events[0].thread_ts).toBeUndefined();
    expect(events[1].bot_id).toBe(BOT_ID);
    expect(events[2].bot_id).toBe("555");
  });

  it("a reply in a thread names the parent channel and the thread's root", async () => {
    const { ws } = connect();
    const root = discord.write(CH, "ask");
    ws.dispatch("THREAD_CREATE", { id: root.id, type: 11, parent_id: CH });
    ws.dispatch("MESSAGE_CREATE", { id: discord.nextId(), guild_id: GUILD, channel_id: root.id, type: 0, content: "yes", author: { id: PERSON } });
    await flush();
    expect(envelopes.at(-1).payload.event).toMatchObject({ channel: CH, thread_ts: ids.tsFor(root.id), text: "yes" });
  });

  it("a thread it hasn't seen is looked up before the reply is passed on", async () => {
    const { ws } = connect();
    const root = discord.write(CH, "ask");
    discord.threads.set(root.id, CH);
    ws.dispatch("MESSAGE_CREATE", { id: discord.nextId(), guild_id: GUILD, channel_id: root.id, type: 0, content: "yes", author: { id: PERSON } });
    await vi.waitFor(() => expect(envelopes.at(-1)?.payload?.event).toMatchObject({ channel: CH, thread_ts: ids.tsFor(root.id) }));
  });

  it("a button press is a block_actions envelope, answered to Discord as it arrives, ahead of slower events", async () => {
    const { ws } = connect();
    const msg = discord.write(CH, "ask", { id: BOT_ID, username: "openrig", bot: true });
    // An earlier event in an unknown thread needs a lookup first; the press behind it is still answered at once.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const slowLookup = discord.request.bind(discord);
    discord.request = async (method, path, ...rest) => { if (path === "/channels/555555555555555555") await held; return slowLookup(method, path, ...rest); };
    ws.dispatch("MESSAGE_CREATE", { id: discord.nextId(), guild_id: GUILD, channel_id: "555555555555555555", type: 0, content: "x", author: { id: PERSON } });
    ws.dispatch("INTERACTION_CREATE", { id: "910000000000000001", token: "itok", type: 3, guild_id: GUILD, channel_id: CH,
      data: { custom_id: "or-q:ship|or-opt:yes", component_type: 2 }, message: { id: msg.id }, member: { user: { id: PERSON } } });
    await flush();
    expect(discord.callbacks).toEqual([{ id: "910000000000000001", token: "itok", body: { type: 6 } }]);
    release();
    await vi.waitFor(() => expect(envelopes.some((e) => e.type === "interactive")).toBe(true));
    expect(envelopes.find((e) => e.type === "interactive")).toMatchObject({ payload: { type: "block_actions", user: { id: PERSON }, channel: { id: CH },
      container: { message_ts: ids.tsFor(msg.id), channel_id: CH }, actions: [{ block_id: "or-q:ship", action_id: "or-opt:yes", value: "yes" }] } });
  });

  it("a missed heartbeat ack closes the connection, and the next one resumes the session", () => {
    vi.useFakeTimers();
    const { ws } = connect();
    ws.frame({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.dispatch("READY", { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT_ID } }, 41);
    vi.advanceTimersByTime(1000); // first beat (jittered inside the interval)
    expect(ws.sent.some((p) => p.op === 1)).toBe(true);
    vi.advanceTimersByTime(1000); // no ack came
    expect(closes).toBe(1);
    expect(ws.closedWith).toBe(4000);
    const next = connect().ws;
    expect(next.url.startsWith("wss://resume.discord.gg/")).toBe(true);
    next.frame({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(next.sent.find((p) => p.op === 6)).toEqual({ op: 6, d: { token: "tok", session_id: "s1", seq: 41 } });
  });

  it("an invalid session that can't resume identifies again", () => {
    const { ws } = connect();
    ws.frame({ op: 10, d: { heartbeat_interval: 45000 } });
    ws.dispatch("READY", { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT_ID } });
    ws.frame({ op: 9, d: false });
    expect(closes).toBe(1);
    const next = connect().ws;
    next.frame({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(next.sent.some((p) => p.op === 2)).toBe(true);
    expect(next.sent.some((p) => p.op === 6)).toBe(false);
  });

  it("a refused privileged intent is named, and the loop is told to stop rather than identify again", () => {
    const { ws } = connect();
    ws.onclose?.({ code: 4014 });
    expect(logs.some((l) => l.includes("Message Content"))).toBe(true);
    expect(envelopes.at(-1)).toEqual({ type: "disconnect", reason: "link_disabled" });
    expect(closes).toBe(1);
  });

  it("an ordinary drop is a plain close the loop reconnects from", () => {
    const { ws } = connect();
    ws.onclose?.({ code: 1006 });
    expect(envelopes.some((e) => e.type === "disconnect")).toBe(false);
    expect(closes).toBe(1);
  });
});
