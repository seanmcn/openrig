// The Discord connector's configuration: its own file, `discord-connector.json`, in the Slack connector's schema (the
// same delivery dials, inbound destination, channel and optional channel map), with one secret, the bot token, from the
// environment or a 0600 env file, never from the config file.
//
// One Discord bot connection does both directions, so the bot token is the only credential (Slack needs a second,
// app-level token for Socket Mode). Slack-only features are not offered: the named-bot inbox and forwarding a shared
// app's channels between machines. A config naming them is refused on save and reported (and ignored) when read.

import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";
import { DEFAULT_CONFIG, loadConfigAt, saveConfigAt, type ReadinessItem, type SlackConnectorConfig } from "../slack/config.js";
import { resolveSecret } from "../slack/secrets.js";

export type DiscordConnectorConfig = SlackConnectorConfig;

export const DISCORD_BOT_TOKEN = "DISCORD_BOT_TOKEN";
export const DISCORD_DEFAULT_CONFIG: DiscordConnectorConfig = { ...DEFAULT_CONFIG, requiredScopes: [] };

export function discordConfigPath(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "discord-connector.json");
}

/** Fields of the shared schema that Discord doesn't offer. */
export function unsupportedOnDiscord(cfg: Partial<DiscordConnectorConfig>): string[] {
  return [cfg.botInbox !== undefined ? "botInbox" : null, cfg.forwardChannels !== undefined ? "forwardChannels" : null].filter((f): f is string => f !== null);
}

/** Read the config; a missing file is the honest unconfigured default. Slack-only fields are dropped. */
export function loadDiscordConfig(home?: string): DiscordConnectorConfig {
  const { botInbox: _b, forwardChannels: _f, ...cfg } = loadConfigAt(discordConfigPath(home));
  return { ...cfg, requiredScopes: [] };
}

export function saveDiscordConfig(cfg: DiscordConnectorConfig, home?: string): string {
  const unsupported = unsupportedOnDiscord(cfg);
  if (unsupported.length) throw new Error(`not supported on Discord: ${unsupported.join(", ")}`);
  return saveConfigAt({ ...cfg, requiredScopes: [] }, discordConfigPath(home));
}

export function resolveDiscordToken(cfg: DiscordConnectorConfig, env?: NodeJS.ProcessEnv): string | null {
  return resolveSecret(DISCORD_BOT_TOKEN, { envFile: cfg.secretsEnvFile ?? undefined, ...(env ? { env } : {}) });
}

/** What's set and what's missing, without touching the network (`rig discord verify` checks Discord itself). */
export function discordStaticReadiness(cfg: DiscordConnectorConfig, hasBotToken: boolean, raw?: Partial<DiscordConnectorConfig>): ReadinessItem[] {
  const unsupported = raw ? unsupportedOnDiscord(raw) : [];
  return [
    { ok: cfg.secretsEnvFile !== null || hasBotToken, label: "secrets-source", detail: cfg.secretsEnvFile ? `env file ${cfg.secretsEnvFile}` : "env vars only" },
    { ok: hasBotToken, label: "bot-token", detail: hasBotToken ? "resolved" : `unset (${DISCORD_BOT_TOKEN}: the connector can neither post nor receive)` },
    { ok: cfg.channel !== null, label: "channel", detail: cfg.channel ?? "unset (outbound cannot post)" },
    { ok: Boolean(cfg.inboundDestination), label: "inbound-destination", detail: cfg.inboundDestination },
    { ok: cfg.enabled, label: "enabled", detail: cfg.enabled ? "yes" : "no (run `rig discord enable`)" },
    ...(cfg.channelMap?.length ? [{ ok: true, label: "channel-map", detail: `${cfg.channelMap.length} entr${cfg.channelMap.length === 1 ? "y" : "ies"}` }] : []),
    ...(unsupported.length ? [{ ok: false, label: "unsupported", detail: `ignored, not offered on Discord: ${unsupported.join(", ")}` }] : []),
  ];
}
