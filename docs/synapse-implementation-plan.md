# Synapse — Implementation Plan

Companion to `synapse-spec.md` rev 3. New repository, no migration.

---

## 0. Organizing idea

**Fake the agents until the plumbing is proven.**

Almost every claim in spec §6 — rev semantics, readiness, cascade, failure
capture, done-gating, wake coalescing — is about the *controller*, not about
model behavior. Those are testable with fake workers: shell scripts that reply,
or exit without replying, or hang until killed. Deterministic, instant, free.

Real models enter at Phase 4. Everything before that is a normal SQLite program
with a subprocess wrapper, and the fake-worker harness built in Phase 1 stays as
the regression suite forever.

Consequence for ordering: the expensive, non-deterministic, prompt-engineering
work (the manager) comes **last**, on top of a substrate already known to be
correct. When the manager misbehaves you will know it is the manager.

---

## Pre-flight: status

Spec **rev 3** already carries every correction this plan surfaced — the
persistent-session fix, the "board" retirement, the `synapse status` collapse,
plan approval as a QUESTION, process-group kill, and `BEGIN IMMEDIATE`. See spec
§9 (changes 13–19) and §10 (decisions D1–D6).

One item still needs verification rather than editing:

- Confirm §4.5's Stop-hook layer against the installed Claude Code hook contract
  before relying on it (spike S0.3). The wrapper covers it either way.

---

## Phase 0 — Spikes (throwaway, no repo structure)

Purpose: kill the design early if a primitive does not behave. Nothing here is
kept.

| # | Spike | Pass condition |
|---|---|---|
| S0.1 | `claude -p --session-id <uuid> "<task>"` with tools allowed | edits a real file, runs a real tool loop, exits 0, in one invocation |
| S0.2 | `claude -p --resume <uuid>` on an exited session | rehydrates context, answers a follow-up that requires memory of turn 1 |
| S0.3 | Stop hook | fires on turn end; can block the stop and force another turn; know the exact JSON contract |
| S0.4 | `Bun.spawn` kill semantics | spawn a worker in its own process group; `kill -9` the group mid-tool-call; parent observes exit, tool subprocesses die too, no orphans on the worktree |
| S0.5 | `bun:sqlite` WAL, 4 read-then-write writers + 1 reader | with `BEGIN IMMEDIATE` + `busy_timeout=5000`, no `SQLITE_BUSY` escapes and no deadlock; reader never blocked. Also confirm the deferred-transaction version *does* fail, so the test proves the pragma matters |
| S0.6 | Transcript growth | measure turn latency and cost at ~10 and ~50 manager turns; establishes the verbosity budget from pre-flight #1 |

**Exit:** S0.1–S0.3 pass. If S0.2 fails, the whole persistent-manager design is
wrong and must be replaced by a manager that reconstructs from the tables every
turn (which, given the stateless-turn contract, is a smaller change than it
sounds — worth knowing that the fallback exists).

**Stop if:** S0.1 fails. There is no system without it.

**Reconsider D1 if:** S0.4 shows `Bun.spawn` cannot manage process groups
cleanly. The wrapper is the one place where process control is load-bearing;
everything else in the controller is SQLite and argument parsing.

---

## Phase 1 — Schema and the pure data layer

No processes, no agents. Just tables and queries.

```
src/
  schema.sql          # 4 tables + task_progress view + indexes
  db.ts               # open, pragmas, tx() [BEGIN IMMEDIATE], nextRev()
  subtasks.ts         # row lifecycle WRITES: create, dispatch, reply, fail, cancel
  queries.ts          # derived READS only: readiness, cascade candidates,
                      #   task rollup, render for `synapse status`
  cli.ts              # verb dispatch; only DB-touching verbs
tests/
  fakes/              # fake worker scripts (used from Phase 2 on)
```

The read/write split is deliberate. `queries.ts` never writes, so every
rev-assigning write lives in `subtasks.ts` — one file to audit for the
`BEGIN IMMEDIATE` and rev-assignment rules. Cascade splits across the line
cleanly: detection is a derived read, the cancel is a write, the watcher
composes them.

