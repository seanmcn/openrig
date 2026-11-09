// The Discord connector's inbound half: the Discord Gateway (WebSocket v10, JSON), behind the Socket Mode socket the
// gateway's inbound loop (slack/socket-inbound.ts) already drives.
//
// The loop asks for a connection URL (the shim answers apps.connections.open with the Gateway URL), opens a socket with
// a factory, and reads Socket Mode envelopes from it, acking each by envelope id. This module is that factory for
// Discord. Each socket it returns:
// - owns the Gateway session: heartbeats at Discord's interval, IDENTIFYs with the intents the connector needs, and
//   RESUMEs a session a dropped connection left (the session outlives one socket, so a reconnect replays what was missed);
// - reports open only once Discord says READY or RESUMED, so a refused identify ends in the loop's open timeout and retry;
// - closes itself on a missed heartbeat ack (a zombie connection), on Discord's RECONNECT and on an invalid session, and
//   the loop's reconnect resumes;
// - turns MESSAGE_CREATE and MESSAGE_REACTION_ADD into `events_api` envelopes and a button press (INTERACTION_CREATE) into
//   an `interactive` block_actions envelope; acking a button's envelope answers Discord's interaction (deferred update),
//   inside Discord's three seconds, as the loop acks first.
//
// Interactions only arrive on the Gateway when the application has no Interactions Endpoint URL. Reading what the person
// writes needs the Message Content privileged intent, turned on in the developer portal.

import type { WsLike } from "../slack/socket-inbound.js";
import type { DiscordIdMap } from "./discord-ids.js";
import type { DiscordChannels, DiscordRest } from "./discord-rest.js";
import { toSlackMessage, type DiscordMessage, type DiscordPostedStore } from "./slack-api-shim.js";

export const GATEWAY_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  MESSAGE_CONTENT: 1 << 15,
} as const;
export const CONNECTOR_INTENTS = Object.values(GATEWAY_INTENTS).reduce((a, b) => a | b, 0);

/** Close codes after which the same token and intents will be refused again: named in the log, not silently retried. */
const FATAL_CLOSE: Record<number, string> = {
  4004: "the bot token was refused (DISCORD_BOT_TOKEN)",
  4010: "invalid shard", 4011: "sharding required",
  4012: "invalid API version",
  4013: "invalid intents",
  4014: "a privileged intent is not enabled: turn on Message Content in the Discord developer portal (Bot → Privileged Gateway Intents)",
};
/** Close codes after which the session can't be resumed. */
const SESSION_LOST = new Set([4007, 4009]);
/** Our own close: keeps the session resumable (1000/1001 would end it). */
const RESUMABLE_CLOSE = 4000;

interface Session { id?: string; seq: number | null; resumeUrl?: string; botUserId?: string }

export interface DiscordSocketDeps {
  token: string;
  rest: DiscordRest;
  ids: DiscordIdMap;
  channels: DiscordChannels;
  posted?: DiscordPostedStore;
  /** The underlying WebSocket (default: the global WebSocket). */
  openSocket?: (url: string) => WsLike;
  intents?: number;
  log?: (msg: string) => void;
}

export interface DiscordSocketFactory {
  (url: string): WsLike;
  /** The session the next socket resumes, if any (status, tests). */
  session(): Readonly<Session>;
}

type Payload = { op: number; d?: any; s?: number | null; t?: string | null };

