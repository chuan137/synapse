# Phase 4.5 — Summary

Refactor between Phase 4 (done) and Phase 5 (not started). Three commits, all
on `main`. No prompts written, no model calls made.

---

## What's built

### C1 — Dispatch moves to the watcher (`spec §4.3, §4.4`)

`spawn.ts` split into a synchronous claim (`claimSubtask`) and an async
supervision registered in `inFlightSupervisions`. The poll loop calls
`claimSubtask` and returns immediately; supervision writes `stage=failed` if
no reply landed, unconditionally. `spawnSubtask` remains as an awaited wrapper
for `synapse spawn` (manual operator invocation) and tests.

`watcher.ts` gains step 3 (dispatch) between cascade and wake. `dispatchReady`
enforces the `--max-workers` cap (from `assignedCount`, a table query — not
watcher memory), dispatches ready rows in ascending `id` order, and refuses on
worktree collision with an advisory NOTE. `DispatchFn` is injected by the
caller so tests can use fakes without the watcher knowing about roles.

`queries.ts` gains `assignedCount` and `liveWorkerOnWorktree` for the dispatch
step.

`policy-manager.ts` loses its dispatch loop entirely — it judges only now.
That is the point of the move.

Accepted cost (§4.5 deliberate): a watcher that dies with workers in flight
loses their supervision promises. Those rows stay `assigned` until the
layer-3 pid sweep catches them. Layer 3 is no longer a backstop — it is
load-bearing for this scenario.

### C2 — Debt model (`spec §4.2`)

`schema.sql`: drop `runs.rev_counter`, `runs.manager_reacted_rev`,
`subtasks.rev`, `messages.rev`. Add `delivered INTEGER NOT NULL DEFAULT 0` to
`subtasks` and `messages`. `task_progress` view gains `work_closed` (every
subtask terminal **and** `delivered=1`), which becomes the gate for
`synapse done` — `work_settled` alone would close too early, before the manager
has been shown the batch.

`subtasks.ts`: `replySubtask` and `failSubtask` write `delivered=0` (judgment
required). `cancelSubtask` writes `delivered=1` for all three cancellation
sources (all mechanical — §4.2 "writes that are born delivered"). `verdictSubtask`
added — writes `verdict` only, never touches `delivered` (§7: no `ack` verb).
`nextRev` removed; `BEGIN IMMEDIATE` unchanged (`replySubtask` still reads
stage then writes it — S0.5 finding stands).

`queries.ts`: `nextDebtBatch` replaces `maxRev`/`setReactedRev`. Scan order
per §4.2: undelivered operator messages first (run-scoped, `messages` has no
`task_id`); otherwise the lowest-`id` task with undelivered terminal subtask
rows, all of them.

`watcher.ts` step 4: `nextDebtBatch` selects the batch before the turn runs.
If the turn completes, `deliverBatch` writes `delivered=1` across the whole
batch in one transaction. If the turn throws, nothing is delivered and the
batch is carried again on the next poll — exactly parallel to how `manager_turns`
is left alone when a turn fails.

`cli.ts`: `cmdVerdict` added (`synapse verdict`). `cmdReply` no longer returns
a rev.

### C3 — Health signals (`spec §4.2`)

`watcher.ts`: `writeSkippedRowNote` runs after every successful `deliverBatch`.
Finds rows that are terminal, `delivered=1`, and `verdict IS NULL` — rows the
manager was shown but did not judge. Writes one advisory `NOTE` naming their
ids. No gating, no re-triggering.

---

## Exit criteria → tests

