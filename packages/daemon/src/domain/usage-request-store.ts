// seanmcn/openrig#16: per-request usage for every runtime (migration 158), attributed when it's written to the queue
// row, slice, mission and repo it was spent on. Only OpenRig's own concepts are used: claim windows from
// queue_transitions, the rows' `worktree_path=` lines, the rig's workspace.repos[], the row's target_repo and the
// candidate sha on the proof of the row's slice.
//
// The rule, in order:
//   1. Row: the in-progress rows the seat held at the request's timestamp. With one, that's the row. A row is the
//      seat's when it is the row's destination (only its destination can claim it); it was held at a time when its
//      latest transition at or before that time is in-progress.
//   2. Several: the row whose `worktree_path=` lines (all of them: a slice spanning repos names one per repo) contain
//      the request's paths; then, for a path in a worktree no row names (a reviewer's own checkout), the row whose
//      slice proof's candidate sha is that worktree's HEAD.
//   3. Repo: the workspace.repos[] entry containing the request's paths, else the row's target_repo.
//   4. Carry-forward: a request with no paths takes the seat's previous request's attribution while the seat still
//      holds that row.
//   5. Otherwise unattributed, with the reason and the candidate rows (as current-work refuses to guess).
// Records keep the inputs (paths, seat, timestamp), so attribution can be recomputed if the rule changes.
import path from "node:path";
import type { Database } from "better-sqlite3";

export type UsageRuntime = "claude-code" | "codex" | "pi";
export type CostProvenance = "runtime_estimate" | "provider_charge" | "unavailable";
export type AttributionBasis =
  | "single_row" | "worktree_path" | "candidate_sha" | "carry_forward"
  | "no_rows_held" | "several_rows_held" | "paths_match_several_rows" | "paths_match_no_row";

export interface UsageTokens { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }

export interface UsageRequestInput {
  runtime: UsageRuntime;
  seatSession: string;
  nodeId: string | null;
  nativeSessionId: string;
  /** Unique within the native session: Claude's request id, a Codex token_count's cumulative total, a Pi entry id. */
  requestKey: string;
  requestTs: string;
  model: string | null;
  tokens: UsageTokens;
  cost: { usd: number | null; provenance: CostProvenance };
  /** Absolute paths the request's tool calls touched. */
  paths: string[];
}

export interface Attribution {
  status: "attributed" | "unattributed";
  basis: AttributionBasis;
  qitemId: string | null;
  slice: string | null;
  mission: string | null;
  repo: string | null;
  /** The rows the seat held, when the rule couldn't choose among them. */
  candidateRows: string[];
}

export interface UsageRequestRow extends UsageRequestInput {
  id: number;
  attribution: Attribution;
  recordedAt: string;
}

export interface AttributionLookups {
  /** The git worktree containing `p`: its root and HEAD commit. Null when `p` isn't in one. */
  worktreeOf?: (p: string) => { root: string; head: string } | null;
  /** The candidate sha on the proof of this slice (as the review composer derives it); null when there is none. */
  sliceCandidateSha?: (slice: string) => string | null;
}

export interface UsageRequestQuery {
  since?: string;
  until?: string;
  seatSession?: string;
  /** Page after this record id (records are served in id order). */
  afterId?: number;
  limit?: number;
}

export function hasUsageRequestsTable(db: Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_requests'").get();
  } catch {
    return false;
  }
}

