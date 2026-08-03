# Phase 3 Summary — Watcher, with a scripted manager

Companion to `synapse-spec.md` rev 3 and `synapse-implementation-plan.md`.

**Status: exit criteria met.** `bun test`: 46 pass / 0 fail (211 assertions,
including Phases 1–2's 38). `tsc --noEmit`: clean. `bun build --compile`
verified against a real binary with `watcher.ts` bundled in.

This phase's own milestone claim (plan Phase 3): **the system now works end to
end with zero model calls.** Only judgment is missing.

## What's built

| File | Purpose |
|---|---|
| `src/watcher.ts` | `pollOnce` (one poll cycle: sweep → cascade → rev-gated wake), `watchLoop` (2s-interval driver), `pidSweep`, `cascadeCancel`, `ManagerTurnFn`/`ManagerTurnArgs` — the injectable manager-turn interface |
| `tests/fakes/policy-manager.ts` | `makePolicyManager`: judges newly-terminal rows, dispatches every ready row via `spawnSubtask` — no judgment, mechanical |
| `tests/watcher.test.ts` | Mid-turn loss, coalescing, mutual exclusion, first-turn session/resume + failed-turn retry, restart, cascade, end-to-end zero-model-calls |
| `src/cli.ts` | Added `watch --run R` and `start --goal` verbs |

`tests/spawn.test.ts`'s `hang.sh` case, written `test.failing` in Phase 2
pending the pid sweep, is now a real passing test exercising `pidSweep`
directly against an orphaned `assigned` row with a dead pid.

## Exit criteria → tests

- **Mid-turn loss** — a reply written *during* a manager turn function's
  execution is not folded into that same poll's `manager_reacted_rev` write
  (which uses the pre-turn `rev_seen`); the next poll reacts to it.
- **Coalescing** — 5 transitions performed inside one manager turn produce
  exactly 1 follow-up wake, and a third poll with nothing new does not wake
  the manager at all.
- **Mutual exclusion** — `watchLoop` never starts a second turn before the
  first resolves, verified under a flood of transitions manufactured turn by
  turn; `maxConcurrent` stays 1. (`pollOnce` itself carries no lock — the
  invariant is structural, from `watchLoop` being the sole sequential
  caller, per spec §4.4.)
- **First turn** — `isFirstTurn=true` and `manager_turns: 0→1` on the first
  wake; a later wake gets `isFirstTurn=false`; a turn that throws before
  completing leaves `manager_turns` and `manager_reacted_rev` untouched, and
  the next wake retries with `isFirstTurn=true` again.
- **Watcher restart** — a reply landing while nothing is polling is reacted
  to by the next `pollOnce` call, standing in for `synapse watch --run R`
  being invoked again after a kill (state lives entirely in the tables).
- **Cascade** — a failed coder row cascades `cancelled` to its reviewer and
  tester with `cancel_reason = "dependency <id> failed"`; `synapse done`'s
  gate (`runIsDone`) unblocks once every subtask is terminal.
- **End-to-end, fakes only** — coder → reviewer → tester rows, materialized
  up front as siblings (spec §2.3.2), driven to `done` through repeated
  `policy-manager` turns, task `work_settled`. Zero model calls.

## Design points settled during implementation

1. **`ManagerTurnFn` is an injected function, not a hardcoded `claude -p`
   call.** The plan's own framing — "the wake loop, proven without a
   model" — makes this the only way `watcher.ts` can be tested in this phase
   at all. Phase 5 supplies the real implementation; `watcher.ts` does not
   change shape when that happens.
2. **`cmdWatch`/`cmdStart` exist as CLI verbs (plan's explicit ask) but their
   `runManagerTurn` is a placeholder that throws.** CLAUDE.md bars real model
   calls before Phase 4, and role/prompt resolution for a real manager is
   Phase 4/5 work. Every Phase 3 exit criterion is verifiable by calling
   `pollOnce`/`watchLoop` directly with the scripted manager injected, so the
   CLI verb's internals don't need to be real yet — only present, matching
   "the two process-side verbs Phase 1 deliberately left out."
3. **`markAssigned`/`pidSweep`/`cascadeCancel` writes to `runs` and
   `subtasks` live in `watcher.ts`, not `subtasks.ts`.** CLAUDE.md scopes
   `subtasks.ts` to subtask row lifecycle; watcher bookkeeping
   (`manager_reacted_rev`, `manager_turns`) and the two mechanical sweep/
   cascade writes are watcher-owned state per the plan's own file-purpose
   table ("watcher.ts — poll, cascade, sweep, wake").
4. **None of `pidSweep`'s or `cascadeCancel`'s writes assign a rev beyond
   what `failSubtask`/`cancelSubtask` already do.** `pidSweep` reuses the
   same rev-bump pattern as `failSubtask` (it *is* a failure write, just
   sourced from the sweep instead of the wrapper); `cascadeCancel` calls
   `cancelSubtask` from `subtasks.ts` directly rather than duplicating its
   logic, so cascade's rev-assignment rides on that file's existing
   guarantee.
5. **Plan text says `tests/fakes/policy-manager.ts` in Phase 3 but
   `policy_manager.py` in Phase 4's prose.** Treated as a slip, not a
   language decision to relitigate — D1 (Bun/TypeScript) is settled, and a
   `.py` file has no way to run in this codebase. Built as `.ts`.

## Not started

Phase 4 (real workers: `prompts/coder.md`, Stop hook, `synapse spawn <role>`
with real role/prompt resolution — the CLI verb gap this phase deliberately
left open). No real manager turn exists yet; `notYetImplementedManagerTurn`
in `cli.ts` is the explicit placeholder for that gap.
