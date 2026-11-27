// Discord's REST rate limits as the connector owns them: a short spent window waits, a long one is handed back as a 429
// without calling Discord, a global limit holds every route, and Discord's own 429 is passed back, never retried here.
import { describe, expect, it } from "vitest";
import { createDiscordRest } from "../src/domain/gateway/discord/discord-rest.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function rig(replies: Reply[]) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const waits: number[] = [];
  const rest = createDiscordRest({
    token: "secret-token",
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method} ${url.replace("https://discord.com/api/v10", "")}`);
      const r = replies.shift() ?? {};
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
    },
  });
  return { rest, calls, waits, advance: (ms: number) => { clock += ms; } };
}

const spent = (resetAfter: number, bucket = "b1") => ({ "x-ratelimit-bucket": bucket, "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": String(resetAfter) });

describe("Discord REST rate limits", () => {
  it("a spent bucket with a short reset waits, then sends", async () => {
    const t = rig([{ headers: spent(1.5) }, {}]);
    await t.rest.request("POST", "/channels/700000000000000001/messages", { content: "a" });
    const r = await t.rest.request("POST", "/channels/700000000000000001/messages", { content: "b" });
    expect(r.status).toBe(200);
    expect(t.waits).toEqual([1500]);
    expect(t.calls).toHaveLength(2);
  });

  it("a spent bucket with a long reset is a 429 back to the caller, and Discord isn't called", async () => {
    const t = rig([{ headers: spent(30) }]);
    await t.rest.request("POST", "/channels/700000000000000001/messages", { content: "a" });
    const r = await t.rest.request("POST", "/channels/700000000000000001/messages", { content: "b" });
    expect(r).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(t.calls).toHaveLength(1);
    // Another channel is another bucket (the channel id is the major parameter).
    expect((await t.rest.request("POST", "/channels/700000000000000002/messages", { content: "c" })).status).toBe(200);
  });

  it("Discord's 429 is passed back with its retry-after, and a global one holds every route", async () => {
    const t = rig([{ status: 429, body: { retry_after: 12.3, global: true, message: "You are being rate limited." } }]);
    const r = await t.rest.request("GET", "/channels/700000000000000001/messages");
    expect(r).toMatchObject({ status: 429, retryAfterSeconds: 13 });
    const other = await t.rest.request("GET", "/users/@me");
    expect(other).toMatchObject({ status: 429 });
    expect(t.calls).toHaveLength(1);
    t.advance(13_000);
    expect((await t.rest.request("GET", "/users/@me")).status).toBe(200);
  });

  it("a transport failure never carries the token", async () => {
    const rest = createDiscordRest({ token: "secret-token", fetchImpl: async () => { throw new TypeError("Headers.append: \"Bot secret-token\" is an invalid header value."); } });
    const r = await rest.request("GET", "/users/@me");
    expect(r.status).toBe(0);
    expect(JSON.stringify(r)).not.toContain("secret-token");
  });

  it("names Discord's error code", async () => {
    const t = rig([{ status: 404, body: { code: 10003, message: "Unknown Channel" } }]);
    expect(await t.rest.request("GET", "/channels/1")).toMatchObject({ status: 404, code: 10003, error: "Unknown Channel" });
  });
});