/** An ISO bound or timestamp as the stored form (UTC, milliseconds); unparseable text is kept as given. */
export function isoInstant(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

const WORKTREE_LINES = /^worktree_path=(\S+)\s*$/gm;
const SHA_TOKEN = /^([0-9a-fA-F]{7,40})(?:\b|$)/;

interface HeldRow { qitemId: string; tags: string[]; worktrees: string[]; targetRepo: string | null }

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

function tagValue(tags: string[], prefix: string): string | null {
  const tag = tags.find((t) => t.startsWith(prefix) && t.length > prefix.length);
  return tag ? tag.slice(prefix.length) : null;
}

function within(p: string, root: string): boolean {
  const r = root.endsWith(path.sep) && root.length > 1 ? root.slice(0, -1) : root;
  return p === r || p.startsWith(r + path.sep);
}

const UNATTRIBUTED = (basis: AttributionBasis, candidateRows: string[] = []): Attribution =>
  ({ status: "unattributed", basis, qitemId: null, slice: null, mission: null, repo: null, candidateRows });

export class UsageRequestStore {
  constructor(private readonly db: Database, private readonly lookups: AttributionLookups = {}) {}

  /** Store each request once. A request seen again (Claude streams one request over several lines, and a re-read
   *  returns lines again) keeps its largest token counts and cost and every path; when that changes anything, its
   *  attribution is recomputed. */
  record(inputs: UsageRequestInput[], recordedAt: string): { stored: number; updated: number } {
    const find = this.db.prepare(
      "SELECT * FROM usage_requests WHERE runtime = ? AND native_session_id = ? AND request_key = ?");
    const insert = this.db.prepare(
      `INSERT INTO usage_requests (runtime, seat_session, node_id, native_session_id, request_key, request_ts, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_provenance,
         paths_json, attribution_status, attribution_basis, qitem_id, slice, mission, repo, candidate_rows_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = this.db.prepare(
      `UPDATE usage_requests SET model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
         reasoning_tokens = ?, cost_usd = ?, cost_provenance = ?, paths_json = ?, attribution_status = ?, attribution_basis = ?,
         qitem_id = ?, slice = ?, mission = ?, repo = ?, candidate_rows_json = ?, recorded_at = ?
       WHERE id = ?`);
    let stored = 0;
    let updated = 0;
    this.db.transaction(() => {
      for (const raw of inputs) {
        const input = { ...raw, requestTs: isoInstant(raw.requestTs), paths: [...new Set(raw.paths)].sort() };
        const existing = find.get(input.runtime, input.nativeSessionId, input.requestKey) as Record<string, unknown> | undefined;
        if (!existing) {
          const a = this.attribute(input, null);
          insert.run(input.runtime, input.seatSession, input.nodeId, input.nativeSessionId, input.requestKey, input.requestTs,
            input.model, input.tokens.input, input.tokens.output, input.tokens.cacheRead, input.tokens.cacheWrite,
            input.tokens.reasoning, input.cost.usd, input.cost.provenance, JSON.stringify(input.paths), a.status, a.basis,
            a.qitemId, a.slice, a.mission, a.repo, JSON.stringify(a.candidateRows), recordedAt);
          stored += 1;
          continue;
        }
        const prev = toRow(existing);
        const merged: UsageRequestInput = {
          ...prev,
          model: prev.model ?? input.model,
          tokens: {
            input: Math.max(prev.tokens.input, input.tokens.input), output: Math.max(prev.tokens.output, input.tokens.output),
            cacheRead: Math.max(prev.tokens.cacheRead, input.tokens.cacheRead),
            cacheWrite: Math.max(prev.tokens.cacheWrite, input.tokens.cacheWrite),
            reasoning: Math.max(prev.tokens.reasoning, input.tokens.reasoning),
          },
          cost: mergeCost(prev.cost, input.cost),
          paths: [...new Set([...prev.paths, ...input.paths])].sort(),
        };
        const same = merged.model === prev.model && JSON.stringify(merged.tokens) === JSON.stringify(prev.tokens)
          && JSON.stringify(merged.cost) === JSON.stringify(prev.cost) && JSON.stringify(merged.paths) === JSON.stringify(prev.paths);
        if (same) continue;
        const a = merged.paths.length !== prev.paths.length ? this.attribute(merged, prev.id) : prev.attribution;
        update.run(merged.model, merged.tokens.input, merged.tokens.output, merged.tokens.cacheRead, merged.tokens.cacheWrite,
          merged.tokens.reasoning, merged.cost.usd, merged.cost.provenance, JSON.stringify(merged.paths), a.status, a.basis,
          a.qitemId, a.slice, a.mission, a.repo, JSON.stringify(a.candidateRows), recordedAt, prev.id);
        updated += 1;
      }
    })();
    return { stored, updated };
  }

  /** A provider's actual charge for a request already recorded: it replaces the runtime's estimate. */
  applyProviderCharge(runtime: UsageRuntime, nativeSessionId: string, requestKey: string, usd: number): boolean {
    return this.db.prepare(
      `UPDATE usage_requests SET cost_usd = ?, cost_provenance = 'provider_charge'
        WHERE runtime = ? AND native_session_id = ? AND request_key = ?`,
    ).run(usd, runtime, nativeSessionId, requestKey).changes > 0;
  }

  /** Records in id order, `since` inclusive and `until` exclusive on the request's timestamp. */
  list(q: UsageRequestQuery): UsageRequestRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.since) { where.push("request_ts >= ?"); params.push(isoInstant(q.since)); }
    if (q.until) { where.push("request_ts < ?"); params.push(isoInstant(q.until)); }
    if (q.seatSession) { where.push("seat_session = ?"); params.push(q.seatSession); }
    if (q.afterId !== undefined) { where.push("id > ?"); params.push(q.afterId); }
    const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : -1;
    return (this.db.prepare(
      `SELECT * FROM usage_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>).map(toRow);
  }

  private heldRows(seatSession: string, ts: string): HeldRow[] {
    const rows = this.db.prepare(
      `SELECT qi.qitem_id, qi.tags, qi.body, qi.target_repo FROM queue_items qi
        WHERE qi.destination_session = ?
          AND (SELECT t.state FROM queue_transitions t WHERE t.qitem_id = qi.qitem_id AND t.ts <= ?
                ORDER BY t.ts DESC, t.transition_id DESC LIMIT 1) = 'in-progress'
        ORDER BY qi.qitem_id`,
    ).all(seatSession, ts) as Array<{ qitem_id: string; tags: string | null; body: string | null; target_repo: string | null }>;
    return rows.map((r) => ({
      qitemId: r.qitem_id,
      tags: parseTags(r.tags),
      worktrees: [...(r.body ?? "").matchAll(WORKTREE_LINES)].map((m) => m[1]!),
      targetRepo: r.target_repo,
    }));
  }

  private workspaceRepos(nodeId: string | null): Array<{ name: string; path: string }> {
    if (!nodeId) return [];
    try {
      const row = this.db.prepare(
        "SELECT r.workspace_json FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?").get(nodeId) as { workspace_json: string | null } | undefined;
      const ws = row?.workspace_json ? JSON.parse(row.workspace_json) as { repos?: unknown } : null;
      return Array.isArray(ws?.repos)
        ? (ws.repos as Array<{ name?: unknown; path?: unknown }>).filter((r) => typeof r.name === "string" && typeof r.path === "string")
          .map((r) => ({ name: r.name as string, path: r.path as string }))
        : [];
    } catch {
      return [];
    }
  }

  private attributedTo(row: HeldRow, basis: AttributionBasis, input: UsageRequestInput): Attribution {
    // The repo whose path contains the request's paths (the deepest, for nested repos); else the row's target_repo.
    const repos = this.workspaceRepos(input.nodeId);
    const named = new Set<string>();
    for (const p of input.paths) {
      const best = repos.filter((r) => within(p, r.path)).sort((a, b) => b.path.length - a.path.length)[0];
      if (best) named.add(best.name);
    }
    return {
      status: "attributed", basis, qitemId: row.qitemId, slice: tagValue(row.tags, "slice:"), mission: tagValue(row.tags, "mission:"),
      repo: named.size === 1 ? [...named][0]! : row.targetRepo, candidateRows: [],
    };
  }

  private attribute(input: UsageRequestInput, selfId: number | null): Attribution {
    const held = this.heldRows(input.seatSession, input.requestTs);
    if (held.length === 0) return UNATTRIBUTED("no_rows_held");
    if (held.length === 1) return this.attributedTo(held[0]!, "single_row", input);
    const ids = held.map((r) => r.qitemId);

    if (input.paths.length > 0) {
      const byWorktree = new Set<string>();
      const unnamed: string[] = [];
      for (const p of input.paths) {
        const rows = held.filter((r) => r.worktrees.some((w) => within(p, w)));
        rows.forEach((r) => byWorktree.add(r.qitemId));
        if (rows.length === 0) unnamed.push(p);
      }
      if (byWorktree.size > 1) return UNATTRIBUTED("paths_match_several_rows", [...byWorktree].sort());
      if (byWorktree.size === 1) return this.attributedTo(held.find((r) => byWorktree.has(r.qitemId))!, "worktree_path", input);
      const bySha = this.candidateShaMatches(held, unnamed);
      if (bySha.length > 1) return UNATTRIBUTED("paths_match_several_rows", bySha.map((r) => r.qitemId));
      if (bySha.length === 1) return this.attributedTo(bySha[0]!, "candidate_sha", input);
      return UNATTRIBUTED("paths_match_no_row", ids);
    }

    // Carry-forward: the seat's previous request, while the seat still holds its row.
    const previous = this.db.prepare(
      `SELECT * FROM usage_requests WHERE seat_session = ? AND (request_ts < ? OR (request_ts = ? AND id < ?)) AND id IS NOT ?
        ORDER BY request_ts DESC, id DESC LIMIT 1`,
    ).get(input.seatSession, input.requestTs, input.requestTs, selfId ?? Number.MAX_SAFE_INTEGER, selfId) as Record<string, unknown> | undefined;
    const prev = previous ? toRow(previous).attribution : null;
    if (prev?.status === "attributed" && ids.includes(prev.qitemId!)) return { ...prev, basis: "carry_forward", candidateRows: [] };
    return UNATTRIBUTED("several_rows_held", ids);
  }

  /** The held rows whose slice proof names, as its candidate, the HEAD of a worktree one of these paths is in. */
  private candidateShaMatches(held: HeldRow[], paths: string[]): HeldRow[] {
    const { worktreeOf, sliceCandidateSha } = this.lookups;
    if (!worktreeOf || !sliceCandidateSha || paths.length === 0) return [];
    const heads = new Set<string>();
    for (const p of paths) {
      try {
        const wt = worktreeOf(p);
        if (wt?.head) heads.add(wt.head.toLowerCase());
      } catch { /* an unreadable worktree names no head */ }
    }
    if (heads.size === 0) return [];
    return held.filter((r) => {
      const slice = tagValue(r.tags, "slice:");
      if (!slice) return false;
      let raw: string | null = null;
      try { raw = sliceCandidateSha(slice); } catch { raw = null; }
      const token = raw?.trim().match(SHA_TOKEN)?.[1]?.toLowerCase();
      return !!token && [...heads].some((h) => h.startsWith(token));
    });
  }
}

export const COST_BY_GROUPINGS = ["row", "slice", "mission", "repo"] as const;
export type CostBy = (typeof COST_BY_GROUPINGS)[number];

export interface CostTotals {
  requests: number;
  /** The sum of the costs that are known; requests whose cost is unavailable are counted, never priced at zero. */
  costUsd: number;
  costByProvenance: { runtime_estimate: number; provider_charge: number };
  costUnavailableRequests: number;
  tokens: UsageTokens;
}

export interface CostByResult {
  by: CostBy;
  since: string | null;
  until: string | null;
  /** One per value of the grouping among attributed requests; `key` is null for attributed requests whose row has no
   *  such tag (or no repo). Ordered by cost, highest first. */
  groups: Array<CostTotals & { key: string | null }>;
  unattributed: CostTotals & { reasons: Record<string, number> };
  /** Per seat, over the same requests: groups plus unattributed add up to these. */
  seats: Array<CostTotals & { seatSession: string }>;
  total: CostTotals;
  note: string;
}

export const COST_BY_NOTE = "Per-request records (Claude transcript, Codex rollout, Pi's own entries). costUsd sums the known costs: "
  + "runtime estimates and provider charges, split in costByProvenance; Codex records no cost, so its requests count in "
  + "costUnavailableRequests and are never priced at zero. Groups and the unattributed line add up to the seats' totals.";

const GROUP_COLUMN: Record<CostBy, string> = { row: "qitem_id", slice: "slice", mission: "mission", repo: "repo" };

/** Cost and tokens per row, slice, mission or repo over [since, until), with the unattributed requests apart. */
export function computeCostBy(db: Database, q: { by: CostBy; since?: string; until?: string }): CostByResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.since) { where.push("request_ts >= ?"); params.push(isoInstant(q.since)); }
  if (q.until) { where.push("request_ts < ?"); params.push(isoInstant(q.until)); }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totals = `COUNT(*) AS requests,
    COALESCE(SUM(cost_usd), 0) AS cost_usd,
    COALESCE(SUM(CASE WHEN cost_provenance = 'runtime_estimate' THEN cost_usd END), 0) AS cost_estimate,
    COALESCE(SUM(CASE WHEN cost_provenance = 'provider_charge' THEN cost_usd END), 0) AS cost_charge,
    SUM(CASE WHEN cost_provenance = 'unavailable' THEN 1 ELSE 0 END) AS cost_unavailable,
    SUM(input_tokens) AS t_in, SUM(output_tokens) AS t_out, SUM(cache_read_tokens) AS t_cr,
    SUM(cache_write_tokens) AS t_cw, SUM(reasoning_tokens) AS t_re`;
  const shape = (r: Record<string, unknown> | undefined): CostTotals => ({
    requests: Number(r?.requests ?? 0),
    costUsd: Number(r?.cost_usd ?? 0),
    costByProvenance: { runtime_estimate: Number(r?.cost_estimate ?? 0), provider_charge: Number(r?.cost_charge ?? 0) },
    costUnavailableRequests: Number(r?.cost_unavailable ?? 0),
    tokens: { input: Number(r?.t_in ?? 0), output: Number(r?.t_out ?? 0), cacheRead: Number(r?.t_cr ?? 0),
      cacheWrite: Number(r?.t_cw ?? 0), reasoning: Number(r?.t_re ?? 0) },
  });
  const and = (clause: string) => (filter ? `${filter} AND ${clause}` : `WHERE ${clause}`);
  const column = GROUP_COLUMN[q.by];
  const groups = (db.prepare(
    `SELECT ${column} AS key, ${totals} FROM usage_requests ${and("attribution_status = 'attributed'")}
      GROUP BY ${column} ORDER BY cost_usd DESC, key ASC`,
  ).all(...params) as Array<Record<string, unknown>>).map((r) => ({ key: (r.key as string | null) ?? null, ...shape(r) }));
  const unattributed = shape(db.prepare(
    `SELECT ${totals} FROM usage_requests ${and("attribution_status = 'unattributed'")}`).get(...params) as Record<string, unknown>);
  const reasons = Object.fromEntries((db.prepare(
    `SELECT attribution_basis AS basis, COUNT(*) AS n FROM usage_requests ${and("attribution_status = 'unattributed'")}
      GROUP BY attribution_basis ORDER BY attribution_basis`).all(...params) as Array<{ basis: string; n: number }>)
    .map((r) => [r.basis, r.n]));
  const seats = (db.prepare(
    `SELECT seat_session, ${totals} FROM usage_requests ${filter} GROUP BY seat_session ORDER BY seat_session`,
  ).all(...params) as Array<Record<string, unknown>>).map((r) => ({ seatSession: r.seat_session as string, ...shape(r) }));
  const total = shape(db.prepare(`SELECT ${totals} FROM usage_requests ${filter}`).get(...params) as Record<string, unknown>);
  return { by: q.by, since: q.since ?? null, until: q.until ?? null, groups, unattributed: { ...unattributed, reasons }, seats, total, note: COST_BY_NOTE };
}

