// `rig discord` — the Discord connector's configuration and subsystem admin, the counterpart of `rig slack`.
//
// The Discord connector replaces Slack on a machine (one chat connector at a time): the same in-daemon gateway, with
// Discord's REST API and Gateway behind it. Configuration lives in `discord-connector.json`; the one secret, the bot
// token, lives in a 0600 env file or the environment (DISCORD_BOT_TOKEN), never in the config.
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
import { describeOpenAsks, socketDeliveryLines, type InboundDeliveryStatus } from "./slack.js";

type DiscordSurface = typeof import("@openrig/daemon/gateway-discord");
type DiscordConfig = import("@openrig/daemon/gateway-discord").DiscordConnectorConfig;

export interface DiscordDeps {
  home?: string;
  log?: (msg: string) => void;
  /** Injectable daemon-surface loader (tests). Default: lazy import of the narrow subpath. */
  surface?: () => Promise<DiscordSurface>;
  clientFactory?: () => Pick<DaemonClient, "post"> & Partial<Pick<DaemonClient, "get">>;
  env?: NodeJS.ProcessEnv;
}

const SNOWFLAKE = /^\d{15,21}$/;

const FIRST_STEPS = [
  "Create an application at https://discord.com/developers/applications, add a bot, and copy its token.",
  "Under Bot → Privileged Gateway Intents, turn on Message Content. Leave General Information → Interactions Endpoint URL empty, so button taps arrive over the Gateway.",
  "Invite the bot to your private server with View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History and Attach Files.",
  "Turn on Developer Mode (User Settings → Advanced) to copy the channel id and your own user id.",
].join("\n  ");

/** The person whose primary binding becomes the Discord one: the one named, or the only person registered. */
function choosePerson(surface: DiscordSurface, named: string | undefined, home?: string): { ok: true; entityId: string } | { ok: false; error: string } {
  if (named) return { ok: true, entityId: named };
  const listed = surface.listHumans(home);
  if (!listed.ok) return { ok: false, error: listed.error };
  if (listed.humans.length === 1) return { ok: true, entityId: listed.humans[0]!.entityId };
  return { ok: false, error: listed.humans.length === 0
    ? "no person is registered yet: register them first (rig gateway human add <entityId> --display-name … --binding discord:main:env:DISCORD_BOT_TOKEN:primary:handle=<your Discord user id> --delivery-class …)"
    : `several people are registered (${listed.humans.map((h) => h.entityId).join(", ")}): name one with --person` };
}

