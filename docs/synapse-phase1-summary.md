# Phase 1 Summary — Schema and the pure data layer

Companion to `synapse-spec.md` rev 3 and `synapse-implementation-plan.md`.

**Status: exit criteria met.** `bun test`: 32 pass / 0 fail (110 assertions).
`tsc --noEmit`: clean. `bun build --compile` verified against a real binary,
not just source.

## What's built

| File | Purpose |
|---|---|
| `src/schema.sql` | 4 tables (`runs`, `tasks`, `subtasks`, `messages`) + `task_progress` view + indexes — spec §2, verbatim |
| `src/db.ts` | `openDb` (WAL, busy_timeout=5000, foreign_keys=ON), `tx()` (`BEGIN IMMEDIATE` only), `nextRev()` |
| `src/subtasks.ts` | Every rev-assigning write: `initRun`, `createSubtask`, `replySubtask`, `failSubtask`, `cancelSubtask`, `closeRun` |
| `src/queries.ts` | Read-only: `readySubtasks`/`isSubtaskReady` (`json_each`, no TS-side filtering), `cascadeCandidates`, `taskProgress`, `runIsDone`, `statusView` |
| `src/cli.ts` | Verbs: `init`, `task`, `reply`, `status`, `done` |
| `src/text-imports.d.ts` | Type declaration enabling the build-time `.sql` text import |

No `spawn.ts`, `watcher.ts`, prompts, or hooks — out of scope, not stubbed.

## Exit criteria → tests

- **rev monotonicity** — sequential and genuinely concurrent (separate
  connections, one file) writers; no gaps, no duplicates
  (`tests/rev.test.ts`).
- **rev discipline** — worker/operator writes assign a rev; manager writes
  (`createSubtask`) never do.
- **readiness** — single/multi-dep, non-done dep, failed/cancelled dep,
  already-terminal row; all via `json_each`, none via TS filtering
  (`tests/readiness.test.ts`).
- **`work_settled`** false for a zero-subtask task; two-level `done` gate
  (view + declared `tasks.status`) (`tests/done.test.ts`).
- **`reply` rejection** against terminal rows, row left byte-for-byte
  unchanged, rev counter not bumped (`tests/reply-rejection.test.ts`).
- **`init` shape** — `manager_turns=0`, generated `manager_session_id`, one
  REQUEST at rev 1, one task linked by `source_message_id`
  (`tests/init.test.ts`).
- **`BEGIN IMMEDIATE` is load-bearing** — a hand-rolled deferred transaction
  is shown to actually deadlock with `SQLITE_BUSY` on lock upgrade under a
  concurrent writer; `tx()` does not (`tests/begin-immediate.test.ts`).
- **CLI-level** coverage of all five verbs through `dispatch()`, not just
  the library functions (`tests/cli.test.ts`).

## Two things surfaced, not silently resolved

1. **Spec ambiguity on `reply` rejection scope.** §4.6 names only
   `cancelled`/`failed`; §6 ("no field overwritten by a second worker") and
   the plan's Phase 2 `liar.sh` case require a second reply into an
   already-`done` row to be rejected too. Rejection was extended to all
   three terminal stages, documented inline in `subtasks.ts` — worth
   confirming before Phase 2 locks in `liar.sh`.
2. **Compiled-binary bug, caught only by testing the actual binary.**
   `import.meta.url` + `readFileSync` for the schema works under
   `bun test` but breaks under `bun build --compile` (no real filesystem
   path in `$bunfs`). Fixed with a build-time
   `import schemaSql from "./schema.sql" with { type: "text" }`. This
   would have passed every unit test and failed silently the first time a
   worker or hook invoked the compiled CLI.

Not started: Phase 2 (spawn wrapper, failure guarantee, fakes).
