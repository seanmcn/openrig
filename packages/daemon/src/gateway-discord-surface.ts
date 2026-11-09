// The narrow @openrig/daemon/gateway-discord surface: what `rig discord setup/status/verify` read and write. Same
// dep-rail pattern as gateway-slack: the CLI lazy-imports this at invocation; nothing else is exported.

export {
  loadDiscordConfig,
  saveDiscordConfig,
  discordConfigPath,
  discordStaticReadiness,
  resolveDiscordToken,
  unsupportedOnDiscord,
  DISCORD_DEFAULT_CONFIG,
  DISCORD_BOT_TOKEN,
  type DiscordConnectorConfig,
} from "./domain/gateway/discord/config.js";
export { verifyDiscord, type DiscordCheck } from "./domain/gateway/discord/verify.js";
export { checkEnvFilePermissions } from "./domain/gateway/slack/secrets.js";
export { mappedChannels } from "./domain/gateway/slack/channel-map.js";
export { runChannelOperation, channelStateDigest } from "./domain/gateway/channel-operations.js";
export { listHumans, showHuman, setHumanField } from "./domain/gateway/human-registry.js";
