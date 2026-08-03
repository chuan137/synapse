# Phase 4.5 — Rev 5 refactor: dispatch to the watcher, rev to per-row debt

Companion to `synapse-spec.md` **rev 5** and `synapse-implementation-plan.md`.
Not a plan phase — a refactor between Phase 4 (done) and Phase 5 (not started),
taken now because every change here is invalidated or made expensive by
`prompts/manager.md` existing.

Repo state assumed: Phase 4 exit criteria met, `bun test` 51 pass / 0 fail,
`tsc --noEmit` clean, `notYetImplementedManagerTurn` still the placeholder in
`cli.ts`. Verify this before starting; if the tree has moved, stop and say so.

---

## 0. Answer these before writing code

Two are genuinely blocking. Do not guess — ask, and record the answers in the
summary at the end. Q1 is already settled and is stated here because it changes
`spawn.ts`, which no phase has touched since Phase 2.

**Q1 — SETTLED: dispatch is non-blocking, the manager turn is not.** (spec §4.4,
§4.5 layer 2)

Split `spawnSubtask` in two:

- **Claim, synchronous.** `Bun.spawn`, then one `BEGIN IMMEDIATE` writing
  `stage='assigned'` + `worker_session_id` + `worker_pid` together. Spawn first so
  no row is ever `assigned` with a NULL pid; if the write throws, kill the child.
  Synchronous matters because the cap must count correctly before the loop
  considers the next candidate.
- **Supervise, not awaited by the caller.** The existing exit handler, unchanged
  in behaviour: no reply landed → `stage='failed'` with exit code + stderr tail.
  Keep the in-flight promises in a `Set` so shutdown can drain or kill them
  instead of orphaning workers.

The manager turn (step 4) **stays awaited**. A worker runs for minutes and must
not stall the loop; a manager turn runs for seconds, and awaiting it keeps mutual
exclusion structural — `watchLoop` remains the sole sequential caller, per Phase 3
design point 1 — rather than resting on a `turnInFlight` flag. Do not change this
without raising it.

Accepted cost, already written into §4.5: a watcher that dies with workers in
flight loses their exit handlers; those rows fall to the layer-3 pid sweep, so the
row still ends `failed` but the exit detail is gone. Layer 3 stops being a
backstop and becomes load-bearing.

**Q3 — SETTLED: delivery is the watcher's, and there is no `ack`.** (spec §4.2)

The flag is `delivered`, not `reacted`, and the manager never writes it. The
watcher picks a batch, runs one turn carrying it, and writes `delivered=1` across
the whole batch **only if that turn completes** — one transaction, after the
turn, never per row as it proceeds. A turn that dies half-way delivers nothing
and the batch is carried again, mirroring how a failed turn leaves
`manager_turns` alone.

Consequences to hold on to while implementing:

- **`synapse ack` does not exist.** Do not add it. `synapse verdict` writes
  `verdict` and nothing else.
- **Delivery is not judgment.** Three of five judged still means five delivered.
  The two skipped are surfaced by an advisory NOTE (terminal, `delivered=1`,
  `verdict IS NULL`), not by re-delivery. This is deliberate: re-offering until
  the manager clears rows would let a model re-summon itself every poll forever.
- **`verdict` drives no control flow.** It is semantic only, which is why
  `verdict IS NULL` is allowed to be a fuzzy health signal.
- **All three cancellation sources are born `delivered=1`** (§4.6). `failSubtask`
  is not — assert this asymmetry in a test, because the two writes look
  symmetric in the code and the asymmetry is the point.

*Still open, and the only thing left in Q3:* whether to pull improvement-doc
issue 4's deadlock detector forward. It is now decoupled from everything above —
the wake loop needs no bound, and the "work finished but never declared done"
stall was eliminated at the source by making completion derived rather than
declared (§2.2). What remains for the detector is graph pathology: cycles,
dangling `depends_on` ids, anything where nothing runs, nothing is ready, and
rows stay non-terminal. Straight "now or its own pass" call. It would add run
status `stalled`, and C2 recreates the database anyway.

