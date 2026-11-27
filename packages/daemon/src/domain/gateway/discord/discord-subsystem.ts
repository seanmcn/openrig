// The Discord gateway wire: the Slack connector's wire (slack/slack-subsystem.ts) with Discord behind its two
// transport seams. Every rule above the transport is the Slack connector's own: delivery classes, modes and quiet
// windows, digests and deferrals, receipts, thread routing (a click or a thread reply reaches the seat that asked; a
// post outside a thread reaches the inbound destination), missed-reply recovery for 7 days, and ask settlement.
//
// What Discord brings: its config file and bot token (discord/config.ts), the REST API behind the Web API calls
// (slack-api-shim.ts), the Gateway behind the Socket Mode socket (gateway-socket.ts), people registered with a
// `discord` binding whose handle is their Discord user id, and attachments fetched from Discord's CDN.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GatewayWire } from "../gateway-subsystem.js";
import type { FetchImpl } from "../slack/slack-api.js";
import { INBOUND_FILE_MAX_BYTES } from "../slack/slack-api.js";
import type { WsLike } from "../slack/socket-inbound.js";
import type { InboundFilePort, StoredInboundFile, FailedInboundFile } from "../slack/inbound.js";
import { buildSlackGatewayWire, type SlackWireOpts } from "../slack/slack-subsystem.js";
import { DISCORD_BOT_TOKEN, loadDiscordConfig, resolveDiscordToken } from "./config.js";
import { DiscordIdMap } from "./discord-ids.js";
import { DiscordChannels, createDiscordRest, type DiscordRest } from "./discord-rest.js";
import { createSlackApiShim, DiscordPostedStore } from "./slack-api-shim.js";
import { createDiscordSocketFactory } from "./gateway-socket.js";

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function isDiscordCdn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && DISCORD_CDN_HOSTS.has(u.hostname);
  } catch { return false; }
}

/** Attachments a person posts: fetched from Discord's CDN (signed URLs, no token sent), bounded, stored locally. */
export function makeDiscordInboundFilePort(opts: { mediaDir: string; fetchImpl?: FetchImpl; maxBytes?: number; log?: (m: string) => void }): InboundFilePort {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const maxBytes = opts.maxBytes ?? INBOUND_FILE_MAX_BYTES;
  return {
    async transfer(files, eventTs, eventChannel) {
      const stored: StoredInboundFile[] = [];
      const failed: FailedInboundFile[] = [];
      fs.mkdirSync(opts.mediaDir, { recursive: true });
      for (let i = 0; i < files.length; i++) {
        const meta = (files[i] ?? {}) as { id?: string; name?: string; mimetype?: string; url_private?: string; size?: number };
        const name = String(meta.name ?? meta.id ?? `file-${i + 1}`);
        if (!meta.url_private || !isDiscordCdn(meta.url_private)) { failed.push({ name, error: "missing or non-Discord attachment url" }); continue; }
        if (typeof meta.size === "number" && meta.size > maxBytes) { failed.push({ name, error: `file is ${meta.size} bytes (limit ${maxBytes})` }); continue; }
        let bytes: Uint8Array;
        try {
          const res = await fetchImpl(meta.url_private, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) { failed.push({ name, error: `download ${res.status}` }); continue; }
          bytes = new Uint8Array(await res.arrayBuffer());
        } catch (e) {
          failed.push({ name, error: `download failed: ${(e as Error).name}` });
          continue;
        }
        if (bytes.byteLength > maxBytes) { failed.push({ name, error: `file is ${bytes.byteLength} bytes (limit ${maxBytes})` }); continue; }
        const safeBase = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || `file-${i + 1}`;
        const identity = createHash("sha256").update(JSON.stringify([eventChannel ?? "-", eventTs, meta.id ?? null])).digest("hex").slice(0, 20);
        const localPath = path.join(opts.mediaDir, `${eventTs.replace(/[^0-9.]/g, "")}-${identity}-${i + 1}-${safeBase}`);
        if (!path.resolve(localPath).startsWith(path.resolve(opts.mediaDir) + path.sep)) { failed.push({ name, error: "unsafe path refused" }); continue; }
        try { fs.writeFileSync(localPath, bytes); } catch (e) { failed.push({ name, error: `local write failed: ${(e as Error).message}` }); continue; }
        stored.push({ name, localPath, mimetype: meta.mimetype, bytes: bytes.byteLength });
      }
      return { stored, failed };
    },
  };
}

export interface DiscordWireOpts extends Omit<SlackWireOpts, "platform" | "fetchImpl" | "wsFactory"> {
  /** Test seams: the REST API, the underlying WebSocket, and the CDN fetch. */
  rest?: DiscordRest;
  openSocket?: (url: string) => WsLike;
  cdnFetch?: FetchImpl;
  env?: NodeJS.ProcessEnv;
}

/** Build the Discord gateway wire from `discord-connector.json` and DISCORD_BOT_TOKEN. Never throws on missing
 *  configuration: the Slack wire's honest inert wire, named for Discord. */
export function buildDiscordGatewayWire(opts: DiscordWireOpts): GatewayWire {
  const config = loadDiscordConfig(opts.home);
  const token = resolveDiscordToken(config, opts.env);
  const state = path.join(opts.home, "state");
  const rest = opts.rest ?? createDiscordRest({ token: token ?? "", userAgentVersion: process.env.npm_package_version });
  const ids = new DiscordIdMap(path.join(state, "discord-ids.jsonl"));
  const channels = new DiscordChannels(rest);
  const posted = new DiscordPostedStore(path.join(state, "discord-posted-asks.jsonl"));
  const fetchImpl = createSlackApiShim({ rest, ids, channels, posted, log: opts.log }, opts.cdnFetch);
  const wsFactory = createDiscordSocketFactory({ token: token ?? "", rest, ids, channels, posted, openSocket: opts.openSocket, log: opts.log });
  return buildSlackGatewayWire({
    ...opts,
    platform: {
      name: "discord",
      config,
      botToken: token,
      appToken: token,
      tokenName: DISCORD_BOT_TOKEN,
      fetchImpl,
      wsFactory,
      bindingKind: "discord",
      inboundFiles: (mediaDir) => makeDiscordInboundFilePort({ mediaDir, fetchImpl: opts.cdnFetch, log: opts.log }),
    },
  });
}
