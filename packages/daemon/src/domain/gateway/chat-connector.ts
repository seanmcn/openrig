// Which chat connector this machine's gateway runs: Slack, or Discord in its place. One at a time (Discord replaces Slack;
// nothing posts to both), so every reader of "the connector's config and token" asks here instead of loading Slack's.
// Discord runs when its connector is enabled; otherwise Slack, enabled or not, as before.

import { loadConfig, type SlackConnectorConfig } from "./slack/config.js";
import { resolveSecret } from "./slack/secrets.js";
import { DISCORD_BOT_TOKEN, loadDiscordConfig } from "./discord/config.js";

export type ChatConnectorKind = "slack" | "discord";

export interface ActiveChatConnector {
  kind: ChatConnectorKind;
  config: SlackConnectorConfig;
  /** The bot token, resolved from the environment or the config's env file; null when unset. */
  botToken: string | null;
}

export function discordEnabled(home: string): boolean {
  try { return loadDiscordConfig(home).enabled; } catch { return false; }
}

export function activeChatConnector(home: string, env?: NodeJS.ProcessEnv): ActiveChatConnector {
  const kind: ChatConnectorKind = discordEnabled(home) ? "discord" : "slack";
  const config = kind === "discord" ? loadDiscordConfig(home) : loadConfig(home);
  const botToken = resolveSecret(kind === "discord" ? DISCORD_BOT_TOKEN : "SLACK_BOT_TOKEN", { envFile: config.secretsEnvFile ?? undefined, ...(env ? { env } : {}) });
  return { kind, config, botToken };
}