Build:
- `schema.sql` exactly as spec §2, including `task_progress`.
- `nextRev(runId)` — counter bump + return, **inside** the caller's transaction,
  never its own.
- Readiness query: `stage='unassigned' AND every id in depends_on is done`.
  Use `json_each` in SQL rather than parsing the array in TS — keeps readiness a
  single queryable fact, which is what makes it recomputable post-compaction.
- `synapse init --goal "<text>"`, `synapse task`, `synapse reply`,
  `synapse status`, `synapse done`. `init` is the phase's entry point: it writes
  the run, first REQUEST, and first task, and starts nothing — which is what
  makes every other Phase 1 test able to stand up a run without a watcher.
- `bun build --compile` target from day one; the binary is what workers and hooks
  invoke.

**Exit criteria (all as unit tests, no subprocesses):**
- rev is strictly monotonic under concurrent writers.
- A rev is assigned by worker/operator writes and *not* by manager writes.
- Readiness respects `depends_on`; a row with a non-done dep is never ready.
- `task_progress.work_settled` is false for a zero-subtask task.
- `synapse done` blocks while any subtask is non-terminal; allows when all are
  terminal including `cancelled`.
- `synapse reply` against a `cancelled` or `failed` row is rejected.
- `synapse init` produces a run with `manager_turns=0`, a generated
  `manager_session_id`, one REQUEST, and one task linked by `source_message_id`.

**Stop if:** the rev-inside-transaction pattern turns out to need a global lock.
That would mean rethinking the counter's home.

---

## Phase 2 — Spawn wrapper and the failure guarantee

Still no real models. Fakes only.

Build `src/spawn.ts`:
- generate session UUID, write `worker_session_id` + `worker_pid`, stage →
  `assigned`
- `Bun.spawn` the child in its **own process group**, await `proc.exited`
- on exit: if no reply landed → `stage='failed'`, `result_summary` = exit code +
  stderr tail, assign rev

Own process group matters: cancellation (§4.6) must kill the worker *and* any
tool subprocesses it started, or a killed row leaves orphans holding the
worktree. Kill the group, not the pid.

Fakes in `tests/fakes/`:
- `good.sh` — sleeps, calls `synapse reply`, exits 0
- `silent.sh` — exits 0 without replying
- `crash.sh` — exits 1 with stderr
- `hang.sh` — sleeps forever (for kill/sweep tests)
- `liar.sh` — calls `synapse reply` twice (idempotency check)