**Q2 — SETTLED: `synapse-spec.md` rev 5 is authoritative.**

All diffs land there. Note that `synapse-phase4-summary.md` cites `§9 #24–25` and
`D7` (per-role tool scope) and `synapse-phase0-findings.md` refers to a
`synapse-implementation-spec.md`; none of these exist in rev 5. Treat those
citations as stale references to a superseded document, **not** as decisions to
carry forward — but do not delete the Phase 4 tool-scope behaviour they describe,
which is live in `roles.ts`. If that behaviour needs a spec home, propose it as a
diff per rule 3.

Not blocking, but decide before Tier 2: §4.7 says a no-deps row gets a **fresh
worktree**; Phase 4's `resolveWorktreePath` gives it the **repo root**. Rev 5
demoted this from a correctness question to a "where does parallelism become
possible" question, so it can wait — but it is recorded in §4.7 and should not be
rediscovered.

---

## 1. What changed in the spec, and why each change exists

Read §4.2, §4.3, §4.4 in full before starting. Summary of intent:

| Change | Spec | Reason |
|---|---|---|
| Dispatch moves manager → watcher | §4.3, §4.4 | Readiness is a query, spawning is a subprocess call; neither needs judgment (principle 7). Dispatch leaves the critical path of a model turn and stops being forgettable after a compaction |
| Concurrency cap `--max-workers`, default 1 | §4.4 | Serialization was previously an accident of dispatch happening inside a single-threaded manager turn. Now a resource knob only — correctness at any value comes from the graph |
| Two writers off one tree = graph property | §2.3.1 | A runtime lock would be a second scheduler whose decisions are invisible in the tables (principle 1) |
| Dispatch **refuses** on worktree collision | §4.4 | A missing ordering edge is otherwise silent; its only symptom is two workers overwriting files. Refuse loudly, do not queue — queueing reintroduces the lock |
| Ready rows dispatched by ascending `id` | §4.4 | Hands priority back to the manager without a priority column or a dispatch veto. Also deterministic for tests |
| An open QUESTION does **not** pause dispatch | §4.4, §2.4 | A question blocks the manager's decision, not the run. Pausing would let one incidental clarification freeze every task. Row existence stays the single lever on dispatch |
| `rev` / `rev_counter` / `manager_reacted_rev` deleted | §4.2 | The mark was per-run, so a manager that judged 3 of 5 rows advanced past the other 2 — silent, permanent loss |
| Per-row `reacted` on `subtasks` + `messages` | §2.3, §2.4, §4.2 | Debt lives on the row that carries it. Mid-turn loss becomes impossible rather than something turn ordering must avoid |
| `synapse verdict` / `synapse ack` | §4.2, §5 | The controller writes `reacted`, never the manager. Makes "verdict set but unreacted" structurally impossible and keeps `verdict` purely semantic |
| Wake scans debt: operator messages first, then lowest-`id` task, batched | §4.2 | `messages` has no `task_id` and an ANSWER unblocks approval. Batching within a task is the unit judgment actually wants |

**What is deliberately NOT in this refactor**: improvement-doc issues 2
(`supersedes`/`attempt` + retry cap), 3 (cycle rejection at write time), and 4
(general stall detector, unless Q2 says otherwise). Do not build them. Do not
build any part of Phase 5.

---

## 2. Commits, in this order

### C1 — Dispatch moves to the watcher (no schema change)

Files: `watcher.ts` (real work), `queries.ts` (new reads), `cli.ts` (flag),
`tests/fakes/policy-manager.ts` (**shrinks**), `tests/watcher.test.ts`.

- `pollOnce` gains step 3 between cascade and wake. Order is sweep → cascade →
  dispatch → wake; §4.4 states which adjacencies are load-bearing and which is
  arbitrary — do not invent a reason for the arbitrary one.
