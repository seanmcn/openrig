// seanmcn/openrig#16: Claude and Codex usage is read one request at a time from the Claude transcript JSONL and the
// Codex rollout, incrementally, each request counted once. Fixture lines are shaped like Claude Code 2.1 transcripts
// and Codex rollouts (token_usage_record + token_count, and the older token_count-only form).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { UsageRequestStore } from "../src/domain/usage-request-store.js";
import { UsageRequestIngestor } from "../src/domain/usage-request-ingest.js";

let db: Database.Database;
let dir: string;
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
  dir = mkdtempSync(nodePath.join(tmpdir(), "usage-ingest-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const claudeLine = (requestId: string, ts: string, content: unknown[], usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: `${requestId}-${ts}`, timestamp: ts, requestId,
  sessionId: "claude-native-1", cwd: "/w/app", version: "2.1.300",
  message: { model: "claude-opus-5-5", id: `msg_${requestId}`, type: "message", role: "assistant", content,
    usage: { input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 9000, output_tokens: 1,
      output_tokens_details: { thinking_tokens: 0 }, ...usage } },
  ...extra,
});

describe("Claude transcript", () => {
  it("records each request once by its request id, across streamed lines and ticks, with the paths its tool calls touched", () => {
    const file = nodePath.join(dir, "claude-native-1.jsonl");
    writeFileSync(file, jsonl([
      { type: "user", timestamp: "2026-11-09T10:00:00.000Z", message: { role: "user", content: "go" } },
      claudeLine("req_A", "2026-11-09T10:00:01.000Z", [{ type: "thinking", thinking: "", signature: "" }], {}),
      claudeLine("req_A", "2026-11-09T10:00:02.000Z", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/app/src/a.ts" } }], {}),
      claudeLine("req_A", "2026-11-09T10:00:03.000Z", [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x", path: "lib" } }],
        { output_tokens: 120, output_tokens_details: { thinking_tokens: 40 } }),
    ]));
    const store = new UsageRequestStore(db);
    const ingestor = new UsageRequestIngestor(db, store);
    const target = { runtime: "claude-code" as const, transcriptPath: file, seatSession: "impl@demo", nodeId: null, nativeSessionId: "claude-native-1" };
    ingestor.ingest(target, "2026-11-09T10:01:00.000Z");

    // A half-written line isn't read until it's complete.
    appendFileSync(file, JSON.stringify(claudeLine("req_B", "2026-11-09T10:00:10.000Z",
      [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git -C /w/lib status && cat notes.txt" } }], { output_tokens: 7 }, { costUSD: 0.042 })).slice(0, 40));
    ingestor.ingest(target, "2026-11-09T10:01:30.000Z");
    expect(store.list({})).toHaveLength(1);

    writeFileSync(file, jsonl([
      { type: "user", timestamp: "2026-11-09T10:00:00.000Z", message: { role: "user", content: "go" } },
      claudeLine("req_A", "2026-11-09T10:00:01.000Z", [{ type: "thinking", thinking: "", signature: "" }], {}),
      claudeLine("req_A", "2026-11-09T10:00:02.000Z", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/app/src/a.ts" } }], {}),
      claudeLine("req_A", "2026-11-09T10:00:03.000Z", [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x", path: "lib" } }],
        { output_tokens: 120, output_tokens_details: { thinking_tokens: 40 } }),
      claudeLine("req_B", "2026-11-09T10:00:10.000Z",
        [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git -C /w/lib status && cat notes.txt" } }], { output_tokens: 7 }, { costUSD: 0.042 }),
      claudeLine("req_C", "2026-11-09T10:00:20.000Z", [{ type: "text", text: "done" }], { output_tokens: 3 }),
    ]));
    ingestor.ingest(target, "2026-11-09T10:02:00.000Z");
    ingestor.ingest(target, "2026-11-09T10:02:30.000Z");

    const rows = store.list({});
    expect(rows.map((r) => r.requestKey)).toEqual(["req_A", "req_B", "req_C"]);
    expect(rows[0]).toMatchObject({
      runtime: "claude-code", seatSession: "impl@demo", nativeSessionId: "claude-native-1", requestTs: "2026-11-09T10:00:01.000Z",
      model: "claude-opus-5-5", tokens: { input: 3, output: 120, cacheRead: 9000, cacheWrite: 200, reasoning: 40 },
      cost: { usd: null, provenance: "unavailable" }, paths: ["/w/app/lib", "/w/app/src/a.ts"],
    });
    expect(rows[1]).toMatchObject({ cost: { usd: 0.042, provenance: "runtime_estimate" }, paths: ["/w/app", "/w/lib"] });
    expect(rows[2]!.paths).toEqual([]);
  });

  it("skips synthetic and API-error lines, which are not model requests", () => {
    const file = nodePath.join(dir, "s.jsonl");
    writeFileSync(file, jsonl([
      { ...claudeLine("req_X", "2026-11-09T10:00:01.000Z", [{ type: "text", text: "err" }], {}), isApiErrorMessage: true },
      { ...claudeLine("", "2026-11-09T10:00:02.000Z", [{ type: "text", text: "no response" }], {}),
        message: { model: "<synthetic>", id: "m", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
    ]));
    const store = new UsageRequestStore(db);
    new UsageRequestIngestor(db, store).ingest({ runtime: "claude-code", transcriptPath: file, seatSession: "s", nodeId: null, nativeSessionId: "n" }, "2026-11-09T10:01:00.000Z");
    expect(store.list({})).toEqual([]);
  });
});

describe("Codex rollout", () => {
  const ts = (s: number) => `2026-11-09T11:00:${String(s).padStart(2, "0")}.000Z`;
  const usage = (input: number, cached: number, output: number, reasoning: number) => ({
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output,
    reasoning_output_tokens: reasoning, total_tokens: input + output,
  });
  const tokenCount = (s: number, total: number) => ({ timestamp: ts(s), type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: { ...usage(total - 10, 0, 10, 0) }, last_token_usage: usage(90, 50, 10, 4), model_context_window: 200000 } } });

  it("records one request per token_usage_record, keyed by response id, with the tool calls made since the last one and no cost", () => {
    const file = nodePath.join(dir, "rollout-1.jsonl");
    writeFileSync(file, jsonl([
      { timestamp: ts(0), type: "session_meta", payload: { id: "thread-1", cwd: "/w/app" } },
      { timestamp: ts(1), type: "turn_context", payload: { cwd: "/w/app", model: "gpt-6" } },
      { timestamp: ts(2), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1",
        input: "text(await tools.exec_command({cmd:\"sed -n 1,20p /w/app/src/b.ts\"}));" } },
      { timestamp: ts(3), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c2",
        arguments: JSON.stringify({ cmd: "npm test", workdir: "/w/lib" }) } },
      { timestamp: ts(4), type: "token_usage_record", payload: { thread_id: "thread-1", response_id: "resp_1", usage: usage(1000, 800, 50, 20) } },
      tokenCount(5, 1050),
      { timestamp: ts(6), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c3",
        input: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** End Patch\n" } },
      { timestamp: ts(7), type: "token_usage_record", payload: { thread_id: "thread-1", response_id: "resp_2", usage: usage(1200, 1000, 30, 0) } },
      tokenCount(8, 2280),
      { timestamp: ts(9), type: "token_usage_record", payload: { thread_id: "thread-1", response_id: "resp_3", usage: usage(1300, 1200, 5, 0) } },
    ]));
    const store = new UsageRequestStore(db);
    const ingestor = new UsageRequestIngestor(db, store);
    const target = { runtime: "codex" as const, transcriptPath: file, seatSession: "cx@demo", nodeId: null, nativeSessionId: "thread-1" };
    ingestor.ingest(target, ts(30));
    ingestor.ingest(target, ts(40));
    const rows = store.list({});
    expect(rows.map((r) => [r.requestKey, r.requestTs, r.paths])).toEqual([
      ["resp_1", ts(4), ["/w/app/src/b.ts", "/w/lib"]],
      ["resp_2", ts(7), ["/w/app/src/c.ts"]],
      ["resp_3", ts(9), []],
    ]);
    expect(rows[0]).toMatchObject({ runtime: "codex", model: "gpt-6", tokens: { input: 200, cacheRead: 800, cacheWrite: 0, output: 50, reasoning: 20 },
      cost: { usd: null, provenance: "unavailable" } });
  });

  it("falls back to token_count events, keyed by the cumulative total, when the rollout has no usage records", () => {
    const file = nodePath.join(dir, "rollout-old.jsonl");
    writeFileSync(file, jsonl([
      { timestamp: ts(1), type: "turn_context", payload: { cwd: "/w/app", model: "gpt-5" } },
      tokenCount(2, 100),
      tokenCount(3, 100), // a repeat of the same request
      { timestamp: ts(4), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 3 } } } },
      tokenCount(5, 250),
    ]));
    const store = new UsageRequestStore(db);
    new UsageRequestIngestor(db, store).ingest({ runtime: "codex", transcriptPath: file, seatSession: "cx", nodeId: null, nativeSessionId: "t" }, ts(30));
    expect(store.list({}).map((r) => [r.requestKey, r.tokens.input, r.tokens.cacheRead])).toEqual([["total:100", 40, 50], ["total:250", 40, 50]]);
  });
});

describe("Pi entries", () => {
  it("mirrors the seat's own persisted entries (not a fork's inherited ones) and takes OpenRouter's charge as the cost once recorded", async () => {
    const { PiUsageEntriesStore } = await import("../src/domain/pi-usage-entries-store.js");
    const pi = new PiUsageEntriesStore(db);
    const fact = (entryId: string, origin: "own" | "inherited" | "unknown", costTotal: number | null) => ({
      entryId, entryTimestamp: "2026-11-09T12:00:00.000Z", kind: "assistant" as const, origin, input: 100, output: 20,
      parentEntryId: null, usageCategory: null, provider: "openrouter", model: "m-1", cacheRead: 5, cacheWrite: 1,
      costTotal, stopReason: "stop", api: "openai-completions", responseId: `gen-${entryId}`,
    });
    const seat = { seatSession: "pi@demo", nodeId: null, generation: null, piSessionId: "pi-1" };
    pi.record({ ...seat, facts: [fact("e1", "own", 0.01), fact("e2", "inherited", 0.5), fact("e3", "unknown", null)] }, "2026-11-09T12:01:00.000Z");
    // A replay that settles the unknown origin to own brings that entry in.
    pi.record({ ...seat, facts: [fact("e3", "own", null)] }, "2026-11-09T12:02:00.000Z");
    pi.recordCharges({ seatSession: "pi@demo", piSessionId: "pi-1", charges: [{ entryId: "e1", generationId: "gen-e1", status: "charged",
      totalCostUsd: 0.012, credentialSource: "openrig", upstreamInferenceCostUsd: null, cacheDiscountUsd: null, isByok: false,
      providerName: null, model: null, apiType: null, workspaceId: null, generationCreatedAt: null, reason: null }] }, "2026-11-09T12:03:00.000Z");
    const rows = new UsageRequestStore(db).list({});
    expect(rows.map((r) => [r.runtime, r.nativeSessionId, r.requestKey, r.cost])).toEqual([
      ["pi", "pi-1", "e1", { usd: 0.012, provenance: "provider_charge" }],
      ["pi", "pi-1", "e3", { usd: null, provenance: "unavailable" }],
    ]);
    expect(rows[0]!.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 0 });
  });
});

describe("cursor", () => {
  it("starts over when the file was replaced by a shorter one", () => {
    const file = nodePath.join(dir, "r.jsonl");
    const line = (id: string, s: number) => claudeLine(id, `2026-11-09T10:00:${String(s).padStart(2, "0")}.000Z`, [], { output_tokens: 2 });
    writeFileSync(file, jsonl([line("req_1", 1), line("req_2", 2), line("req_3", 3)]));
    const store = new UsageRequestStore(db);
    const ingestor = new UsageRequestIngestor(db, store);
    const target = { runtime: "claude-code" as const, transcriptPath: file, seatSession: "s", nodeId: null, nativeSessionId: "n" };
    ingestor.ingest(target, "2026-11-09T10:01:00.000Z");
    writeFileSync(file, jsonl([line("req_9", 9)]));
    ingestor.ingest(target, "2026-11-09T10:02:00.000Z");
    expect(store.list({}).map((r) => r.requestKey)).toEqual(["req_1", "req_2", "req_3", "req_9"]);
  });

  it("skips past a single line longer than one read instead of stalling on it", () => {
    const file = nodePath.join(dir, "big.jsonl");
    const line = (id: string) => claudeLine(id, "2026-11-09T10:00:01.000Z", [], { output_tokens: 2 });
    writeFileSync(file, jsonl([{ type: "user", padding: "x".repeat(3000) }, line("req_after")]));
    const store = new UsageRequestStore(db);
    const ingestor = new UsageRequestIngestor(db, store, { maxReadBytes: 1024 });
    const target = { runtime: "claude-code" as const, transcriptPath: file, seatSession: "s", nodeId: null, nativeSessionId: "n" };
    for (let i = 0; i < 6; i++) ingestor.ingest(target, "2026-11-09T10:01:00.000Z");
    expect(store.list({}).map((r) => r.requestKey)).toEqual(["req_after"]);
  });
});