**Exit criteria (spec §6's three-way failure test):**
- `silent.sh` → row ends `failed`, rev assigned.
- `crash.sh` → row ends `failed`, stderr captured in `result_summary`.
- `hang.sh` + `kill -9` the *wrapper* → row still ends `failed` (requires the
  Phase 3 sweep; write the test now, mark expected-fail until then).
- `liar.sh` → second reply rejected, row unchanged.
- **Invariant test:** across 50 randomized fake runs, no row is ever left in
  `assigned` with a dead pid and no terminal write.

---

## Phase 3 — Watcher, with a scripted manager

The wake loop, proven without a model. `tests/fakes/policy-manager.ts` is a
deterministic stand-in: reads the tables, writes verdicts, dispatches every ready
row. It does what a manager does, minus judgment.

Also build the two process-side verbs Phase 1 deliberately left out:
`synapse watch --run R` (attach to an existing run) and `synapse start --goal`
(= `init` then `watch`).

Build `src/watcher.ts`:
- poll: `max(rev) > manager_reacted_rev` across subtasks + messages
- cancel-cascade rows whose deps are terminal-but-not-done
- pid sweep: `assigned` + dead pid → `failed`
- read `rev_seen` **before** the turn, write the mark **after**
- single-threaded; sole spawner of manager turns

**Exit criteria — the three semantics bugs rev 2 exists to prevent:**
- *Mid-turn loss:* inject a fake worker reply while the scripted manager turn is
  running; assert it is reacted to on the next poll.
- *Coalescing:* 5 transitions during one turn → exactly 1 follow-up wake.
- *Mutual exclusion:* under a flood of transitions, never two manager processes
  alive (assert via pidfile or process count sampling).
- *First turn:* wake 1 uses `--session-id`, wake 2 uses `--resume`, driven by
  `manager_turns`; a turn that fails before completing leaves the counter alone
  and the next wake retries session creation.
- *Watcher restart:* kill the watcher, let a fake worker reply while it is down,
  restart with `synapse watch --run R`, assert the transition is reacted to.
- *Cascade:* fail a coder row, assert its reviewer and tester rows go
  `cancelled` with the right `cancel_reason`, and `synapse done` unblocks.
- End-to-end with fakes only: one task, coder → reviewer → tester rows, all
  `done`, task settled — **zero model calls**.

That last test is the real milestone. At this point the system works; only
judgment is missing.

---

## Phase 4 — Real workers, no real manager

Introduce models on the cheap side first.

- Write `prompts/coder.md`. Contract: read your row, read your subject's
  artifact, do the work, call `synapse reply`, stop.
- Install the Stop hook (S0.3 contract).
- Keep `policy_manager.py` driving.
- Add `reviewer.md`, `tester.md`, `doc_writer.md`.

**Exit criteria:**
- A real coder completes a small real change and replies correctly.
- The Stop hook catches a worker that tries to finish without replying (force it
  by writing a prompt that invites a prose-only ending).
- A reviewer reads its subject's artifact and produces a usable verdict input.
- Worktree inheritance: reviewer sees exactly the coder's tree.

**Watch for:** workers that narrate instead of writing to their row. That is the
single most likely real-world failure and the hook is the fix.

---

## Phase 5 — The real manager

The hard part, deliberately last.

- `prompts/manager.md`. Opens with the standing instruction: run
  `synapse status --run <id> --json` before deciding anything; the tables are
  authoritative.
- Plan step: write spec/plan/testplan docs, ask for approval, then materialize
  rows **with their dependency edges** in one go.
- Judge step: one verdict per newly-terminal row, then dispatch ready rows.
- Verbosity budget from pre-flight #1: short verdicts, detail to artifacts.

**Exit criteria:**
- Compaction test: force a compaction, then assert the next turn's dispatch
  matches the tables (not a remembered plan). This is the §4.9 claim and it is
  the one most likely to fail quietly.
- The manager materializes a coherent dependency graph, not a flat list.
- A failed row produces a sensible replacement row rather than a stall.
- No wake loop: the manager's own writes never re-trigger it.

**Stop if:** decomposition quality is poor across several tasks. No amount of
plumbing fixes a bad manager, and this is the phase where you find out.

---

## Phase 6 — Operator channel

- `request` / `ask` / `answer` / `say`, one verb per type.
- Rejections for illegal shapes.
- `synapse status` — CLI view first; web UI is optional and later.

**Exit criteria:**
- `request` creates a task; `say` does not.
- A follow-up goal mid-run is planned under a new task without disturbing the
  first.
- A blocking QUESTION halts dispatch and an `answer` resumes it.

---

## Phase 7 — The trial (this is a gate, not a phase)

Run one real `kit3588-plan` task through serial Tier 1, end to end. Compare
against doing the same task yourself in a single Claude Code session.

Record: wall-clock, token cost, your own intervention count, and whether the
record afterwards is one you would actually want to keep.

**Proceed to Tier 2 only if** quality is at parity or better *and* the record has
standalone value. If serial Synapse loses on quality, parallelism does not
rescue it — it produces bad decompositions faster.

---

## Phase 8 — Tier 2+ (only past the gate)

- Parallel workers, one git worktree per dependency-root row. Real feature, own
  validation: two coders, no interference, reviewer sees the right tree.
- Web UI over the run state.
- Optional instrumentation: log plan-survival — how many materialized rows
  complete as planned vs. get cancelled or superseded by on-the-fly rows. That
  is the same granularity question `grain` is chasing, on a minutes-long feedback
  loop instead of a weeks-long one. Cheap to add here, hard to get anywhere else.

---

## Decisions (settled)

| # | Decision |
|---|---|
| D1 | **TypeScript on Bun.** Continuity with the existing implementation; `bun:sqlite` is synchronous and ships JSON1; `bun build --compile` yields a single binary; ~15ms cold start matters because the CLI is invoked on every worker turn end and every hook fire. |
| D2 | **Per-repo state.** `.synapse/synapse.db` in the target repo. Worktree paths stay relative; no cross-repo run collisions. |
| D3 | **Artifacts at `.synapse/artifacts/task-<id>/{spec,plan,testplan}.md`.** Hardcoded in the manager prompt and in `synapse doc`. |
| D4 | **Plan approval is a QUESTION.** No `synapse approve` verb. One fewer concept, and approval lands in the message log with its options intact. |
| D5 | **Per-role model defaults in the controller**, overridable with `--model`. Manager and reviewer get the stronger model. |
| D6 | **One read verb: `synapse status [--run R] [--json]`.** `synapse board` is gone. It and `status` were the same read at two verbosities — the manager's machine read and the operator's human render. `--json` picks which. |

### D1 consequences — Bun/SQLite specifics

- **`BEGIN IMMEDIATE` for every writing transaction.** A deferred transaction
  that starts by reading and later writes must upgrade its lock; two of those
  concurrently deadlock, and `busy_timeout` does *not* rescue an upgrade — it
  returns `SQLITE_BUSY` immediately. Every rev-assigning path reads (check stage)
  then writes (set stage + bump counter), so this is the common case, not an edge
  case. Wrap `tx()` around `BEGIN IMMEDIATE` and never expose a deferred one.
- Pragmas at every open: `journal_mode=WAL`, `busy_timeout=5000`,
  `foreign_keys=ON`. WAL persists on the file; the other two are per-connection.
- `bun:sqlite` is synchronous, so `tx()` is a plain function — do not make the DB
  layer async. Async transactions over SQLite are a reliable source of
  interleaving bugs.
- Liveness sweep: `process.kill(pid, 0)` throws `ESRCH` if gone. Cheap enough to
  run every poll.
- The Stop hook is a TS script invoking the compiled binary, not a separate
  runtime. Keep it under ~20ms; it is in the worker's critical path.

### D4 consequence — what "approved" means mechanically

The manager asks a QUESTION with `options` (approve / revise / cancel), then
stops. Dispatch is blocked because no rows exist yet. The operator's `answer`
assigns a rev, which wakes the manager, which materializes the plan's rows.
No approval state is stored on `tasks` — the answered QUESTION *is* the record,
and the existence of subtask rows is the observable consequence.

---

## Risk register

| Risk | Phase it surfaces | Mitigation |
|---|---|---|
| `--resume` on an exited session does not rehydrate | 0 | Fallback: fully stateless manager, reconstructing from the tables each turn |
| `Bun.spawn` signal/process-group handling is incomplete | 0 (S0.4) | Spike it explicitly; fallback is Node `child_process` for the wrapper only, or a small `setsid` shim |
| Deferred-transaction upgrade deadlock under concurrent writers | 1 | `BEGIN IMMEDIATE` everywhere; the 4-writer test in S0.5 must exercise read-then-write, not write-only |
| Stop hook contract differs from assumption | 0 | Wrapper (§4.5 layer 2) is unconditional and covers it |
| Workers narrate instead of writing to their row | 4 | Hook + prompt contract + wrapper failure capture |
| Manager decomposes badly | 5 | Nothing structural — this is the real project risk |
| Transcript growth makes manager turns slow/expensive | 5 | Verbosity budget; measured in S0.6 |
| Babysitting cost exceeds the work saved | 7 | The gate exists to catch this |
| Second-system creep vs. the Manila bus | throughout | Non-goals list in spec §7; treat additions as needing the same scrutiny |

---

## Sequencing summary

```
0  spikes              — no repo
1  schema + queries     — no processes        ← unit tests only
2  spawn + failure      — fakes               ← failure guarantee proven
3  watcher              — fakes + scripted mgr← FULL LOOP, ZERO MODEL CALLS
4  real workers         — real coder/reviewer
5  real manager         — the hard part
6  operator channel
7  TRIAL GATE           — real task vs. baseline
8  parallel + UI        — only past the gate
```

The line worth defending: **Phase 3 ends with a complete working system that has
never called a model.** If that is not true, judgment failures and plumbing
failures will be indistinguishable for the rest of the build.
