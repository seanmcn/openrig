import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most daemon files start real processes and tmux servers, so files running at once compete for process start-up,
    // not for CPU. vitest's default of one file per core but one runs 9 at once on a 10-core host, and there the fixtures'
    // spawn bounds and tmux sessions fail while the suite takes no less time: a full run failed 25 tests at 9 workers and 8
    // at 4, finishing ~100 s sooner. CI runners with four or fewer cores keep vitest's default; `--maxWorkers` overrides it.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    include: ["test/**/*.test.ts"],
    // P6/D12-residue: many daemon suites spawn REAL child processes (stub-runner-*,
    // precompact-hook, bridge, restore-from-jsonl — 20+ files). Under fold-gate
    // contention (parallel files + fleet load) a single node spawn can take 5-10s,
    // exceeding vitest's 5s default and flaking on TIMEOUT (not on any assertion).
    // A generous ceiling makes these deterministic; fast tests still finish in ms,
    // so the only cost is a slower surfacing of a genuine hang.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
