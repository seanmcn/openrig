import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordIdMap, snowflakeAt, snowflakeMs } from "../src/domain/gateway/discord/discord-ids.js";
import { slackMicros } from "../src/domain/gateway/slack/state-store.js";

// 2024-01-01T00:00:00.000Z as a Discord snowflake: (ms - 1420070400000) << 22.
const JAN_2024_MS = 1704067200000;
const snow = (ms: number, low = 0) => ((BigInt(ms - 1420070400000) << 22n) | BigInt(low)).toString();

describe("Discord snowflake ↔ Slack-format ts", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
  const fresh = () => { dir = mkdtempSync(join(tmpdir(), "dids-")); return new DiscordIdMap(join(dir, "ids.jsonl")); };

  it("reads a snowflake's time and builds the smallest snowflake at a time", () => {
    expect(snowflakeMs(snow(JAN_2024_MS, 12345))).toBe(JAN_2024_MS);
    expect(snowflakeAt(JAN_2024_MS)).toBe(snow(JAN_2024_MS));
  });

  it("gives a message a ts carrying its own time, and maps it back", () => {
    const ids = fresh();
    const id = snow(JAN_2024_MS + 1500, 7);
    const ts = ids.tsFor(id);
    expect(slackMicros(ts)! / 1000n).toBe(BigInt(JAN_2024_MS + 1500));
    expect(ids.snowflakeFor(ts)).toBe(id);
    expect(ids.tsFor(id)).toBe(ts); // stable
  });

  it("keeps two messages in the same millisecond apart, in snowflake order", () => {
    const ids = fresh();
    const a = ids.tsFor(snow(JAN_2024_MS, 1));
    const b = ids.tsFor(snow(JAN_2024_MS, 2));
    expect(a).not.toBe(b);
    expect(slackMicros(a)! < slackMicros(b)!).toBe(true);
  });

  it("survives a restart: a reloaded map gives the same ts both ways", () => {
    const ids = fresh();
    const id = snow(JAN_2024_MS, 3);
    const ts = ids.tsFor(id);
    const reloaded = new DiscordIdMap(join(dir!, "ids.jsonl"));
    expect(reloaded.snowflakeFor(ts)).toBe(id);
    expect(reloaded.tsFor(id)).toBe(ts);
  });

  it("knows nothing of a ts it never minted", () => {
    expect(fresh().snowflakeFor("1704067200.000000")).toBeNull();
  });
});