function mergeCost(a: UsageRequestInput["cost"], b: UsageRequestInput["cost"]): UsageRequestInput["cost"] {
  if (a.provenance === "provider_charge") return a;
  if (b.provenance === "provider_charge") return b;
  if (a.usd === null) return b;
  if (b.usd === null) return a;
  return b.usd > a.usd ? b : a;
}

function toRow(r: Record<string, unknown>): UsageRequestRow {
  const json = <T>(v: unknown, fallback: T): T => {
    try { return typeof v === "string" ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  };
  return {
    id: r.id as number,
    runtime: r.runtime as UsageRuntime,
    seatSession: r.seat_session as string,
    nodeId: (r.node_id as string | null) ?? null,
    nativeSessionId: r.native_session_id as string,
    requestKey: r.request_key as string,
    requestTs: r.request_ts as string,
    model: (r.model as string | null) ?? null,
    tokens: {
      input: r.input_tokens as number, output: r.output_tokens as number, cacheRead: r.cache_read_tokens as number,
      cacheWrite: r.cache_write_tokens as number, reasoning: r.reasoning_tokens as number,
    },
    cost: { usd: (r.cost_usd as number | null) ?? null, provenance: r.cost_provenance as CostProvenance },
    paths: json<string[]>(r.paths_json, []),
    attribution: {
      status: r.attribution_status as Attribution["status"],
      basis: r.attribution_basis as AttributionBasis,
      qitemId: (r.qitem_id as string | null) ?? null,
      slice: (r.slice as string | null) ?? null,
      mission: (r.mission as string | null) ?? null,
      repo: (r.repo as string | null) ?? null,
      candidateRows: json<string[]>(r.candidate_rows_json, []),
    },
    recordedAt: r.recorded_at as string,
  };
}