export function createDiscordSocketFactory(deps: DiscordSocketDeps): DiscordSocketFactory {
  const log = deps.log ?? (() => {});
  const session: Session = { seq: null };
  const openSocket = deps.openSocket ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));

  const factory = ((url: string): WsLike => {
    const resuming = Boolean(session.id && session.resumeUrl);
    const target = resuming ? `${session.resumeUrl!.replace(/\/?$/, "/")}?v=10&encoding=json` : url;
    const ws = openSocket(target);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let firstBeat: ReturnType<typeof setTimeout> | undefined;
    let acked = true;
    let closed = false;
    let ready = false;
    /** envelope id → the interaction it answers. */
    const interactions = new Map<string, { id: string; token: string }>();
    /** Events are translated in order (a thread's parent may need a lookup first). */
    let chain: Promise<void> = Promise.resolve();

    const facing: WsLike = {
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send(data: string) {
        let envelopeId: string | undefined;
        try { envelopeId = (JSON.parse(data) as { envelope_id?: string }).envelope_id; } catch { return; }
        const interaction = envelopeId ? interactions.get(envelopeId) : undefined;
        if (!interaction) return; // a message event needs no ack on Discord
        interactions.delete(envelopeId!);
        // Type 6: deferred update. The click is acknowledged and the message stays as it is; what the click did is posted
        // in the thread by the inbound router, as on Slack.
        void deps.rest.request("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 6 })
          .then((r) => { if (r.status >= 300) log(`discord: interaction ${interaction.id} ack failed: ${r.error ?? r.status}`); });
      },
      close() { shut(RESUMABLE_CLOSE); },
    };

    const send = (payload: Payload) => { try { ws.send(JSON.stringify(payload)); } catch { /* closing */ } };
    const beat = () => {
      if (!acked) {
        log("discord gateway: heartbeat not acknowledged; reconnecting (zombie connection)");
        return shut(RESUMABLE_CLOSE);
      }
      acked = false;
      send({ op: 1, d: session.seq });
    };
    const stopBeating = () => { if (heartbeat) clearInterval(heartbeat); if (firstBeat) clearTimeout(firstBeat); heartbeat = firstBeat = undefined; };
    function shut(code: number): void {
      if (closed) return;
      closed = true;
      stopBeating();
      try { (ws as WsLike & { close(code?: number): void }).close(code); } catch { /* already closed */ }
      facing.onclose?.();
    }
    const emit = (envelope: Record<string, unknown>) => facing.onmessage?.({ data: JSON.stringify(envelope) });
    let envelopes = 0;
    const envelopeId = () => `discord-${Date.now()}-${++envelopes}`;

    const onMessageCreate = async (m: DiscordMessage & { guild_id?: string }) => {
      if (!m.guild_id) return; // direct messages are not the connector's channel
      const parent = await deps.channels.parentOf(String(m.channel_id));
      const event = parent
        ? { ...toSlackMessage(m, deps.ids, { threadTs: deps.ids.tsFor(String(m.channel_id)), posted: deps.posted }), channel: parent }
        : { ...toSlackMessage(m, deps.ids, { posted: deps.posted }), channel: m.channel_id };
      emit({ envelope_id: envelopeId(), type: "events_api", payload: { event } });
    };
    const onReaction = async (d: { user_id?: string; channel_id?: string; message_id?: string; guild_id?: string; emoji?: { name?: string }; member?: { user?: { bot?: boolean } } }) => {
      if (!d.guild_id || !d.channel_id || !d.message_id) return;
      const parent = await deps.channels.parentOf(d.channel_id);
      const ts = deps.ids.tsFor(d.message_id);
      emit({ envelope_id: envelopeId(), type: "events_api", payload: { event: {
        type: "reaction_added", user: d.user_id, reaction: d.emoji?.name ?? "", event_ts: ts,
        ...(d.member?.user?.bot || d.user_id === session.botUserId ? { bot_id: d.user_id } : {}),
        item: { type: "message", channel: parent ?? d.channel_id, ts },
      } } });
    };
    const onInteraction = async (d: { id: string; token: string; type: number; channel_id?: string; data?: { custom_id?: string }; message?: { id: string }; member?: { user?: { id?: string } }; user?: { id?: string } }) => {
      if (d.type !== 3 || !d.message || !d.channel_id) return; // only button presses on our messages
      const [blockId, actionId] = String(d.data?.custom_id ?? "").split("|");
      if (!blockId || !actionId) return;
      const parent = await deps.channels.parentOf(d.channel_id);
      const channel = parent ?? d.channel_id;
      const ts = deps.ids.tsFor(d.message.id);
      const threadTs = parent ? deps.ids.tsFor(d.channel_id) : undefined;
      const id = envelopeId();
      interactions.set(id, { id: d.id, token: d.token });
      emit({ envelope_id: id, type: "interactive", payload: {
        type: "block_actions",
        user: { id: d.member?.user?.id ?? d.user?.id },
        channel: { id: channel },
        container: { message_ts: ts, channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
        message: { ts, ...(threadTs ? { thread_ts: threadTs } : {}) },
        actions: [{ block_id: blockId, action_id: actionId, value: actionId.replace(/^or-opt:/, ""), action_ts: deps.ids.tsFor(d.id) }],
      } });
    };

    const dispatch = (t: string, d: any) => {
      switch (t) {
        case "READY":
          session.id = d.session_id; session.resumeUrl = d.resume_gateway_url; session.botUserId = d.user?.id;
          ready = true; facing.onopen?.();
          emit({ type: "hello", num_connections: 1 });
          log(`discord gateway: ready as ${d.user?.username ?? "bot"}`);
          return;
        case "RESUMED":
          ready = true; facing.onopen?.();
          emit({ type: "hello", num_connections: 1 });
          log("discord gateway: session resumed");
          return;
        case "GUILD_CREATE":
          for (const c of [...(d.channels ?? []), ...(d.threads ?? [])]) deps.channels.note(c);
          return;
        case "THREAD_CREATE": case "THREAD_UPDATE": case "CHANNEL_CREATE": case "CHANNEL_UPDATE":
          deps.channels.note(d);
          return;
        case "THREAD_LIST_SYNC":
          for (const c of d.threads ?? []) deps.channels.note(c);
          return;
        case "MESSAGE_CREATE": chain = chain.then(() => onMessageCreate(d)).catch((e) => log(`discord: message not delivered inbound: ${(e as Error).message}`)); return;
        case "MESSAGE_REACTION_ADD": chain = chain.then(() => onReaction(d)).catch((e) => log(`discord: reaction not delivered inbound: ${(e as Error).message}`)); return;
        case "INTERACTION_CREATE": chain = chain.then(() => onInteraction(d)).catch((e) => log(`discord: click not delivered inbound: ${(e as Error).message}`)); return;
        default: return;
      }
    };

    ws.onmessage = (ev) => {
      let p: Payload;
      try { p = JSON.parse(String(ev.data)) as Payload; } catch { return; }
      if (typeof p.s === "number") session.seq = p.s;
      switch (p.op) {
        case 10: { // HELLO
          const interval = Number(p.d?.heartbeat_interval) || 41_250;
          firstBeat = setTimeout(() => { beat(); heartbeat = setInterval(beat, interval); }, Math.floor(interval * Math.random()));
          if (resuming) send({ op: 6, d: { token: deps.token, session_id: session.id, seq: session.seq } });
          else send({ op: 2, d: { token: deps.token, intents: deps.intents ?? CONNECTOR_INTENTS, properties: { os: process.platform, browser: "openrig", device: "openrig" } } });
          return;
        }
        case 11: acked = true; return; // HEARTBEAT_ACK
        case 1: send({ op: 1, d: session.seq }); return; // the Gateway asks for a heartbeat now
        case 7: log("discord gateway: asked to reconnect"); return shut(RESUMABLE_CLOSE);
        case 9: // INVALID_SESSION: d says whether it can be resumed
          if (!p.d) { session.id = undefined; session.resumeUrl = undefined; session.seq = null; }
          log(`discord gateway: invalid session (${p.d ? "resumable" : "identifying again"})`);
          return shut(RESUMABLE_CLOSE);
        case 0: if (p.t) dispatch(p.t, p.d); return;
        default: return;
      }
    };
    ws.onclose = (ev?: unknown) => {
      const code = Number((ev as { code?: unknown } | undefined)?.code);
      if (FATAL_CLOSE[code]) log(`discord gateway: closed ${code}: ${FATAL_CLOSE[code]}`);
      if (SESSION_LOST.has(code)) { session.id = undefined; session.resumeUrl = undefined; session.seq = null; }
      if (closed) return;
      closed = true;
      stopBeating();
      facing.onclose?.();
    };
    ws.onerror = (ev) => {
      // Before READY the loop's open timeout owns the retry; after it, an error ends this connection.
      if (!ready) return facing.onerror?.(ev);
      shut(RESUMABLE_CLOSE);
    };
    return facing;
  }) as DiscordSocketFactory;
  factory.session = () => ({ ...session });
  return factory;
}