export function discordCommand(deps: DiscordDeps = {}): Command {
  const log = deps.log ?? ((m: string) => console.log(m));
  const loadSurface = deps.surface ?? (async () => (await import("@openrig/daemon/gateway-discord")) as DiscordSurface);
  const clientFactory = deps.clientFactory ?? (() => new DaemonClient());
  const actorOf = (opts: { actor?: string }) => resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK;

  const cmd = new Command("discord").description("Discord connector: configuration + in-daemon subsystem admin (replaces Slack on this machine)");

  cmd
    .command("setup")
    .description("Configure the connector and bind the person's Discord user id (secrets stay in the env file, never here)")
    .option("--channel <id>", "Discord channel id the bot posts to (in your private server)")
    .option("--user <id>", "your Discord user id: becomes the person's primary binding, so OpenRig @-mentions you and knows your posts")
    .option("--person <entityId>", "the registered person to bind (default: the only person registered)")
    .option("--inbound-destination <session>", "where a post outside any thread lands (default operator-agent@kernel)")
    .option("--minimum-level-that-posts <level>", "minimum OWNER level posted: RECORD|NOTICE|ALERT")
    .option("--minimum-level-that-interrupts <level>", "minimum OWNER level that @-mentions: RECORD|NOTICE|ALERT")
    .option("--source-label <label>", "label shown on posts (where the queue lives)")
    .option("--secrets-env-file <path>", "path to the 0600 env file with DISCORD_BOT_TOKEN")
    .option("--reactions <mode>", "a person's emoji reaction on an OpenRig post: route (default) makes a row for the seat that asked; off ignores it")
    .option("--reason <reason>", "Reason recorded with the configuration change", "configure human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      const surface = await loadSurface();
      for (const [flag, value] of [["--channel", opts.channel], ["--user", opts.user]] as const) {
        if (value !== undefined && !SNOWFLAKE.test(String(value))) {
          log(`✗ ${flag} takes a Discord id (digits only, from Developer Mode → Copy ID), not ${JSON.stringify(value)}`);
          process.exitCode = 1;
          return;
        }
      }
      const cur = surface.loadDiscordConfig(deps.home);
      const next: DiscordConfig = {
        ...cur,
        channel: opts.channel ?? cur.channel,
        inboundDestination: opts.inboundDestination ?? cur.inboundDestination,
        minimumLevelThatPosts: opts.minimumLevelThatPosts ?? cur.minimumLevelThatPosts,
        minimumLevelThatInterrupts: opts.minimumLevelThatInterrupts ?? cur.minimumLevelThatInterrupts,
        sourceLabel: opts.sourceLabel ?? cur.sourceLabel,
        secretsEnvFile: opts.secretsEnvFile ?? cur.secretsEnvFile,
        ...(opts.reactions !== undefined ? { reactions: opts.reactions } : {}),
      };
      const result = await surface.runChannelOperation({
        actor: actorOf(opts), provenance: "claimed:v1",
        reason: opts.reason, action: "configure", subject: "discord", before: { digest: surface.channelStateDigest(cur) },
        run: async () => ({ value: surface.saveDiscordConfig(next, deps.home), after: { digest: surface.channelStateDigest(next) },
          effect: surface.channelStateDigest(cur) === surface.channelStateDigest(next) ? "no-op" : "applied" }),
      }, deps.home);
      log(`wrote ${result.value}; receipt ${result.receipt.id} (${result.receipt.effect})`);

      if (opts.user !== undefined) {
        const who = choosePerson(surface, opts.person, deps.home);
        if (!who.ok) { log(`✗ person not bound: ${who.error}`); process.exitCode = 1; return; }
        const shown = surface.showHuman(who.entityId, deps.home);
        if (!shown.ok) { log(`✗ person not bound: ${shown.error}`); process.exitCode = 1; return; }
        const bindings = shown.record.connectorBindings;
        const slot = bindings.findIndex((b) => b.role === "primary");
        const spec = `discord:main:env:DISCORD_BOT_TOKEN:primary:handle=${opts.user}`;
        if (slot < 0) {
          log(`✗ ${who.entityId} has no primary binding to replace: rig gateway human set ${who.entityId} binding.0 "${spec}" after adding one, or re-add them with --binding "${spec}"`);
          process.exitCode = 1;
          return;
        }
        const set = surface.setHumanField(who.entityId, `binding.${slot}`, spec, deps.home);
        if (!set.ok) { log(`✗ person not bound: ${set.error}`); process.exitCode = 1; return; }
        const previous = bindings[slot]!;
        log(`bound ${who.entityId} to Discord user ${opts.user} (primary binding; was ${previous.kind}${previous.handle ? ` ${previous.handle}` : ""})`);
      }
      log(`Next: put DISCORD_BOT_TOKEN in ${next.secretsEnvFile ?? "<--secrets-env-file> (0600)"}, then \`rig discord verify\`, then \`rig discord enable\` (after \`rig slack disable\` if Slack is on).`);
    });

  cmd
    .command("status")
    .description("Show local configuration and the daemon's connector observations (no Discord calls)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadDiscordConfig(deps.home);
      const token = surface.resolveDiscordToken(cfg, deps.env);
      const readiness = surface.discordStaticReadiness(cfg, token !== null);
      const permWarn = cfg.secretsEnvFile ? surface.checkEnvFilePermissions(cfg.secretsEnvFile) : null;
      let observation: Record<string, unknown> = { state: "unknown", reason: "daemon-unavailable" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const client = deps.clientFactory?.() ?? new DaemonClient(undefined, { timeoutMs: 900 });
        const response = await Promise.race([
          client.get?.<Record<string, unknown>>("/api/gateway/discord/status", { timeoutMs: 900 }),
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); }),
        ]);
        if (response?.status === 200 && response.data && typeof response.data.state === "string") observation = response.data;
      } catch { /* local configuration stays useful without the daemon */ }
      finally { if (timer) clearTimeout(timer); }
      if (opts.json) {
        log(JSON.stringify({ config: cfg, readiness, permWarning: permWarn, observation }));
        return;
      }
      log(`discord-connector configuration checks (config: ${cfg.enabled ? "enabled" : "disabled"}; delivery runs in-daemon)`);
      for (const r of readiness) log(`  ${r.ok ? "✓" : "✗"} ${r.label}: ${r.detail}`);
      log(`Daemon: ${observation.state}${observation.reason ? ` (${observation.reason})` : ""}`);
      const connector = observation.connector as { platform?: string; outboundReady?: boolean; inboundReady?: boolean;
        inbound?: InboundDeliveryStatus & { state?: string; generation?: number; lastEventAt?: string };
        recovery?: { state?: string; reason?: string; lastScanAt?: string };
        deadLetterBacklog?: number | null; deadLetterBacklogState?: string } | null | undefined;
      if (connector) {
        if (connector.platform && connector.platform !== "discord") log(`  The daemon is running the ${connector.platform} connector, not Discord.`);
        log(`  Outbound: ${connector.outboundReady ? "ready" : "not ready"}; inbound: ${connector.inboundReady ? "ready" : "not ready"}`);
        log(`  Gateway: ${connector.inbound?.state ?? "unknown"}; generation ${connector.inbound?.generation ?? "unknown"}; last event ${connector.inbound?.lastEventAt ?? "unknown"}`);
        for (const line of socketDeliveryLines(connector.inbound)) log(`  ${line}`);
        log(`  Recovery: ${connector.recovery?.state ?? "unknown"}${connector.recovery?.reason ? ` (${connector.recovery.reason})` : ""}; last scan ${connector.recovery?.lastScanAt ?? "unknown"}`);
        if (connector.deadLetterBacklogState !== undefined) log(`  Inbound dead-letter backlog: ${connector.deadLetterBacklog ?? "unknown"}`);
      }
      if (permWarn) log(`  ⚠ ${permWarn}`);
      if (readiness.some((r) => !r.ok)) log(`  First steps:\n  ${FIRST_STEPS}`);
    });

  cmd
    .command("verify")
    .description("Live-check the bot token, the application's Message Content intent and Interactions Endpoint URL, each channel, and the bound person")
    .option("--person <entityId>", "the registered person whose Discord binding to check (default: the only person registered)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadDiscordConfig(deps.home);
      const token = surface.resolveDiscordToken(cfg, deps.env);
      if (!token) {
        log("✗ bot token unresolved — set DISCORD_BOT_TOKEN (env or secrets env file). Cannot verify.");
        process.exitCode = 1;
        return;
      }
      let userId: string | null = null;
      const who = choosePerson(surface, opts.person, deps.home);
      if (who.ok) {
        const shown = surface.showHuman(who.entityId, deps.home);
        const binding = shown.ok ? shown.record.connectorBindings.find((b) => b.role === "primary") : undefined;
        if (binding?.kind === "discord" && binding.handle) userId = binding.handle;
      }
      const checks = await surface.verifyDiscord({ token, channels: surface.mappedChannels(cfg).map((c) => c.channel), userId });
      if (!cfg.channel) checks.push({ ok: false, label: "channel", detail: "not configured — rig discord setup --channel <id>" });
      if (!userId) checks.push({ ok: false, label: "person", detail: who.ok ? `${who.entityId}'s primary binding isn't Discord — rig discord setup --user <id>` : who.error });
      const ready = checks.every((c) => c.ok);
      if (opts.json) { log(JSON.stringify({ checks, ready })); }
      else {
        for (const c of checks) log(`${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
        log(ready ? "READY" : "NOT ready");
      }
      if (!ready) process.exitCode = 1;
    });

  const admin = (operation: "enable" | "disable") => async (opts: { reason?: string; actor?: string }) => {
    try {
      const res = await clientFactory().post<{ ok: boolean; seeded?: number; onlineStatus?: string; message?: string }>(`/api/gateway/discord/${operation}`, { reason: opts.reason, actor: actorOf(opts) });
      if (res.status !== 200 || res.data.ok !== true) throw new Error(res.data.message ?? `daemon refused ${operation} (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
      log(res.data.onlineStatus ?? `discord connector ${operation}d`);
      if (operation === "enable" && (res.data.seeded ?? 0) > 0) log("To show the asks still open in Discord, run `rig discord post-open-asks`.");
    } catch (e) {
      log(`✗ ${operation} failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  };
  cmd
    .command("enable")
    .description("Enable the connector (the daemon seeds the current backlog as history, then rewires the gateway to Discord)")
    .option("--reason <reason>", "Reason recorded with the change", "enable human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(admin("enable"));
  cmd
    .command("disable")
    .description("Disable the connector (the daemon rewires to Slack's connector, inert unless Slack is enabled)")
    .requiredOption("--reason <reason>", "Why human delivery is being shut down (recorded in the lifecycle receipt)")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(admin("disable"));

  cmd
    .command("post-open-asks")
    .description("Show in Discord the asks still open that enable marked as seen, through ordinary delivery, and say what became of each")
    .option("--reason <reason>", "Reason recorded with the action")
    .option("--wait <seconds>", "How long to wait for receipts before reporting the rest as queued (0-60)", "10")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "Print the daemon's result as JSON")
    .action(async (opts) => {
      try {
        const waitSeconds = Number(opts.wait);
        if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) throw new Error(`--wait takes 0 to 60 seconds, not ${opts.wait}`);
        const res = await clientFactory().post<{ ok: boolean; asks: Parameters<typeof describeOpenAsks>[0]; message?: string }>("/api/gateway/discord/post-open-asks",
          { reason: opts.reason, waitSeconds, actor: actorOf(opts) }, { timeoutMs: (waitSeconds + 30) * 1000 });
        if (res.status !== 200 || res.data.ok !== true) throw new Error(res.data.message ?? `daemon refused (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
        if (opts.json) { log(JSON.stringify(res.data, null, 2)); return; }
        for (const line of describeOpenAsks(res.data.asks)) log(line);
      } catch (e) {
        log(`✗ post-open-asks failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
