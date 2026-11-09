// Discord message ids (snowflakes) as the Slack-format timestamps the gateway's chat logic keys on.
//
// The connector logic (thread map, receipts, recovery windows, reply ordering) treats a message's
// `ts` as both its identity and its time: `seconds.micros`, compared numerically, with recovery
// windows computed against the clock. A snowflake carries its own millisecond time, so its ts is
// that time, with the snowflake's low 22 bits scaled into the sub-millisecond digits (order is kept
// within a millisecond). Two snowflakes landing on the same ts take the next free microsecond. The
// pairing is recorded durably, so a message keeps one ts across restarts and a ts always maps back
// to the message it was minted for.

import fs from "node:fs";
import path from "node:path";
import { slackMicros, slackTimestamp } from "../slack/state-store.js";

export const DISCORD_EPOCH_MS = 1420070400000;

/** The Unix-epoch millisecond a snowflake was minted at. */
export function snowflakeMs(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

/** The smallest snowflake minted at `ms` (a paging bound: every message at or after `ms` sorts at or above it). */
export function snowflakeAt(ms: number): string {
  return (BigInt(Math.max(0, ms - DISCORD_EPOCH_MS)) << 22n).toString();
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{15,21}$/.test(value);
}

export class DiscordIdMap {
  private readonly bySnowflake = new Map<string, string>();
  private readonly byTs = new Map<string, string>();

  constructor(private readonly file: string) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const { s, t } = JSON.parse(line) as { s?: unknown; t?: unknown };
        if (typeof s === "string" && typeof t === "string" && !this.bySnowflake.has(s) && !this.byTs.has(t)) {
          this.bySnowflake.set(s, t);
          this.byTs.set(t, s);
        }
      } catch { /* a torn last line: the pairing is minted again on next sight */ }
    }
  }

  /** The ts for a Discord id, minted and recorded on first sight. */
  tsFor(id: string): string {
    const known = this.bySnowflake.get(id);
    if (known) return known;
    const ms = BigInt(snowflakeMs(id));
    const low = BigInt(id) & 0x3fffffn;
    let micros = ms * 1000n + (low * 1000n) / 0x400000n;
    while (this.byTs.has(slackTimestamp(micros))) micros += 1n;
    const ts = slackTimestamp(micros);
    this.bySnowflake.set(id, ts);
    this.byTs.set(ts, id);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ s: id, t: ts }) + "\n");
    } catch { /* in memory for this run; a later run mints the same ts unless a same-millisecond neighbour took it */ }
    return ts;
  }

  /** The Discord id a ts was minted for, or null when this map never minted it. */
  snowflakeFor(ts: string): string | null {
    return this.byTs.get(ts) ?? null;
  }

  /** A paging bound for a ts that may never have been minted (a recovery window edge). */
  static boundFor(ts: string): string {
    const micros = slackMicros(ts);
    return snowflakeAt(micros === null ? 0 : Number(micros / 1000n));
  }
}
