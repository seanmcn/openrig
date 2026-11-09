// Live checks against Discord for `rig discord verify` and a person's delivery readiness: the token works, the
// application is set up as the connector needs (Message Content intent on, no Interactions Endpoint URL), and the bot
// can read each channel it posts to.

import type { FetchImpl } from "../slack/slack-api.js";
import { createDiscordRest, type DiscordRest } from "./discord-rest.js";

/** Application flags: the Message Content intent, approved (verified apps) or limited (under 100 servers). */
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

export interface DiscordCheck { ok: boolean; label: string; detail: string }

const restFor = (token: string, fetchImpl?: FetchImpl): DiscordRest => createDiscordRest({ token, ...(fetchImpl ? { fetchImpl } : {}) });

/** The bot can read this channel (it exists, is in a server the bot is in, and the bot has View Channel). */
export async function verifyDiscordChannel(token: string, channel: string, rest: DiscordRest = restFor(token)): Promise<{ ok: boolean; error?: string; guildId?: string; name?: string }> {
  const r = await rest.request("GET", `/channels/${channel}`);
  if (r.status === 200) return { ok: true, guildId: r.json.guild_id, name: r.json.name };
  if (r.status === 401) return { ok: false, error: "the bot token was refused" };
  if (r.code === 10003) return { ok: false, error: "no such channel" };
  if (r.code === 50001) return { ok: false, error: "the bot can't see it (invite the bot, or give it View Channel)" };
  return { ok: false, error: r.error ?? `http ${r.status}` };
}

/** Everything `rig discord verify` checks, in order. A failed token check stops the rest. */
export async function verifyDiscord(input: { token: string; channels: string[]; userId?: string | null }, rest: DiscordRest = restFor(input.token)): Promise<DiscordCheck[]> {
  const checks: DiscordCheck[] = [];
  const me = await rest.request("GET", "/users/@me");
  if (me.status !== 200) {
    checks.push({ ok: false, label: "bot-token", detail: me.status === 401 ? "refused by Discord" : `couldn't check: ${me.error ?? me.status}` });
    return checks;
  }
  checks.push({ ok: true, label: "bot-token", detail: `accepted (bot ${me.json.username ?? me.json.id})` });
  const app = await rest.request("GET", "/applications/@me");
  if (app.status === 200) {
    const flags = Number(app.json.flags ?? 0);
    checks.push((flags & MESSAGE_CONTENT_FLAGS) !== 0
      ? { ok: true, label: "message-content-intent", detail: "enabled" }
      : { ok: false, label: "message-content-intent", detail: "off: turn on Message Content in the developer portal (Bot → Privileged Gateway Intents), or OpenRig can't read what the person writes" });
    const endpoint = typeof app.json.interactions_endpoint_url === "string" && app.json.interactions_endpoint_url ? app.json.interactions_endpoint_url : null;
    checks.push(endpoint
      ? { ok: false, label: "interactions-endpoint", detail: `set to ${endpoint}: clear it, or button taps go there instead of to OpenRig` }
      : { ok: true, label: "interactions-endpoint", detail: "none (button taps arrive on the Gateway)" });
  } else {
    checks.push({ ok: false, label: "application", detail: `couldn't read the application: ${app.error ?? app.status}` });
  }
  let guild: string | undefined;
  for (const channel of input.channels) {
    const c = await verifyDiscordChannel(input.token, channel, rest);
    checks.push(c.ok ? { ok: true, label: `channel ${channel}`, detail: `readable (#${c.name ?? channel})` } : { ok: false, label: `channel ${channel}`, detail: c.error ?? "not readable" });
    guild ??= c.guildId;
  }
  if (input.userId && guild) {
    const member = await rest.request("GET", `/guilds/${guild}/members/${input.userId}`);
    checks.push(member.status === 200
      ? { ok: true, label: "person", detail: `${input.userId} is a member of the server` }
      : { ok: false, label: "person", detail: `${input.userId} isn't a member of the channel's server (${member.error ?? member.status})` });
  }
  return checks;
}
