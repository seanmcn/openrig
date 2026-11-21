// seanmcn/openrig#16: each request's usage is attributed to the queue row the seat held when it was made, by the rule
// in usage-request-store.ts. Queue rows and transitions are built in the test database; git and slice proofs are the
// store's injected lookups.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { UsageRequestStore, type UsageRequestInput, type AttributionLookups } from "../src/domain/usage-request-store.js";

const SEAT = "impl@demo";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString();

let db: Database.Database;
let seq = 0;

function row(id: string, opts: { seat?: string; tags?: string[]; body?: string; targetRepo?: string | null; claimedAt: number; closedAt?: number }) {
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, tags, body, target_repo)
              VALUES (?, ?, ?, 'lead@demo', ?, 'pending', ?, ?, ?)`)
    .run(id, at(0), at(0), opts.seat ?? SEAT, JSON.stringify(opts.tags ?? []), opts.body ?? "work", opts.targetRepo ?? null);
  const transition = (ts: string, state: string) => db.prepare(
    "INSERT INTO queue_transitions (qitem_id, ts, state, actor_session) VALUES (?, ?, ?, ?)").run(id, ts, state, opts.seat ?? SEAT);
  transition(at(0), "pending");
  transition(at(opts.claimedAt), "in-progress");
  if (opts.closedAt !== undefined) transition(at(opts.closedAt), "done");
}

function request(minute: number, paths: string[] = [], over: Partial<UsageRequestInput> = {}): UsageRequestInput {
  seq += 1;
  return {
    runtime: "claude-code", seatSession: SEAT, nodeId: null, nativeSessionId: "native-1", requestKey: `req_${seq}`,
    requestTs: at(minute), model: "claude-x", tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, reasoning: 0 },
    cost: { usd: 0.01, provenance: "runtime_estimate" }, paths, ...over,
  };
}

function recordOne(input: UsageRequestInput, lookups: AttributionLookups = {}) {
  const store = new UsageRequestStore(db, lookups);
  store.record([input], at(59));
  return store.list({}).find((r) => r.requestKey === input.requestKey)!;
}

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
});
afterEach(() => db.close());

describe("usage request attribution", () => {
  it("attributes to the one in-progress row the seat held, with its slice and mission tags", () => {
    row("q-1", { claimedAt: 1, tags: ["slice:OPR.1.2", "mission:release-1"], targetRepo: "app" });
    const r = recordOne(request(5));
    expect(r.attribution).toEqual({ status: "attributed", basis: "single_row", qitemId: "q-1", slice: "OPR.1.2",
      mission: "release-1", repo: "app", candidateRows: [] });
  });

  it("uses the rows held at the request's timestamp, not now", () => {
    row("q-old", { claimedAt: 1, closedAt: 10 });
    row("q-new", { claimedAt: 20 });
    expect(recordOne(request(5)).attribution.qitemId).toBe("q-old");
    expect(recordOne(request(25)).attribution.qitemId).toBe("q-new");
  });

  it("leaves a request unattributed when the seat holds no rows", () => {
    row("q-other", { seat: "other@demo", claimedAt: 1 });
    row("q-done", { claimedAt: 1, closedAt: 2 });
    expect(recordOne(request(5, ["/w/app/a.ts"])).attribution).toEqual({ status: "unattributed", basis: "no_rows_held",
      qitemId: null, slice: null, mission: null, repo: null, candidateRows: [] });
  });

  it("breaks a tie by matching the request's paths against every worktree_path= line of each row", () => {
    row("q-a", { claimedAt: 1, body: "do a\nworktree_path=/w/a-app\n" });
    // A slice spanning two repos names one worktree per repo; the second line counts as much as the first.
    row("q-b", { claimedAt: 2, tags: ["slice:S.2"], body: "do b\nworktree_path=/w/b-app\nworktree_path=/w/b-lib\nmore" });
    const r = recordOne(request(5, ["/w/b-lib/src/x.ts"]));
    expect(r.attribution).toMatchObject({ status: "attributed", basis: "worktree_path", qitemId: "q-b", slice: "S.2" });
  });

  it("refuses to guess when the paths match worktrees of several rows", () => {
    row("q-a", { claimedAt: 1, body: "worktree_path=/w/a" });
    row("q-b", { claimedAt: 2, body: "worktree_path=/w/b" });
    const r = recordOne(request(5, ["/w/a/x", "/w/b/y"]));
    expect(r.attribution).toEqual({ status: "unattributed", basis: "paths_match_several_rows", qitemId: null, slice: null,
      mission: null, repo: null, candidateRows: ["q-a", "q-b"] });
  });

  it("matches a worktree no row names by its HEAD against the candidateSha on each row's slice proof (a reviewer holding two review rows)", () => {
    row("r-1", { seat: "rev@demo", claimedAt: 1, tags: ["slice:S.1", "mission:m"] });
    row("r-2", { seat: "rev@demo", claimedAt: 2, tags: ["slice:S.2", "mission:m"] });
    const lookups: AttributionLookups = {
      worktreeOf: (p) => (p.startsWith("/rev/checkout/") ? { root: "/rev/checkout", head: "b".repeat(40) } : null),
      sliceCandidateSha: (slice) => (slice === "S.1" ? "aaaaaaa" : slice === "S.2" ? "bbbbbbbbb (exact tip)" : null),
    };
    const r = recordOne(request(5, ["/rev/checkout/src/y.ts"], { seatSession: "rev@demo" }), lookups);
    expect(r.attribution).toMatchObject({ status: "attributed", basis: "candidate_sha", qitemId: "r-2", slice: "S.2" });
  });

  it("carries the previous request's attribution forward to a request with no paths while the row is still held", () => {
    row("q-a", { claimedAt: 1, body: "worktree_path=/w/a" });
    row("q-b", { claimedAt: 2, body: "worktree_path=/w/b" });
    const store = new UsageRequestStore(db);
    store.record([request(5, ["/w/b/z"]), request(6)], at(59));
    const [first, second] = store.list({});
    expect(first!.attribution.qitemId).toBe("q-b");
    expect(second!.attribution).toMatchObject({ status: "attributed", basis: "carry_forward", qitemId: "q-b" });
  });

  it("does not carry forward once the seat no longer holds that row", () => {
    row("q-a", { claimedAt: 1, body: "worktree_path=/w/a" });
    row("q-b", { claimedAt: 2, closedAt: 7, body: "worktree_path=/w/b" });
    row("q-c", { claimedAt: 8, body: "worktree_path=/w/c" });
    const store = new UsageRequestStore(db);
    store.record([request(5, ["/w/b/z"]), request(9)], at(59));
    expect(store.list({})[1]!.attribution).toEqual({ status: "unattributed", basis: "several_rows_held", qitemId: null,
      slice: null, mission: null, repo: null, candidateRows: ["q-a", "q-c"] });
  });

  it("names the repo from workspace.repos[] containing the paths, else the row's target_repo", () => {
    db.prepare("INSERT INTO rigs (id, name, workspace_json) VALUES ('rig-1', 'demo', ?)").run(JSON.stringify({
      workspaceRoot: "/w", repos: [{ name: "app", path: "/w/app", kind: "project" }, { name: "lib", path: "/w/lib", kind: "project" }],
    }));
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'impl')").run();
    row("q-1", { claimedAt: 1, targetRepo: "app" });
    expect(recordOne(request(5, ["/w/lib/src/a.ts"], { nodeId: "node-1" })).attribution.repo).toBe("lib");
    expect(recordOne(request(6, ["/elsewhere/a.ts"], { nodeId: "node-1" })).attribution.repo).toBe("app");
  });
});

describe("usage request records", () => {
  it("counts a request repeated across streamed lines once, keeping its largest counts and every path", () => {
    row("q-1", { claimedAt: 1 });
    const store = new UsageRequestStore(db);
    const first = request(5, ["/w/a"]);
    store.record([first], at(59));
    const result = store.record([{ ...first, tokens: { ...first.tokens, output: 50 }, paths: ["/w/b"] }], at(59));
    expect(result).toEqual({ stored: 0, updated: 1 });
    const rows = store.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.output).toBe(50);
    expect(rows[0]!.paths).toEqual(["/w/a", "/w/b"]);
    expect(store.record([first], at(59))).toEqual({ stored: 0, updated: 0 });
  });

  it("keeps an unavailable cost as null, never zero", () => {
    const r = recordOne(request(5, [], { runtime: "codex", cost: { usd: null, provenance: "unavailable" } }));
    expect(r.cost).toEqual({ usd: null, provenance: "unavailable" });
  });

  it("follows retention.usage_samples_days: records older than the window are deleted with the samples", async () => {
    const { pruneUsageSamples } = await import("../src/domain/queue-retention.js");
    const store = new UsageRequestStore(db);
    store.record([request(1, [], { requestTs: "2026-10-01T00:00:00.000Z" }), request(2)], at(59));
    pruneUsageSamples(db, { nowIso: at(59), usageSamplesRetentionDays: 14 });
    expect(store.list({}).map((r) => r.requestTs)).toEqual([at(2)]);
  });

  it("pages over a time range in id order", () => {
    const store = new UsageRequestStore(db);
    store.record([request(1), request(2), request(3), request(4)], at(59));
    const page1 = store.list({ since: at(2), until: at(4), limit: 1 });
    expect(page1.map((r) => r.requestTs)).toEqual([at(2)]);
    const page2 = store.list({ since: at(2), until: at(4), afterId: page1[0]!.id });
    expect(page2.map((r) => r.requestTs)).toEqual([at(3)]);
  });
});
