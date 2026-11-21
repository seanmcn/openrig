// seanmcn/openrig#16: cost and tokens per row, slice, mission or repo over a time range, with an unattributed line,
// adding up to the seats' totals; and the per-request records read in full over a range, page by page.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { UsageRequestStore, type UsageRequestInput } from "../src/domain/usage-request-store.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString();
let db: Database.Database;
let app: Hono;
let seq = 0;

function row(id: string, seat: string, tags: string[], body: string, claimedAt = 0) {
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, tags, body)
              VALUES (?, ?, ?, 'lead@demo', ?, 'in-progress', ?, ?)`).run(id, at(0), at(0), seat, JSON.stringify(tags), body);
  db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, actor_session) VALUES (?, ?, 'in-progress', ?)").run(id, at(claimedAt), seat);
}

function req(seat: string, minute: number, paths: string[], usd: number | null, nodeId: string | null = "node-1"): UsageRequestInput {
  seq += 1;
  return {
    runtime: usd === null ? "codex" : "claude-code", seatSession: seat, nodeId, nativeSessionId: `n-${seat}`, requestKey: `r${seq}`,
    requestTs: at(minute), model: "m", tokens: { input: 10, output: 1, cacheRead: 100, cacheWrite: 0, reasoning: 0 },
    cost: usd === null ? { usd: null, provenance: "unavailable" } : { usd, provenance: "runtime_estimate" }, paths,
  };
}

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
  // The rig's repos, as workspace.repos[] declares them (here the worktrees are the repos' paths).
  db.prepare("INSERT INTO rigs (id, name, workspace_json) VALUES ('rig-1', 'demo', ?)").run(JSON.stringify({ workspaceRoot: "/w", repos: [
    { name: "app", path: "/w/app-s1", kind: "project" }, { name: "lib", path: "/w/lib-s1", kind: "project" },
    { name: "app2", path: "/w/app-s2", kind: "project" }] }));
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'impl')").run();
  // impl holds one slice spanning two repos (one worktree per repo) and a second, unrelated row.
  row("q-span", "impl@demo", ["slice:S.1", "mission:m1"], "worktree_path=/w/app-s1\nworktree_path=/w/lib-s1");
  row("q-other", "impl@demo", ["slice:S.2", "mission:m1"], "worktree_path=/w/app-s2");
  const store = new UsageRequestStore(db);
  store.record([
    req("impl@demo", 1, ["/w/app-s1/a.ts"], 1.0),
    req("impl@demo", 2, ["/w/lib-s1/b.ts"], 2.0),
    req("impl@demo", 3, ["/w/app-s2/c.ts"], 4.0),
    req("impl@demo", 4, ["/elsewhere"], 8.0), // several rows held, no path matches: unattributed
    req("idle@demo", 5, [], null, null), // a seat holding no rows
  ], at(59));
  app = new Hono();
  app.route("/api/telemetry", telemetryRoutes({ db: () => db, nowIso: () => at(59) }));
});
afterEach(() => db.close());

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

describe("GET /api/telemetry/usage/cost?by=", () => {
  it("groups by slice, a slice spanning two repos counted once, with an unattributed line naming its reasons", async () => {
    const { status, body } = await get("/api/telemetry/usage/cost?by=slice");
    expect(status).toBe(200);
    expect(body.by).toBe("slice");
    expect(body.groups.map((g: any) => [g.key, g.requests, g.costUsd])).toEqual([["S.2", 1, 4], ["S.1", 2, 3]]);
    expect(body.unattributed).toMatchObject({ requests: 2, costUsd: 8, costUnavailableRequests: 1,
      reasons: { paths_match_no_row: 1, no_rows_held: 1 } });
    expect(body.total).toMatchObject({ requests: 5, costUsd: 15, costUnavailableRequests: 1 });
  });

  it("groups by repo, splitting the spanning slice across the repos its requests touched", async () => {
    const { body } = await get("/api/telemetry/usage/cost?by=repo");
    expect(body.groups.map((g: any) => [g.key, g.costUsd])).toEqual([["app2", 4], ["lib", 2], ["app", 1]]);
  });

  it("adds the groups and the unattributed line up to the seats' totals, for every grouping", async () => {
    for (const by of ["row", "slice", "mission", "repo"]) {
      const { body } = await get(`/api/telemetry/usage/cost?by=${by}`);
      const sum = (list: any[], k: string) => list.reduce((n, x) => n + x[k], 0);
      const parts = [...body.groups, body.unattributed];
      expect(sum(parts, "requests")).toBe(sum(body.seats, "requests"));
      expect(sum(parts, "costUsd")).toBeCloseTo(sum(body.seats, "costUsd"), 9);
      expect(sum(parts.map((p: any) => p.tokens), "input")).toBe(sum(body.seats.map((s: any) => s.tokens), "input"));
      expect(body.seats.map((s: any) => [s.seatSession, s.requests])).toEqual([["idle@demo", 1], ["impl@demo", 4]]);
    }
  });

  it("bounds by time: since inclusive, until exclusive", async () => {
    const { body } = await get(`/api/telemetry/usage/cost?by=row&since=${at(2)}&until=${at(4)}`);
    expect(body.groups.map((g: any) => [g.key, g.requests])).toEqual([["q-other", 1], ["q-span", 1]]);
    expect(body.total.requests).toBe(2);
  });

  it("refuses an unknown grouping", async () => {
    const { status, body } = await get("/api/telemetry/usage/cost?by=team");
    expect(status).toBe(400);
    expect(body.error).toMatch(/row, slice, mission, repo/);
  });
});

describe("GET /api/telemetry/usage/requests", () => {
  it("serves every record in a range with its attribution, page by page until nextAfter is null", async () => {
    const seen: any[] = [];
    let after: number | null = null;
    for (let i = 0; i < 10; i++) {
      const { body } = await get(`/api/telemetry/usage/requests?since=${at(0)}&until=${at(30)}&limit=2${after !== null ? `&after=${after}` : ""}`);
      seen.push(...body.rows);
      after = body.nextAfter;
      if (after === null) break;
    }
    expect(seen.map((r) => r.requestTs)).toEqual([at(1), at(2), at(3), at(4), at(5)]);
    expect(seen[1]).toMatchObject({ seatSession: "impl@demo", paths: ["/w/lib-s1/b.ts"],
      attribution: { status: "attributed", basis: "worktree_path", qitemId: "q-span", slice: "S.1", mission: "m1", repo: "lib" } });
    expect(seen[4].attribution).toMatchObject({ status: "unattributed", basis: "no_rows_held" });
  });

  it("refuses a bad limit or cursor", async () => {
    expect((await get("/api/telemetry/usage/requests?limit=0")).status).toBe(400);
    expect((await get("/api/telemetry/usage/requests?after=x")).status).toBe(400);
  });
});
