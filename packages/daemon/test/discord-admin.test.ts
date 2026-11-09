// Turning the Discord connector on and off at the daemon door, choosing it over Slack, and a person's readiness on it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/domain/gateway/slack/config.js";
import { DISCORD_DEFAULT_CONFIG, loadDiscordConfig, saveDiscordConfig } from "../src/domain/gateway/discord/config.js";
import { activeChatConnector } from "../src/domain/gateway/chat-connector.js";
import { resolveHumanDeliveryReadiness } from "../src/domain/gateway/human-readiness.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { addHumanFragment, type HumanFragment } from "../src/domain/gateway/human-registry.js";

const homes: string[] = [];
const dbs: ReturnType<typeof createDb>[] = [];
afterEach(() => { dbs.splice(0).forEach((d) => d.close()); homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })); });

const person = (kind: "slack" | "discord", entityId = "alex"): HumanFragment => ({ entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind, connectorRef: "main", secretsRef: "env:pointer", role: "primary", handle: kind === "discord" ? "111111111111111111" : "U1" }],
  prefs: { deliveryClass: "B" } });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "discord-admin-"));
  homes.push(home);
  addHumanFragment(person("discord"), home);
  addHumanFragment(person("slack", "sam"), home);
  const secrets = join(home, "discord.env");
  writeFileSync(secrets, "DISCORD_BOT_TOKEN=fake\n", { mode: 0o600 });
  saveDiscordConfig({ ...DISCORD_DEFAULT_CONFIG, secretsEnvFile: secrets, channel: "700000000000000001" }, home);
  saveConfig({ ...DEFAULT_CONFIG, channel: "C1" }, home);
  const db = createDb(); dbs.push(db); migrate(db, ALL_MIGRATIONS);
  const queueRepo = new QueueRepository(db, new EventBus(db));
  const alert = (id: string, destination: string) => {
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body)
      VALUES (?, '2026-01-01', '2026-01-01', 'author@rig', ?, 'pending', 'backlog')`).run(id, destination);
    const r = db.prepare(`INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind)
      VALUES (?, '2026-01-01', 'pending', 'author@rig', 'ALERT', 'human-required')`).run(id);
    return `${id}:${r.lastInsertRowid}`;
  };
  const restart = vi.fn();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, queueRepo as never);
    c.set("gatewaySubsystem" as never, { restart, status: () => ({ state: "active" }) } as never);
    await next();
  });
  app.route("/", gatewayRoutes({ home }));
  const post = (path: string, body: object = {}) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator@rig" }, body: JSON.stringify(body) });
  return { home, post, restart, alert };
}

describe("the Discord connector at the daemon door", () => {
  it("enable seeds the Discord person's open backlog as history, turns Discord on and rewires the gateway to it", async () => {
    const f = fixture();
    const discordKey = f.alert("q-discord", "alex@external");
    const slackKey = f.alert("q-slack", "sam@external");
    const res = await f.post("/discord/enable");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seeded: 1 });
    const seen = [...new SeenStore(join(f.home, "state", "slack-outbound-seen.jsonl")).load()];
    expect(seen).toContain(discordKey);
    expect(seen).not.toContain(slackKey);
    expect(loadDiscordConfig(f.home).enabled).toBe(true);
    expect(f.restart).toHaveBeenCalledOnce();
    expect(activeChatConnector(f.home)).toMatchObject({ kind: "discord", botToken: "fake" });
  });

  it("only one chat connector runs: enabling Discord while Slack is on is refused, and the other way round", async () => {
    const f = fixture();
    saveConfig({ ...loadConfig(f.home), enabled: true }, f.home);
    const refused = await f.post("/discord/enable");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "other_connector_enabled" });
    expect(loadDiscordConfig(f.home).enabled).toBe(false);

    await f.post("/slack/disable", { reason: "moving to Discord" });
    expect((await f.post("/discord/enable")).status).toBe(200);
    expect((await f.post("/slack/enable")).status).toBe(409);
    expect((await f.post("/discord/disable", { reason: "test" })).status).toBe(200);
    expect(activeChatConnector(f.home).kind).toBe("slack");
  });

  it("refuses Slack-only features in its config", () => {
    const home = mkdtempSync(join(tmpdir(), "discord-cfg-"));
    homes.push(home);
    expect(() => saveDiscordConfig({ ...DISCORD_DEFAULT_CONFIG, botInbox: { channel: "1", destination: "x@y", bots: [] } } as never, home)).toThrow(/not supported on Discord: botInbox/);
  });
});

describe("a person's readiness on Discord", () => {
  const config = { ...DISCORD_DEFAULT_CONFIG, enabled: true, channel: "700000000000000001" };
  it("is ready when the bot can read the channel it posts to", async () => {
    const r = await resolveHumanDeliveryReadiness({ human: person("discord"), config, connectorKind: "discord", gatewayState: "active", botToken: "t" },
      { verifyDiscordChannel: async () => ({ ok: true }) });
    expect(r).toMatchObject({ state: "ready", ready: true, connector: { kind: "discord", ref: "main" } });
  });
  it("names the channel the bot can't read", async () => {
    const r = await resolveHumanDeliveryReadiness({ human: person("discord"), config, connectorKind: "discord", gatewayState: "active", botToken: "t" },
      { verifyDiscordChannel: async () => ({ ok: false, error: "no such channel" }) });
    expect(r).toMatchObject({ state: "not-ready", nextAction: "rig discord verify --json" });
    expect(r.reason).toContain("no such channel");
  });
  it("a Slack-bound person isn't reachable while this machine runs Discord", async () => {
    const r = await resolveHumanDeliveryReadiness({ human: person("slack"), config, connectorKind: "discord", gatewayState: "active", botToken: "t" });
    expect(r).toMatchObject({ state: "not-ready" });
    expect(r.reason).toContain("this machine runs discord");
  });
});
