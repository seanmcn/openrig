// The Discord connector end to end: the real queue, delivery rules, thread routing, Mission Control resolution and
// recovery, with Discord's REST API and Gateway in memory (issue #15's acceptance list).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { buildDiscordGatewayWire } from "../src/domain/gateway/discord/discord-subsystem.js";
import { DISCORD_DEFAULT_CONFIG, saveDiscordConfig } from "../src/domain/gateway/discord/config.js";
import { DISCORD_BUTTON_STYLE } from "../src/domain/gateway/discord/render.js";
import { DiscordIdMap } from "../src/domain/gateway/discord/discord-ids.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { BOT_ID, FakeDiscord, type FakeMessage } from "./helpers/fake-discord.js";

const CH = "700000000000000001";
const GUILD = "800000000000000001";
const PERSON = "111111111111111111";
const human = "human-founder@external";
const seat = "author@rig";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human,
  connectorBindings: [{ kind: "discord" as const, connectorRef: "primary", secretsRef: "env:DISCORD_BOT_TOKEN", role: "primary" as const, handle: PERSON }],
  prefs: { deliveryClass: "A" as const } }] };
const questions = [
  { id: "db", question: "Which database?", options: [{ id: "pg", label: "Postgres", recommended: true }, { id: "sqlite", label: "SQLite" }] },
  { id: "ship", question: "Ship this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
];

/** The underlying Gateway socket: it says HELLO and READY as Discord does, and records what the client sends. */
class GatewaySocket implements WsLike {
  sent: Array<{ op: number }> = [];
  onopen: WsLike["onopen"] = null; onmessage: WsLike["onmessage"] = null; onclose: WsLike["onclose"] = null; onerror: WsLike["onerror"] = null;
  private seq = 0;
  constructor() {
    queueMicrotask(() => {
      this.frame({ op: 10, d: { heartbeat_interval: 45_000 } });
      this.dispatch("READY", { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT_ID, username: "openrig" } });
      this.dispatch("GUILD_CREATE", { id: GUILD, channels: [{ id: CH, type: 0 }], threads: [] });
    });
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { /* the client ends it */ }
  frame(p: object) { this.onmessage?.({ data: JSON.stringify(p) }); }
  dispatch(t: string, d: object) { this.frame({ op: 0, t, s: ++this.seq, d }); }
}

describe("Discord connector at parity with Slack", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let contract: MissionControlWriteContract;
  let discord: FakeDiscord;
  let sockets: GatewaySocket[];
  let wire: ReturnType<typeof buildDiscordGatewayWire>;
  let logs: string[];

  const build = async () => {
    wire = buildDiscordGatewayWire({
      home, queueRepo: repo, rest: discord, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract, home),
      openSocket: () => { const s = new GatewaySocket(); sockets.push(s); return s; },
      log: (m) => logs.push(m),
    });
    const before = sockets.length;
    wire.startServices?.();
    await vi.waitFor(() => expect(sockets.length).toBe(before + 1));
    await vi.waitFor(() => expect(logs.some((l) => l.includes("discord gateway: ready"))).toBe(true));
  };
  const socket = () => sockets.at(-1)!;
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const rows = () => repo.list({ limit: 200 });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "discord-wire-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    const secrets = join(home, "discord.env");
    writeFileSync(secrets, "DISCORD_BOT_TOKEN=fake-discord-token\n", { mode: 0o600 });
    saveDiscordConfig({ ...DISCORD_DEFAULT_CONFIG, enabled: true, channel: CH, secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    discord = new FakeDiscord(CH);
    sockets = []; logs = [];
    await build();
  });
  afterEach(() => { wire.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  /** Post a row's owner notification the way the outbound sweep does, and wait for its receipt. */
  async function deliver(qitemId: string): Promise<void> {
    const pending = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId);
    const alert = await pending();
    if (!alert) throw new Error(`nothing to deliver for ${qitemId}`);
    wire.dispatcher.dispatch("post_message", human, alert);
    await vi.waitFor(async () => expect(await pending()).toBeUndefined());
  }
  const rootOf = (qitemId: string): FakeMessage => {
    const note = repo.transitionLog.listForQitem(qitemId).map((t) => t.transitionNote ?? "").find((n) => n.startsWith("slack-owner-notification-posted "))!;
    const ts = note.split(/\s+/).find((p) => p.startsWith("message_ts="))!.slice("message_ts=".length);
    // The receipt names the Slack-format ts the adapter minted; its persisted map names the Discord message.
    return discord.messages.get(new DiscordIdMap(join(home, "state", "discord-ids.jsonl")).snowflakeFor(ts)!)!;
  };
  const say = (channel: string, content: string, extra: Partial<FakeMessage> = {}, author: FakeMessage["author"] = { id: PERSON, username: "founder" }) => {
    const m = discord.write(channel, content, author, extra);
    socket().dispatch("MESSAGE_CREATE", { ...m, guild_id: GUILD });
    return m;
  };

  it("an ask posts as one root with a button row per question, the recommended one success-styled, the why in its thread, and an @-mention", async () => {
    const { qitemId } = await repo.create({ humanAlert: true, sourceSession: seat, destinationSession: human, summary: "Two quick questions",
      body: "Postgres keeps us on one database.", evidenceRef: "/proof.md", nudge: false, humanIntent: "decision", humanQuestions: questions });
    await deliver(qitemId);
    const root = rootOf(qitemId);
    expect(root.content).toContain(`<@${PERSON}>`);
    const rowsOf = root.components as Array<{ components: Array<{ label: string; style: number }> }>;
    expect(rowsOf.map((r) => r.components.map((b) => b.label))).toEqual([["Postgres (recommended)", "SQLite"], ["Yes", "No"]]);
    expect(rowsOf[0]!.components[0]!.style).toBe(DISCORD_BUTTON_STYLE.success);
    expect(discord.threads.get(root.id)).toBe(CH);
    expect(discord.inChannel(root.id).map((m) => m.content).join("\n")).toContain("Postgres keeps us on one database.");
    expect(root.content).not.toContain("Postgres keeps us");
  });

  it("button taps reach the seat that asked, and each is acknowledged to Discord", async () => {
    const { qitemId } = await repo.create({ humanAlert: true, sourceSession: seat, destinationSession: human, summary: "Two quick questions",
      body: "Pick one for each.", evidenceRef: "/proof.md", nudge: false, humanIntent: "decision", humanQuestions: questions });
    await deliver(qitemId);
    const root = rootOf(qitemId);
    let n = 0;
    const tap = async (q: string, o: string) => {
      socket().dispatch("INTERACTION_CREATE", { id: `92000000000000000${++n}`, token: `t${n}`, type: 3, guild_id: GUILD, channel_id: CH,
        data: { custom_id: `or-q:${q}|or-opt:${o}`, component_type: 2 }, message: { id: root.id }, member: { user: { id: PERSON } } });
      await vi.waitFor(() => expect(discord.callbacks.length).toBe(n));
    };
    await tap("db", "pg");
    await vi.waitFor(() => expect(repo.getById(qitemId)?.humanAnswers).toEqual({ db: "pg" }));
    await tap("ship", "yes");
    await vi.waitFor(() => expect(repo.getById(qitemId)).toMatchObject({ state: "done", humanAnswers: { db: "pg", ship: "yes" } }));
    expect(rows().some((q) => q.destinationSession === seat && q.sourceSession === human)).toBe(true);
    expect(discord.callbacks.every((c) => (c.body as { type: number }).type === 6)).toBe(true);
  });

  it("a reply in an ask's thread reaches the seat that asked", async () => {
    const { qitemId } = await repo.create({ humanAlert: true, sourceSession: seat, destinationSession: human, summary: "Which branch?",
      body: "I need to know where to release from.", evidenceRef: "/proof.md", nudge: false, humanIntent: "decision" });
    await deliver(qitemId);
    const root = rootOf(qitemId);
    say(root.id, "The release branch.");
    await vi.waitFor(() => expect(repo.getById(qitemId)?.state).toBe("done"));
    await vi.waitFor(() => expect(rows().some((q) => q.destinationSession === seat && (q.body ?? "").includes("The release branch."))).toBe(true));
  });

  it("a post outside any thread reaches the inbound destination (the kernel operator)", async () => {
    say(CH, "Can someone look at the build?");
    await vi.waitFor(() => expect(rows().some((q) => q.destinationSession === "operator-agent@kernel" && (q.body ?? "").includes("look at the build"))).toBe(true));
  });

  it("bot and webhook posts are ignored inbound", async () => {
    say(CH, "a bot speaking", {}, { id: "333333333333333333", username: "other-bot", bot: true });
    say(CH, "a webhook speaking", { webhook_id: "444444444444444444" }, { id: "444444444444444444", username: "hook" });
    say(CH, "and the person"); // proves the pipe is live
    await vi.waitFor(() => expect(rows().some((q) => (q.body ?? "").includes("and the person"))).toBe(true));
    expect(rows().some((q) => /a bot speaking|a webhook speaking/.test(q.body ?? ""))).toBe(false);
  });

  it("an update posts as one message, no buttons, and closes its row", async () => {
    const { qitemId } = await repo.create({ sourceSession: seat, destinationSession: human, summary: "Deployed",
      body: "v1.2 is live.", nudge: false, humanIntent: "update" });
    await deliver(qitemId);
    const root = rootOf(qitemId);
    expect(root.components ?? []).toEqual([]);
    expect(discord.threads.has(root.id)).toBe(false);
    expect(repo.getById(qitemId)?.state).toBe("done");
  });

  it("quiet hours hold a routine ask off Discord, as on Slack", async () => {
    const now = new Date();
    new HumanQuietStore(db).setUntil("human-founder", { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "test", now });
    const postsBefore = discord.calls.filter((c) => c.method === "POST").length;
    const { qitemId } = await repo.create({ humanAlert: true, sourceSession: seat, destinationSession: human, summary: "When convenient",
      body: "No rush.", evidenceRef: "/proof.md", nudge: false, humanIntent: "decision" });
    // A held ask stays an open alert until its window's release posts it, so this waits for the hold itself.
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId)!;
    wire.dispatcher.dispatch("post_message", human, alert);
    await vi.waitFor(() => expect(repo.transitionLog.listForQitem(qitemId).some((t) => (t.transitionNote ?? "").startsWith("delivery-decision: quiet-hold "))).toBe(true));
    expect(discord.calls.filter((c) => c.method === "POST").length).toBe(postsBefore);
  });

  it("a thread reply sent while the daemon was down is recovered after restart and reaches the asking seat", async () => {
    const { qitemId } = await repo.create({ humanAlert: true, sourceSession: seat, destinationSession: human, summary: "Which region?",
      body: "Pick a region to deploy to.", evidenceRef: "/proof.md", nudge: false, humanIntent: "decision" });
    await deliver(qitemId);
    const root = rootOf(qitemId);
    wire.stop(); // the daemon stops
    discord.write(root.id, "eu-west, please."); // the person replies; no Gateway event reaches anyone
    await flush();
    await build(); // the daemon starts again: recovery runs on connect
    await vi.waitFor(() => expect(rows().some((q) => q.destinationSession === seat && (q.body ?? "").includes("eu-west, please."))).toBe(true), { timeout: 5000 });
  });
});
