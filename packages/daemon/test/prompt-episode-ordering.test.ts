import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";

// Known production defects: expected failures retain the intended assertions until ordering is fixed.
// See docs/as-built/prompt-episode-chronology-investigation.md.
describe("prompt episode causal ordering", () => {
  const base = Date.parse("2030-01-01T00:00:00Z");
  const seat = "worker@fixture";
  let db: Database.Database;
  let repo: QueueRepository;
  let jobId: string;
  let state: "blocked" | "clear";
  let wakes: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: base - 4 });
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    ({ jobId } = new WatchdogJobsRepository(db).register({ policy: "periodic-reminder", targetSession: seat,
      intervalSeconds: 7200, registeredBySession: seat,
      specYaml: `policy: periodic-reminder\ntarget:\n  session: ${seat}\ninterval_seconds: 7200\nmessage: sweep\n` }));
    vi.setSystemTime(base);
    state = "blocked"; wakes = [];
  });
  afterEach(() => { try { db.close(); } finally { vi.useRealTimers(); } });

  function record(outcome: "sent" | "refused", offset: number) {
    return new WatchdogHistoryLog(db).record({ jobId, evaluatedAt: new Date(base + offset).toISOString(), outcome,
      deliveryTargetSession: seat, deliveryStatus: outcome === "sent" ? "ok" : "failed",
      evaluationNotes: outcome === "refused" ? { deliveryReason: `Refused: '${seat}' is at an interactive prompt (selection_prompt). No text was sent.` } : null });
  }
  function tick() {
    return runWakeLadderTick({ db, queueRepo: repo, now: new Date(Date.now() + 120_000), retryIntervalSeconds: 60,
      readPromptState: () => state, resolveOrchestrator: () => "lead@fixture",
      attemptWake: async (_id, target) => { wakes.push(target); return "verified"; }, log: () => {} });
  }
  function alerts() {
    return repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 }).filter(r => r.tags?.includes("wake-prompt-refusal"));
  }

  it.fails("counts a refusal observed after clearing in the same millisecond", async () => {
    record("sent", -3); record("refused", -2); record("refused", -1);
    await tick();
    const first = alerts()[0]!;
    state = "clear"; await tick();
    expect(repo.getById(first.qitemId)?.state).toBe("done");
    state = "blocked"; record("refused", 0);
    vi.setSystemTime(base + 1); record("refused", 1);
    await tick();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.qitemId).not.toBe(first.qitemId);
    expect(wakes).toEqual(["lead@fixture", "lead@fixture"]);
  });

  it.fails("keeps insertion order for a sent attempt followed by two same-millisecond refusals", async () => {
    for (const [index, outcome] of (["sent", "refused", "refused"] as const).entries()) {
      const entry = record(outcome, 0);
      // Legal ULIDs with the same time prefix: ordinary ulid() can generate this suffix order.
      const id = entry.historyId.slice(0, 10) + String(3 - index).padStart(16, "0");
      db.prepare("UPDATE watchdog_history SET history_id = ? WHERE history_id = ?").run(id, entry.historyId);
    }
    await tick();
    expect(alerts()).toHaveLength(1);
    expect(wakes).toEqual(["lead@fixture"]);
  });
});
