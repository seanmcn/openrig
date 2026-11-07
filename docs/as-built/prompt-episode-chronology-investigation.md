# Prompt episode chronology investigation

Source examined: upstream/main `f5b62726ff759a857eeb76e2cbd654493fedba2f`.
Existing proposal: `da0e09f075b91fa2faa56c8d127766973947b579`.

## Contract and scope

The fallback regression should prove that routing an alert to a backup does not
erase the positive-clear boundary. The first alert must become terminal, one
new refusal must not alert, and two new refusals must produce a different alert
and exactly one additional wake. A subsequent tick must not wake again.

The watchdog selector in `packages/daemon/src/domain/queue-wake-ladder.ts`
finds the latest consecutive refusal run for each active job and target. A
non-refusal ends a run. A positively cleared prompt also ends it, independently
of fallback text already stored in the alert's resolution. The clear boundary
comes from the dedicated queue transition, not the ladder's injected `now`.
Manual closure and retirement because a job stopped are not positive clears.

History is sorted by `evaluated_at DESC, history_id DESC`. Only refusals strictly
newer than a clear transition count. A clear replaces the non-refusal anchor
only when its timestamp is strictly newer than that anchor. The episode key
names the boundary, so additional refusals do not generate new notifications.

The fixture's `Math.max(Date.now(), last + 1)` supplies distinct timestamps but
does not advance the clock used by queue transitions. At frozen time T, the
initial sent/refused/refused records are T, T+1, T+2, yet clearing writes T.
The clear is not newer than the sent anchor; subsequent refusals retain the
closed episode key. This is an impossible chronology for sequential observations
on a stable shared clock. It is not evidence that production deliberately dates
refusals into the future. Wall-clock rollback remains a separate possibility.

## Choice of fixture

Use explicit history timestamps for this scenario and fake only Date for the
queue writes. Real timer scheduling remains intact. The test is about durable
state transitions and notification counts, not elapsed-time deadlines, polling
cadence, or prompt detection. No sleeps or timeout changes are needed.

The earlier proposal's 10 ms steps preserve the basic fallback assertion, but
leave the original helper's independent clock in place and do not explain the
strict boundary. Explicit event times make the history under test reviewable.
A production clock-injection interface would be excessive for this test-only
change, and passing `now` to the ladder alone would not control queue writes.

## Separate proposed issue: prompt episode ordering loses causal order at timestamp ties

Millisecond equality is valid. It is not the same as synthetic future dating.
Two distinguishable sequences can have identical stored timestamps:

- refusal, then clear: the refusal must not count toward a new episode;
- clear, then refusal: the refusal belongs to the new episode.

The selector excludes both with `evaluated_at > cleared.at`. A refusal that
occurs after clearing in the same millisecond is therefore lost from the next
episode's count. With one further refusal at T+1, it still does not alert.
Changing `>` to `>=` would count pre-clear refusals and could falsely reopen
an episode. This cannot be solved by choosing a different inequality.

Separately, `WatchdogHistoryLog.record` uses ordinary `ulid()`, not a monotonic
factory. Same-millisecond ULIDs do not encode insertion order. A sent record
can sort ahead of two causally later refusals with the same `evaluated_at`,
making the selector see no current refusal run. A deterministic reproduction
can choose legal same-prefix ULIDs with descending suffixes in insertion order.

Proposed production work: establish what event is being ordered, then persist
an ordering boundary shared by refusal observations and positive-clear
observations. Test both orders of equal-time events and mixed-outcome history
ties. A history-only sequence or monotonic ULID does not by itself order
history against queue transitions. Retain timestamps for age calculations.

Production uncertainty: `WatchdogPolicyEngine.evaluate` captures `evaluatedAt`
before awaiting policy evaluation and delivery, then records the outcome later.
Consequently, insertion order alone may also misrepresent observation order
when delivery overlaps a clear. The separate watchdog and ladder schedulers
do not establish a shared causal sequence. Normal reminder cadence makes two
attempts from one job in one millisecond unusual; this investigation does not
establish a live occurrence or its frequency. The production prompt reader
also conservatively requires evidence strictly newer than a refusal, and this
test injects that reader. End-to-end hook ordering needs its own investigation.

## Proposed fixture PR description

Title: Make prompt clear-and-return fixtures deterministic without hiding timestamp ties.

The fallback prompt regression could miss the next episode because its history
helper advanced timestamps ahead of the clock writing the clear marker. Give
the scenario explicit history times and a controlled queue clock. Preserve
the terminal old alert and exact wake assertions, and test that one new refusal
is insufficient and the second creates a different alert without duplicate wakes.

This changes tests only. Timestamp ties remain a separately documented
production concern; this fixture correction does not resolve them. The direct
SQLite/ladder harness can exercise millisecond boundaries deterministically;
a real tmux/stub-agent scenario cannot reliably arrange those timings.

## Reproduction and validation

All executions used `testlock env -i PATH="$PATH" TMPDIR=/tmp` before the
command, with worktree-local dependencies, the repository's hermetic Vitest
setup, in-memory SQLite, and synthetic gateway credentials. No live daemon,
provider credentials, or `.env` link was used. Node 24.21.0, npm 11.19.0.

- Original fallback case with only Date frozen at `2030-01-01T00:00:00Z`:
  failed at the next-alert assertion, expected length 1, received 0.
- Adjacent “a prompt that clears and comes back between reminders” case with
  the same frozen Date: failed after just one new refusal, because an old
  synthetic future refusal was counted alongside it. Its fixture correction
  is a separate commit.
- The two tests in `prompt-episode-ordering.test.ts`, initially run as ordinary
  `it` tests, both failed at `expect(alerts()).toHaveLength(1)`, receiving 0.
  They are retained as `it.fails` with their intended assertions intact. To
  reproduce the red result, temporarily remove `.fails` and run that file.
  Expected failures are evidence of unresolved defects, not production fixes.
- `npm run build`: passed across all workspaces.
- `npm run lint`: passed across all workspaces.
- `npm exec -- vitest run packages/daemon/test/prompt-blocked-alert.test.ts`:
  122 passed after the fallback correction.
- Adjacent run: 7 files, 134 tests passed, including the two expected failures.
  Files: `prompt-episode-ordering`, `queue-wake-ladder`, `watchdog-history-log`,
  `watchdog-retention-ties`, `watchdog-policy-engine`, `watchdog-delivery-guarded`,
  and `watchdog-delivery-recovery` (all under `packages/daemon/test`, `.test.ts`).
- Final run after correcting the adjacent fixture: `prompt-blocked-alert` and
  `prompt-episode-ordering`, 124 tests passed, including two expected failures.
- `node scripts/check-docs-guard.mjs` and `git diff --check`: passed.

The full repository/package suite and native runtime scenarios were not run.
The focused harness proves queue/history selection and exact wake requests;
it does not prove live scheduler interleavings, hook freshness, or real prompt
resolution. No production files were changed.
