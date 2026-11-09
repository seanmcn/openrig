// 51-08 A4 — `rig usage`: the CLI face of the ONE telemetry projection
// (PM decision 4; the daemon's /api/telemetry/usage/* routes). Facts only:
// tokens/hour, window velocities, honest-unknown rail — thresholds and
// judgments belong to the consumer (the oversight detector). --json is
// verbatim route payload for the scripted detector.
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/** Parse a human duration (`90m`, `1h`, `2d`, bare hours `1.5`) into hours.
 *  Returns null on anything unparseable — the caller renders the teaching error. */
export function parseWindowToHours(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhd])?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "h";
  if (unit === "m") return n / 60;
  if (unit === "d") return n * 24;
  return n;
}

interface TopPayload {
  ranked: Array<{
    seatSession: string;
    tokensPerHour: number;
    tokensDelta: number;
    resets: number;
    spanHours: number;
    samples: number;
    windows: Array<{ window: string; usedPercentFirst: number | null; usedPercentLast: number | null; percentPerHour: number | null }>;
  }>;
  unknown: Array<{ seatSession: string; reason: string }>;
  totalRankedSeats: number;
  windowHours: number;
}

interface CostPayload {
  seats: Array<Record<string, unknown> & { seatSession: string; status: string }>;
  note: string;
}

const tok = (t: unknown): string => {
  const v = t as { input?: number | null; output?: number | null } | undefined;
  return `tokens in ${v?.input ?? "?"} / out ${v?.output ?? "?"}`;
};