- New reads in `queries.ts`: ready rows ordered by `id`; count of `assigned` rows
  for the run; whether a given `worktree_path` currently holds a live worker.
- `spawn.ts` splits per Q1. This is the first change to `spawn.ts` since Phase 2,
  so re-run `tests/spawn.test.ts` in full against the fakes — especially
  `liar.sh` and the 50-run invariant test, which are what prove the terminal
  write still always happens once supervision is no longer awaited.
- `--max-workers N` on `synapse watch`, default 1. Count from the table, not from
  watcher memory, so a restarted watcher re-derives it.
- Worktree collision → leave the row `unassigned`, write a NOTE naming both rows,
  retry next poll. Do not queue.
- `policy-manager.ts` loses its dispatch loop entirely; it should end up only
  judging. It is test code — shrinking it is the point, not a loss.

**Regression gate, non-negotiable.** After C1, re-run the full Phase 3 fake suite
and confirm it still passes **with zero model calls**. The improvement doc names
this as the first change that can quietly break that milestone, and that
milestone is what keeps judgment failures and plumbing failures distinguishable
for the rest of the build. If it breaks, fix it before C2 — do not carry it.

### C2 — Debt model (schema recreate)

Files: `schema.sql`, `db.ts` (`nextRev` deleted), `subtasks.ts`, `queries.ts`,
`watcher.ts`, `cli.ts`, and the tests listed in §3.

- Drop `runs.rev_counter`, `runs.manager_reacted_rev`, `subtasks.rev`,
  `messages.rev`. Add `delivered` (0/1) to `subtasks` and `messages`. §7 declares
  no migration; recreate the database.
- `nextRev()` disappears. **`BEGIN IMMEDIATE` does not** — `replySubtask` still
  reads the stage before writing it, so S0.5's finding stands unchanged. Keep
  `tests/begin-immediate.test.ts`.
