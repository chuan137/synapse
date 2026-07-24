# Harness enforcement — as built

Status: **shipped.** This started as a proposal to move behavior that role
prompts merely *asked* for into code the harness *enforces* (principle: enforce
with code + verifiable evidence, keep prompts to gotchas). It's now implemented
and unit-tested; this doc records what landed and the one known gap. References
are to `src/commands.ts` unless noted.

## What shipped

**`synapse verdict <review_task_id> "<body>"`** — closes a review in one call.
The reviewer no longer hand-computes two different `ref_id`s: `cmdVerdict`
derives the coder recipient (sender of the review `TASK`) and the manager
`PROGRESS` `ref_id` (the review `TASK`'s own parent) from the DB, reusing
`cmdReply` + `cmdSend` so the routing invariants already enforced there apply.
`cmdPending` prints a ready-to-run `verdict` line for open reviews.

**`synapse handoff <kind> <ref-id>`** — writes an artifact to its canonical
`.synapse/artifacts/run-<id>/<ref-id>-<kind>.md` path (derived, never guessed)
and announces it in the same call. `kind=review` runs the full verdict
fan-out; other kinds (`spec`/`plan`/`testplan`/`notes`) write the file and
optionally `--to` a pointer `PROGRESS`. Used by the reviewer flow and the
`synapse-planning` skill.

**`synapse done` completion gate** — `cmdDone` now refuses to close a run with
open work unless `--force --reason "…"` (logged to `events`). Two checks feed
the gate:

- `openChains(db, runId)` — DB-only. A subtask (manager → coder `TASK`, keyed
  by its own id `S` once the coder replies) is open until it's both reported
  done (coder → manager `REPLY` with `ref_id = S`) and — unless waived —
  reviewed (a reviewer `PROGRESS` with `ref_id = S`, or a review-`TASK` →
  reviewer-`REPLY` pair rooted at `S`).
- `worktreeIssues(db, runId)` — git-side merge evidence. Flags a subtask whose
  `task-<S>` worktree still exists or whose `task-<S>` branch isn't merged into
  `main`. Runs `git` against the project root (`dirname(dirname(dbPath()))`);
  skips silently when there's no git repo or no `main` branch. Deduped against
  `openChains` so a subtask isn't double-reported.

**Structured subtask flags** — `--no-review` / `--test-required` on the
manager → coder `TASK` persist to `messages.review_waived` / `.test_required`
(schema v14 + migration), so the gate reads intent from columns, not body text.

**Manager owns closure** — resolved the old contradiction. The manager calls
`synapse done`; the launch hint and `synapse-operator` skill frame operator
`done` as a `--force` override only.

**Evals** — `tests/synapse.test.ts` covers verdict fan-out, handoff (review +
file-only + errors), the done gate (unreported / unreviewed / `--no-review` /
post-verdict / `--force` / force-requires-reason), and the worktree gate
(unmerged branch, clean merge, leftover worktree, force) against a real git
repo. `tests/monitor.test.ts` assertions on the manager `CLAUDE.md` were
repointed to the trimmed template's wording.

## Known gap

**Test coverage isn't gated.** `--test-required` is stored but `openChains`
doesn't block on a missing tester pass: testers are currently dispatched on the
root task id, so there's no clean per-subtask link from a tester `REPLY` back
to subtask `S`. Closing this needs the tester dispatch to carry `S` (e.g.
`--ref-id S` on the tester `TASK`, or a `subtask_id` column), after which the
gate gains a third check symmetric with the review one.

## Also fixed in passing

A pre-existing build break (unrelated WIP): `src/ui.ts` imported
`connect`/`disbandTeam` from `./commands` (they live in `./db` / `./monitor`)
and `synapse.ts` called `startUi` when `ui.ts` exports `cmdUi(flags)`.
Reconciled both — the project compiles and the test suite runs again.