/** A real estimate below a cent prints as "<$0.01", never "$0.00" (which reads as zero); JSON keeps the exact value. */
export function formatUsd(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`;
}

/** A Pi seat: the model-priced estimate summed over its own persisted entries, with what isn't in it named. */
function piCostLine(seat: CostPayload["seats"][number]): string {
  const w = (seat["window"] ?? {}) as { piSessionId?: string; since?: string | null; asOf?: string | null };
  const e = (seat["entries"] ?? {}) as { own?: number; ownWithoutCost?: number; errorOrAborted?: number;
    inherited?: { count: number; costUsd: number | null }; unknownOrigin?: { count: number; costUsd: number | null } };
  const t = (seat["tokens"] ?? {}) as { input?: number; output?: number };
  const extras = [
    e.ownWithoutCost ? `${e.ownWithoutCost} entr${e.ownWithoutCost === 1 ? "y" : "ies"} without a cost` : "",
    e.errorOrAborted ? `${e.errorOrAborted} error/aborted turn${e.errorOrAborted === 1 ? "" : "s"} included` : "",
    e.inherited?.count ? `${e.inherited.count} inherited from the fork, not counted${e.inherited.costUsd !== null ? ` (${formatUsd(e.inherited.costUsd)})` : ""}` : "",
    e.unknownOrigin?.count ? `${e.unknownOrigin.count} of unknown origin, not counted${e.unknownOrigin.costUsd !== null ? ` (${formatUsd(e.unknownOrigin.costUsd)})` : ""}` : "",
  ].filter(Boolean).join("; ");
  const head = seat.status === "reported"
    ? `${formatUsd(Number(seat["costUsd"]))} model-priced estimate (Pi persisted entries, ${e.own ?? 0} own entries) for Pi session ${w.piSessionId}${w.since ? ` since ${w.since}` : ""}${w.asOf ? `, last ${w.asOf}` : ""}`
    : `cost: not reported (${seat["reason"]}) for Pi session ${w.piSessionId}`;
  const charge = providerChargeText(seat["providerCharge"]);
  return `${seat.seatSession}  ${head}${extras ? `; ${extras}` : ""}${charge ? `; ${charge}` : ""}  tokens in ${t.input ?? "?"} / out ${t.output ?? "?"}`;
}

/** OpenRouter's actual charge, beside the estimate: never summed with it, and named when it isn't there. */
function providerChargeText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const c = raw as { status?: string; costUsd?: number; estimateForChargedUsd?: number | null;
    requests?: { covered?: number; charged?: number; pending?: number; unavailable?: { count: number; reasons: Record<string, number> };
      notCovered?: { count: number } }; accountContext?: { credentialSources?: string[]; workspaceIds?: string[] } };
  const q = c.requests ?? {};
  const top = (reasons: Record<string, number> | undefined) => Object.entries(reasons ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  const notCovered = q.notCovered?.count ? `, ${q.notCovered.count} not covered` : "";
  switch (c.status) {
    case "reported":
    case "partial": {
      const beside = c.estimateForChargedUsd !== null && c.estimateForChargedUsd !== undefined ? `, Pi estimate for them ${formatUsd(c.estimateForChargedUsd)}` : "";
      const rest = [q.pending ? `${q.pending} pending` : "", q.unavailable?.count ? `${q.unavailable.count} unavailable (${top(q.unavailable.reasons)})` : ""].filter(Boolean).join(", ");
      const who = c.accountContext?.credentialSources?.length ? ` via ${c.accountContext.credentialSources.join(", ")}` : "";
      return `OpenRouter charge ${formatUsd(Number(c.costUsd))} USD for ${q.charged} of ${q.covered} requests${who}${beside}${rest ? `; ${rest}` : ""}${notCovered} (provider-reported, not added to the estimate)`;
    }
    case "pending": return `OpenRouter charge pending for ${q.pending} request${q.pending === 1 ? "" : "s"}${notCovered}`;
    case "unavailable": return `OpenRouter charge unavailable (${top(q.unavailable?.reasons)})${notCovered}`;
    case "none": return q.covered ? `OpenRouter charge not looked up (usage.pi_openrouter_charge off, or not run yet)${notCovered}` : (q.notCovered?.count ? `OpenRouter charge: ${q.notCovered.count} request${q.notCovered.count === 1 ? "" : "s"} not covered` : "");
    default: return "";
  }
}

/** One labelled line per seat. Never prints a dollar figure the route didn't report. */
export function costLine(seat: CostPayload["seats"][number]): string {
  if (seat["runtime"] === "pi") return piCostLine(seat);
  const w = (seat["window"] ?? {}) as { nativeSessionId?: string | null; since?: string; asOf?: string | null };
  if (seat.status === "reported") {
    const stale = seat["stale"] ? `, STALE (${seat["ageSeconds"] ?? "?"}s old; kept as history)` : "";
    const resets = Number(seat["resets"]) > 0 ? `, ${seat["resets"]} reset${seat["resets"] === 1 ? "" : "s"}` : "";
    return `${seat.seatSession}  ${formatUsd(Number(seat["costUsd"]))} client-side estimate (Claude statusline) for session ${w.nativeSessionId} since ${w.since}, as of ${w.asOf}${resets}${stale}  ${tok(seat["tokens"])}`;
  }
  if (seat.status === "absent") return `${seat.seatSession}  cost: not reported (${seat["reason"]})  ${tok(seat["tokens"])}`;
  if (seat.status === "no-cost-method") return `${seat.seatSession}  ${tok(seat["tokens"])}  cost: ${seat["note"]}`;
  return `${seat.seatSession}  cost: unknown (${seat["reason"]})`;
}

const COST_BY = ["row", "slice", "mission", "repo"] as const;

interface CostTotals {
  requests: number;
  costUsd: number;
  costUnavailableRequests: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
interface CostByPayload {
  by: string;
  groups: Array<CostTotals & { key: string | null }>;
  unattributed: CostTotals & { reasons: Record<string, number> };
  seats: Array<CostTotals & { seatSession: string }>;
  total: CostTotals;
  note: string;
}

function totalsText(t: CostTotals, extra = ""): string {
  const n = `${t.requests} request${t.requests === 1 ? "" : "s"}`;
  const unpriced = t.costUnavailableRequests ? `, ${t.costUnavailableRequests} without a cost` : "";
  return `${formatUsd(t.costUsd)} (${n}${unpriced}${extra})`;
}
const tokensText = (t: CostTotals["tokens"]): string =>
  `tokens in ${t.input} / out ${t.output} / cache read ${t.cacheRead} / cache write ${t.cacheWrite}`;

/** One line per group, the unattributed line with its reasons, and the total the lines add up to. */
export function costByLines(body: CostByPayload): string[] {
  const lines = [`COST BY ${body.by.toUpperCase()}`];
  for (const g of body.groups) lines.push(`${g.key ?? `(no ${body.by})`}  ${totalsText(g)}  ${tokensText(g.tokens)}`);
  const u = body.unattributed;
  if (u.requests > 0) {
    const reasons = Object.entries(u.reasons).map(([k, v]) => `${k} ${v}`).join(", ");
    lines.push(`unattributed  ${totalsText(u, reasons ? `; ${reasons}` : "")}  ${tokensText(u.tokens)}`);
  }
  lines.push(`total  ${totalsText(body.total)} across ${body.seats.length} seat${body.seats.length === 1 ? "" : "s"}`);
  lines.push(body.note);
  return lines;
}

function requestLine(r: Record<string, unknown>): string {
  const cost = (r["cost"] ?? {}) as { usd?: number | null; provenance?: string };
  const t = (r["tokens"] ?? {}) as { input?: number; output?: number };
  const a = (r["attribution"] ?? {}) as { status?: string; basis?: string; qitemId?: string | null; slice?: string | null; repo?: string | null };
  const price = cost.usd === null || cost.usd === undefined ? "cost unavailable" : `${formatUsd(cost.usd)} ${cost.provenance}`;
  const where = a.status === "attributed"
    ? `${a.qitemId}${a.slice ? ` slice ${a.slice}` : ""}${a.repo ? ` repo ${a.repo}` : ""} (${a.basis})`
    : `unattributed (${a.basis})`;
  return `${r["requestTs"]}  ${r["seatSession"]}  ${r["runtime"]} ${r["model"] ?? "?"}  ${price}  in ${t.input ?? "?"} / out ${t.output ?? "?"}  → ${where}`;
}

export function usageCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("usage").description(
    "Per-seat token telemetry over time (series + top-N burn) — facts for the oversight detector",
  );
  const getDeps = (): StatusDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  function handleHttpError(res: { status: number; data: unknown }, label: string, json?: boolean): boolean {
    if (res.status < 400) return false;
    if (json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      const p = (res.data ?? {}) as { error?: unknown };
      console.error(p.error ?? `${label} failed (HTTP ${res.status})`);
    }
    process.exitCode = res.status >= 500 ? 2 : 1;
    return true;
  }

  cmd
    .command("top")
    .description("top-N seats by token burn over the window")
    .option("--window <duration>", "look-back window (90m, 1h, 2d, or bare hours)", "1h")
    .option("--top <n>", "cap the ranking to N seats")
    .option("--json", "machine-readable (verbatim route payload)")
    .action(async (opts: { window: string; top?: string; json?: boolean }) => {
      const hours = parseWindowToHours(opts.window);
      if (hours === null) {
        console.error(
          `invalid --window "${opts.window}" — accepted forms: 90m, 1h, 2d, or bare hours like 1.5`,
        );
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams({ window_hours: String(hours) });
      if (opts.top !== undefined) params.set("top", opts.top);
      const res = await client.get<TopPayload>(`/api/telemetry/usage/top?${params.toString()}`);
      if (handleHttpError(res, "usage top", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const body = res.data;
      if (body.ranked.length === 0 && body.unknown.length === 0) {
        console.log(`no usage samples in the last ${opts.window} — the series is empty`);
        return;
      }
      console.log(`TOP TOKEN BURN — last ${opts.window} (${body.totalRankedSeats} seats ranked)`);
      for (const [i, r] of body.ranked.entries()) {
        const winPart = r.windows
          .map((w) => `${w.window}: ${w.usedPercentLast ?? "?"}%${w.percentPerHour !== null ? ` (${w.percentPerHour >= 0 ? "+" : ""}${w.percentPerHour.toFixed(1)}%/h)` : ""}`)
          .join("  ");
        const resetPart = r.resets > 0 ? `  resets:${r.resets}` : "";
        console.log(
          `${i + 1}. ${r.seatSession}  ${Math.round(r.tokensPerHour).toLocaleString()} tok/h  (${r.tokensDelta.toLocaleString()} over ${r.spanHours.toFixed(1)}h, ${r.samples} samples)${resetPart}${winPart ? `  ${winPart}` : ""}`,
        );
      }
      for (const u of body.unknown) {
        console.log(`?  ${u.seatSession}  unknown (${u.reason})`); // honest rail — never a 0 row
      }
    });

  cmd
    .command("cost")
    .description("what each seat's harness reports about cost, beside tokens: kind, source, window and coverage")
    .option("--seat <session>", "one seat session")
    .option("--json", "machine-readable (verbatim route payload)")
    .addHelpText("after", `
Claude seats show the statusline's cost.total_cost_usd: a client-side estimate, cumulative for one
native session since its last reset (not an invoice). Codex seats show tokens and that the inspected
method reports no cost. A missing figure reads as missing and an old one as stale, never as $0; no
subscription window is shown in dollars. Earlier cost values stay in rig usage series --lane context --json.
With usage.pi_cost_facts on (default off), Pi seats show Pi's model-priced estimate summed over
their own persisted session entries, each counted once; entries a fork copied in are shown apart and
not counted, and an entry without a cost is named, not counted as zero.
With usage.pi_openrouter_charge on as well (default off), OpenRouter's actual charge for those requests
is shown beside the estimate (never added to it), when the seat's OpenRouter key is the one OpenRig
forwarded; requests it can't charge are counted with the reason. Changes to either Pi switch take
effect when the seat next launches or resumes; a running seat keeps its launch selection. Outcomes
recorded while the switches were on stay visible.

With --by row|slice|mission|repo, cost and tokens come from the per-request records instead
(rig usage requests): each Claude, Codex or Pi request attributed to the queue row the seat held
when it was made, its slice and mission tags, and the workspace repo its paths were in. Requests
the rule couldn't attribute are one unattributed line, with the reasons; the groups and that line
add up to the seats' totals. A request without a cost (every Codex request) is counted, not priced.`)
    .option("--by <grouping>", `group per-request cost by ${COST_BY.join(", ")}`)
    .option("--since <iso>", "with --by: lower bound on the request time (inclusive)")
    .option("--until <iso>", "with --by: upper bound on the request time (exclusive)")
    .action(async (opts: { seat?: string; json?: boolean; by?: string; since?: string; until?: string }) => {
      if (opts.by !== undefined && !(COST_BY as readonly string[]).includes(opts.by)) {
        console.error(`invalid --by "${opts.by}" — group by one of ${COST_BY.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      if (opts.by === undefined && (opts.since || opts.until)) {
        console.error("--since and --until bound the per-request records: use them with --by");
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      if (opts.by !== undefined) {
        const params = new URLSearchParams({ by: opts.by });
        if (opts.since) params.set("since", opts.since);
        if (opts.until) params.set("until", opts.until);
        const res = await client.get<CostByPayload>(`/api/telemetry/usage/cost?${params.toString()}`);
        if (handleHttpError(res, "usage cost", opts.json)) return;
        if (opts.json) console.log(JSON.stringify(res.data, null, 2));
        else for (const line of costByLines(res.data)) console.log(line);
        return;
      }
      const params = new URLSearchParams();
      if (opts.seat) params.set("seat", opts.seat);
      const res = await client.get<CostPayload>(`/api/telemetry/usage/cost${params.size ? `?${params.toString()}` : ""}`);
      if (handleHttpError(res, "usage cost", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const body = res.data;
      if (body.seats.length === 0) {
        console.log("no usage samples yet: no seat has reported tokens or cost");
        return;
      }
      for (const seat of body.seats) console.log(costLine(seat));
      console.log(body.note);
    });

  cmd
    .command("requests")
    .description("per-request usage records with their attribution (row, slice, mission, repo), oldest first")
    .option("--seat <session>", "one seat session")
    .option("--since <iso>", "lower bound on the request time (inclusive)")
    .option("--until <iso>", "upper bound on the request time (exclusive)")
    .option("--json", "machine-readable: every record in the range, all pages, as { rows }")
    .addHelpText("after", `
Reads every page the daemon serves, so --json holds all the records in the range: copy them out
before retention.usage_samples_days deletes them. Each record keeps its inputs (seat, native session,
time, model, tokens by kind, the paths its tool calls touched) beside its attribution and cost
provenance (runtime_estimate, provider_charge or unavailable).`)
    .action(async (opts: { seat?: string; since?: string; until?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const rows: Array<Record<string, unknown>> = [];
      let after: number | null = null;
      do {
        const params = new URLSearchParams();
        if (opts.seat) params.set("seat", opts.seat);
        if (opts.since) params.set("since", opts.since);
        if (opts.until) params.set("until", opts.until);
        if (after !== null) params.set("after", String(after));
        const qs = params.toString();
        const res = await client.get<{ rows: Array<Record<string, unknown>>; nextAfter: number | null }>(
          `/api/telemetry/usage/requests${qs ? `?${qs}` : ""}`);
        if (handleHttpError(res, "usage requests", opts.json)) return;
        rows.push(...res.data.rows);
        after = res.data.nextAfter;
      } while (after !== null);
      if (opts.json) {
        console.log(JSON.stringify({ rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("no per-request records match");
        return;
      }
      for (const r of rows) console.log(requestLine(r));
    });

  cmd
    .command("series")
    .description("raw per-seat usage samples, oldest first")
    .option("--seat <session>", "filter to one seat session")
    .option("--lane <lane>", "context | provider_window")
    .option("--since <iso>", "absolute lower bound on captured_at (inclusive)")
    .option("--until <iso>", "absolute upper bound on captured_at (exclusive)")
    .option("--limit <n>", "max rows")
    .option("--json", "machine-readable (verbatim route payload)")
    .action(async (opts: { seat?: string; lane?: string; since?: string; until?: string; limit?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.lane) params.set("lane", opts.lane);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      if (opts.limit) params.set("limit", opts.limit);
      const qs = params.toString();
      const res = await client.get<{ rows: Array<Record<string, unknown>>; advisories?: string[] }>(
        `/api/telemetry/usage/series${qs ? `?${qs}` : ""}`,
      );
      if (handleHttpError(res, "usage series", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      // An advisory (e.g. a bound that isn't a date or time) goes to stderr, so stdout stays the series.
      for (const advisory of res.data.advisories ?? []) console.error(`note: ${advisory}`);
      const rows = res.data.rows;
      if (rows.length === 0) {
        console.log("no samples match — the series is empty for this filter");
        return;
      }
      for (const r of rows) {
        const lane = r.lane === "provider_window"
          ? `${r.window} ${r.windowUsedPercent ?? "?"}%`
          : `tokens ${(r.totalInputTokens as number | null) ?? "?"}/${(r.totalOutputTokens as number | null) ?? "?"} used ${(r.usedPercentage as number | null) ?? "?"}%`;
        console.log(`${r.capturedAt}  ${r.seatSession}  [${r.lane}] ${lane}`);
      }
    });

  return cmd;
}