- `cmdVerdict` in `cli.ts`, writing through `subtasks.ts` (row lifecycle writes
  live there per CLAUDE.md's ownership rule). It writes `verdict` only. There is
  no `cmdAck`.
- **The delivery write is watcher-owned** and belongs in `watcher.ts` alongside
  `manager_turns` and the sweep/cascade writes, per the Phase 3 ownership
  precedent. One transaction over the batch, after the turn resolves.
- `cancelSubtask` writes `delivered=1` alongside the cancel, for all three §4.6
  sources. `failSubtask` does **not** — assert this asymmetry explicitly.
- **`tasks.status` loses its `done` value**; completion becomes the `work_closed`
  column on `task_progress` (every subtask terminal **and** delivered). Remove
  any write of `tasks.status='done'`; `synapse done` gates on `work_closed`. The
  `delivered` clause is load-bearing — gating on `work_settled` alone closes the
  task the instant the last row finishes, before the manager has seen any of it.
- Wake condition becomes an undelivered scan, not a comparison. Batch selection
  per §4.2: undelivered operator messages first as one run-scoped batch;
  otherwise the lowest-`id` task and *all* of its undelivered rows.
- `ManagerTurnArgs` gains the batch. Write the debt query so it takes an optional
  `task_id` filter (`AND (:task_id IS NULL OR task_id = :task_id)`) — passing NULL
  gives "everything at once", passing a value gives per-task batching. Phase 5
  decides which is better on real judgment quality; making it a WHERE clause costs
  nothing now and keeps that decision open.

### C3 — Health signals

- **The skipped-row NOTE** (required by §4.2, ships here): rows that are
  terminal, `delivered=1`, and `verdict IS NULL` after some time → one NOTE
  naming them. Advisory only; it must not gate or re-trigger anything.
- **Deadlock detector** (improvement-doc issue 4) — only if Q3 pulls it forward:
  no row `assigned`, no row ready, some row non-terminal, no QUESTION awaiting an
  answer, for two consecutive polls → NOTE + run status `stalled`.

Do not build the rest of issue 4's proposal, and do not build issues 2 or 3.

---

## 3. Test disposition

This is the first change in the project that **deletes passing tests**. That is
correct here — they test mechanisms that no longer exist — but call it out
explicitly in the summary rather than letting the count drop silently.

**Delete**: `tests/rev.test.ts` (monotonicity under concurrent writers); the
mid-turn-loss and coalescing cases in `tests/watcher.test.ts`; any assertion on
`manager_turns` interacting with `manager_reacted_rev`.

**Keep unchanged**: everything in Phases 1, 2, 4 not touching rev —
`begin-immediate`, `readiness`, `done`, `reply-rejection`, `init` (minus the
"REQUEST at rev 1" assertion), `spawn.test.ts`, `hook-check.test.ts`.

**Add**, from §6:

- A ready row is spawned by the watcher with **zero manager wakes**.
- `--max-workers 1` holds; raising it does not let two rows sharing a
  `worktree_path` run together.
- Ready rows above the cap dispatch in ascending `id`.
- A worktree collision is **refused, not queued**: row stays `unassigned`, a NOTE
  names both rows, and adding the missing edge lets the next poll proceed.
- An unanswered QUESTION does **not** stop dispatch.
- **The two that matter most**, because they define delivery's boundary:
  a turn killed after one verdict delivers **nothing** (whole batch still
  `delivered=0`, next wake carries all of it); and a turn that *completes* having
  judged 3 of 5 delivers **all five** (the other two are not re-offered, and the
  health NOTE names them). If only two new tests get written carefully, make them
  these.
- Operator messages are scanned ahead of task work.
- Tasks taken in ascending `id`; a task with no undelivered rows is skipped.
- The manager has no verb that writes `delivered`.
- A worker death and its dependents' cancellations land in the same poll,
  producing one wake rather than two.
- The poll loop keeps working while a worker runs: with a long-running fake in
  flight, a sweep, a cascade and a manager wake all still occur.
- A watcher killed with a worker in flight leaves that row to the layer-3 sweep —
  it still ends `failed`, with exit detail absent rather than the row stuck.
- **Do not** assert strict process-level serialization at `--max-workers 1`. The
  cap counts `assigned` rows, so a worker that has committed `done` and not yet
  exited is uncounted and its successor may start a few hundred milliseconds
  early (§4.10). Assert on row stages, not on process counts, or the test is
  flaky by construction.

Note the old §6 claim "a doomed row is cancelled rather than spawned" was
**vacuous** — such a row is never ready — and has been removed from the spec. Do
not write it.

---

## 4. Exit criteria

- `bun test` green, `tsc --noEmit` clean, `bun build --compile` verified against a
  real binary (not just source — Phase 1 found a `$bunfs` bug that passed every
  unit test).
- **The Phase 3 zero-model-call end-to-end still passes**, with dispatch now
  coming from the watcher instead of `policy-manager.ts`.
- The partial-batch test above passes.
- `PHASE` file updated.
- A `synapse-phase4.5-summary.md` written in the style of the existing phase
  summaries: what's built, exit criteria → tests, design points settled during
  implementation, what's not started. Include the Q2/Q3 answers and, explicitly,
  the list of deleted tests and why.

---

## 5. Standing rules for this work

- **Rule 3 applies throughout**: where the spec is silent or contradicts itself,
  propose a diff and get it approved *before* writing code — do not resolve it
  silently. Phase 4 found two real bugs this way and both were spec-corrected
  first.
- **Do not build ahead of the phase** (rule 5). Issues 2/3/4 and all of Phase 5
  are out of scope even where the code path is obviously nearby.
- File ownership per CLAUDE.md: `queries.ts` never writes; subtask row lifecycle
  writes live in `subtasks.ts`; watcher bookkeeping and the sweep/cascade/dispatch
  writes live in `watcher.ts`.
- Do not trust `exit 0` from `claude -p` as proof of anything (S0.1, S0.3). Not
  directly exercised in this refactor, but the wrapper changes in Q1 sit right on
  top of it.