| Claim (spec §6) | Test |
|---|---|
| Ready row dispatched with zero manager wakes | `watcher.test.ts` — dispatch describe |
| `--max-workers 1` holds; second row waits | dispatch describe |
| Ready rows above cap dispatched by ascending `id` | dispatch describe |
| Worktree collision refused, NOTE written, edge resolves it | dispatch describe |
| Open QUESTION does not stop dispatch | dispatch describe |
| Poll loop works while worker in flight | C3 describe |
| Watcher killed with worker in flight → layer-3 sweep, exit detail absent | C3 describe |
| Worker death and cascade in same poll → one wake | C3 describe |
| Crashed turn delivers nothing; batch re-offered | C3 describe |
| Completed turn delivers all 5 judged or not; health NOTE names unjudged 2 | C3 describe |
| `failSubtask` never born delivered; `cancelSubtask` always born delivered=1 | C3 describe |
| `verdictSubtask` does not touch `delivered` | C3 describe |
| Operator messages scanned ahead of task work | delivery describe |
| Tasks taken in ascending `id`; zero-debt task skipped | delivery describe |
| Mid-turn reply stays `delivered=0`; carried on next poll | mid-turn/coalescing describe |
| 5 transitions during one turn → exactly 1 follow-up wake | mid-turn/coalescing describe |
| Mutual exclusion: watchLoop never starts second turn before first resolves | mutual exclusion describe |
| First wake `isFirstTurn=true`; failed turn leaves counter alone | first-turn describe |
| Watcher restart: transition while down is reacted to after restart | restart describe |
| CASCADE: failed coder → reviewer + tester cancelled with right reason | cascade describe |
| BEGIN IMMEDIATE still required (read-then-write) | `begin-immediate.test.ts` |
| `synapse done` gates on `work_closed` (terminal + delivered) | `done.test.ts` |

---

## Deleted tests

`tests/rev.test.ts` — 4 tests. The mechanism they tested (`rev_counter`,
`manager_reacted_rev`, per-row `rev`) no longer exists. The invariant they
proved — that concurrent writers do not corrupt each other — is now tested
indirectly through `begin-immediate.test.ts` (which was rewritten to use
`replySubtask`'s read-then-write path instead of `nextRev`).

The mid-turn-loss and coalescing tests in `watcher.test.ts` were rewritten:
the old versions asserted on `manager_reacted_rev` columns; the new ones
assert on `delivered` flags.

---

## Q2/Q3 answers

**Q2** (settled before work started): `synapse-spec.md` rev 5 is authoritative.
Phase-summary citations (`§9 #24-25`, `D7`, `synapse-implementation-spec.md`)
are stale references to superseded documents; the live behaviour they describe
(per-role tool scope) remains in `roles.ts` and is correct.

**Q3** (settled): delivery is the watcher's, there is no `ack` verb, and
`synapse verdict` writes `verdict` only. The deadlock detector (improvement-doc
issue 4) was not pulled forward — the "work finished but never declared done"
stall was eliminated at the source by making completion derived (`work_closed`),
so the remaining detector scope is graph pathology (cycles, dangling edges).
Deferred to Phase 5 or later if it actually shows up.

---

## Design points settled during implementation

**`delivered` only covers terminal subtask rows in the debt scan.** A freshly
created `unassigned` row has `delivered=0` but carries no delivery obligation —
only terminal stages (done/failed/cancelled) do. `nextDebtBatch` filters for
`stage IN ('done','failed','cancelled')`. This was not explicitly stated in the
spec and was discovered when the "zero manager wakes" test kept waking the
manager after a subtask was created.

**The worktree collision guard requires `maxWorkers ≥ 2` to be visible when
testing two rows sharing a path.** With `maxWorkers=1`, the cap check breaks
the loop before the second row is even considered, so no collision is detected.
The collision is a real guard for `maxWorkers > 1`; at the current default of 1
it is never triggered in practice (the cap stops dispatch first).

**`dispatchFn` is injected rather than defaulted.** There is no sensible
default command for a ready row — the command depends on role, model, and prompt
which only the CLI layer knows. The watcher silently skips dispatch when no
`dispatchFn` is provided, which is the right behaviour for wake-only tests. The
CLI will wire the real `claimSubtask`-based `DispatchFn` in Phase 5 when
`cmdWatch` is exercised end-to-end with real workers.

**`pidSweep` calls `failSubtask` directly rather than opening its own `tx()`.**
`failSubtask` opens `BEGIN IMMEDIATE` internally; a wrapping `tx()` in
`pidSweep` would produce a nested `BEGIN IMMEDIATE`, which SQLite rejects.

---

## What's not started

Phase 5: `prompts/manager.md`, the real `claude -p --session-id`/`--resume`
manager turn function wired into `cmdWatch`, and the compaction test.

The `DispatchFn` injection point in `cmdWatch` is a stub (`notYetImplementedManagerTurn`
still throws). Phase 5 replaces both.

§4.7 worktree divergence (repo-root vs. fresh worktree for no-deps rows) is
recorded in spec §4.7 and deferred to Tier 2 / Phase 8. It is not a
correctness question at `--max-workers 1`.
