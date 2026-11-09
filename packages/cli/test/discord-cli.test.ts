// `rig discord`: setup writes the connector's own config and binds the person's Discord user id; enable/disable and
// post-open-asks go to the daemon's Discord routes. The real daemon surface, on a temporary home.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordCommand, type DiscordDeps } from "../src/commands/discord.js";
import { addHumanFragment } from "@openrig/daemon/gateway-human-registry";
import { loadDiscordConfig, showHuman } from "@openrig/daemon/gateway-discord";

const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })); process.exitCode = undefined; });

function fixture(people = 1) {
  const home = mkdtempSync(join(tmpdir(), "rig-discord-"));
  homes.push(home);
  for (let i = 0; i < people; i++) {
    addHumanFragment({ entityId: `person${i}`, class: "human", displayName: `P${i}`, address: `person${i}@external`,
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary", handle: `U${i}` }],
      prefs: { deliveryClass: "B" } }, home);
  }
  const logs: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const deps: DiscordDeps = {
    home, log: (m) => logs.push(m), env: {},
    clientFactory: () => ({ post: async <T>(path: string, body?: unknown) => { posts.push({ path, body }); return { status: 200, data: { ok: true, seeded: 1, onlineStatus: "discord connector enabled" } as T }; } }),
  };
  const run = (...argv: string[]) => discordCommand(deps).parseAsync(["node", "discord", ...argv]);
  return { home, logs, posts, run };
}

describe("rig discord", () => {
  it("setup writes the channel and binds the only person's Discord user id as their primary binding", async () => {
    const f = fixture();
    const secrets = join(f.home, "discord.env");
    writeFileSync(secrets, "DISCORD_BOT_TOKEN=x\n", { mode: 0o600 });
    await f.run("setup", "--channel", "700000000000000001", "--user", "111111111111111111", "--secrets-env-file", secrets);
    expect(process.exitCode).toBeUndefined();
    expect(loadDiscordConfig(f.home)).toMatchObject({ channel: "700000000000000001", secretsEnvFile: secrets, enabled: false });
    const shown = showHuman("person0", f.home);
    expect(shown.ok && shown.record.connectorBindings).toEqual([expect.objectContaining({ kind: "discord", role: "primary", handle: "111111111111111111" })]);
    expect(f.logs.join("\n")).toContain("bound person0 to Discord user 111111111111111111 (primary binding; was slack U0)");
  });

  it("setup refuses an id that isn't one, and asks which person when several are registered", async () => {
    const f = fixture(2);
    await f.run("setup", "--channel", "#general");
    expect(process.exitCode).toBe(1);
    expect(loadDiscordConfig(f.home).channel).toBeNull();
    process.exitCode = undefined;
    await f.run("setup", "--user", "111111111111111111");
    expect(process.exitCode).toBe(1);
    expect(f.logs.at(-1)).toContain("name one with --person");
    process.exitCode = undefined;
    await f.run("setup", "--user", "111111111111111111", "--person", "person1");
    expect(process.exitCode).toBeUndefined();
  });

  it("status names what's missing without the daemon", async () => {
    const f = fixture();
    await f.run("status");
    const out = f.logs.join("\n");
    expect(out).toContain("✗ bot-token");
    expect(out).toContain("✗ channel");
    expect(out).toContain("Message Content");
  });

  it("enable, disable and post-open-asks go to the daemon's Discord routes", async () => {
    const f = fixture();
    await f.run("enable");
    await f.run("disable", "--reason", "back to Slack");
    await f.run("post-open-asks", "--wait", "0");
    expect(f.posts.map((p) => p.path)).toEqual(["/api/gateway/discord/enable", "/api/gateway/discord/disable", "/api/gateway/discord/post-open-asks"]);
    expect(f.logs).toContain("To show the asks still open in Discord, run `rig discord post-open-asks`.");
  });
});
