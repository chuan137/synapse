# Phase 2 Summary — Spawn wrapper and the failure guarantee

Companion to `synapse-spec.md` rev 3 and `synapse-implementation-plan.md`.

**Status: exit criteria met.** `bun test`: 38 pass / 0 fail (176 assertions,
including Phase 1's 32). `tsc --noEmit`: clean. `bun build --compile` verified
against a real binary with `spawn.ts` bundled in.

## What's built

| File | Purpose |
|---|---|
| `src/spawn.ts` | `spawnSubtask`: dispatch write (stage `unassigned` → `assigned`, no rev), `Bun.spawn` in its own process group, guaranteed terminal write on exit if no reply landed (§4.5 layer 2) |
| `tests/fakes/*.sh` | `good.sh`, `silent.sh`, `crash.sh`, `hang.sh`, `liar.sh` — per plan Phase 2 |
| `tests/spawn.test.ts` | Exercises `spawnSubtask` against the fakes as real subprocesses, through a real compiled binary |
| `tests/helpers.ts` | `synapseBin()` — compiles the CLI once per test run into `TMPDIR`, never into the repo; `FAKES_DIR` |
| `PHASE` | Added — was missing; now reads "Phase 2 — Spawn wrapper and the failure guarantee" |

No CLI verb added. `synapse spawn <role> <subtask-id>` (spec §5) needs
role→prompt resolution, which the plan places in Phase 4 (`prompts/coder.md`
etc.). The plan's own Phase 2 file list has no `cli.ts` changes — `spawnSubtask`
stays a library function, called directly by tests, matching the plan's
description of `src/spawn.ts` as a standalone wrapper module tested against
fakes. Wiring it to a CLI verb ahead of role prompts existing would be building
ahead of phase (rule 5).

## Exit criteria → tests

- **`silent.sh`** → row ends `failed`, rev assigned (`tests/spawn.test.ts`).
- **`crash.sh`** → row ends `failed`, stderr tail captured in `result_summary`.
- **`hang.sh` + kill the wrapper** → row still ends `failed`: written as
  `test.failing`, per the plan's instruction to write this test now and mark
  it expected-fail until the Phase 3 sweep exists. It currently fails (proving
  nothing sweeps an orphaned `assigned` row yet), which `test.failing` turns
  into a pass — the moment Phase 3's pid sweep makes it pass for real,
  `test.failing` will start failing the suite, which is the intended tripwire.
- **`liar.sh`** → second reply rejected by `replySubtask` itself; the wrapper
  sees the row already `done` and does not override it.
- **Invariant test** — 50 randomized fake runs (`good`/`silent`/`crash`/`liar`
  picked at random): every row ends in `done` or `failed`, never left in
  `assigned`.
- `good.sh` (not in the plan's required list, added for a baseline
  reply-lands-cleanly case) confirms the wrapper does *not* touch a row that
  already got a valid reply.

## Design points settled during implementation

1. **How a fake worker finds the DB and its subtask id.** Not specified by the
   plan or spec at the process-boundary level. Resolved by env vars the
   wrapper sets at spawn: `SYNAPSE_BIN` (path to the compiled binary) and
   `SUBTASK_ID`. The worker's `cwd` is the repo root, so `synapse reply`
   resolves `.synapse/synapse.db` through the same relative-path convention
   `getDb()` already uses — no new DB-location mechanism invented.
2. **`markAssigned` does not assign a rev.** Confirmed against spec §4.2's
   explicit list: dispatch (`stage → assigned`) is not in "writes that assign
   a rev." Only the terminal failure write (`stage → failed`) goes through
   `failSubtask`, which does assign one.
3. **Compiled test binary lives in `TMPDIR`, not the repo.** `bun build
   --compile` output is 60MB+; `tests/helpers.ts::synapseBin()` compiles once
   per test run and caches the path, mirroring the existing pattern of
   file-backed test DBs in `TMPDIR` (`rev.test.ts`, `begin-immediate.test.ts`).

## Not started

Phase 3 (watcher, scripted manager, pid sweep, cascade, wake coalescing).
`hang.sh`'s sweep case stays `test.failing` until then.
