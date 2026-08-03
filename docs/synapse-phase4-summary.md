# Phase 4 Summary — Real workers, no real manager

Companion to `synapse-spec.md` rev 3 and `synapse-implementation-plan.md`.

**Status: exit criteria met, verified against real `claude -p` workers, not
fakes.** `bun test`: 51 pass / 0 fail (217 assertions, including Phases 1–3's
46). `tsc --noEmit`: clean. All four plan exit criteria run for real in a
throwaway scratch repo and confirmed.

This phase crossed the line CLAUDE.md gates at "no real model calls before
Phase 4" and found two real bugs that no amount of fake-worker testing in
Phases 1–3 could have surfaced — both are now spec-corrected and code-fixed.

## What's built

| File | Purpose |
|---|---|
| `prompts/coder.md`, `reviewer.md`, `tester.md`, `doc-writer.md` | Role prompt templates — read your row (via literal `{{SYNAPSE_BIN}}`/`{{SUBTASK_ID}}`/`{{RUN_ID}}` substitution, not env expansion), do the work, `reply`, stop |
| `src/roles.ts` | Role → tool scope (D7) → model default (D5) → built-in prompt, single source of truth for `cmdSpawn` |
| `src/cli.ts` `cmdSpawn` | `synapse spawn <role> <subtask-id> [--model][--prompt-file]` — resolves worktree (§4.7), substitutes prompt placeholders, builds the real `claude -p --session-id ... --allowedTools=...` invocation, wraps it with `spawnSubtask` |
| `src/cli.ts` `cmdHookCheck`/`hook-check` verb | Stop-hook DB logic: session → subtask lookup, block if `assigned` with no reply |
| `hooks/stop.ts` | Thin stdin-relay script registered as the Stop hook command (D1: hook stays ~20ms, delegates all logic to the compiled binary) |
| `.claude/settings.json` | Registers the Stop hook for this repo |
| `src/subtasks.ts` `resolveWorktreePath` | §4.7's dispatch-time rule: no deps → repo root (Tier 1 has no real worktree isolation need); has deps → inherit subject's `worktree_path` |
| `tests/hook-check.test.ts` | Unit tests for `cmdHookCheck`'s DB logic (block/allow across assigned/done/failed/unknown-session) |

## Exit criteria → verification

All four were run against real `claude -p` calls in a throwaway git repo
under `$TMPDIR`, per your direction to keep this project's own tree/tokens
untouched:

- **A real coder completes a small real change and replies correctly.**
  Spawned a coder on "write hello.txt containing exactly: synapse-phase4-ok."
  It wrote the file with the exact byte-for-byte content, called `reply`
  with an accurate summary, row ended `done`, `worker_model`/`worktree_path`/
  `rev` all populated correctly.
- **The Stop hook catches a worker that tries to finish without replying.**
  Spawned a coder with a `--prompt-file` deliberately inviting a prose-only
  ending ("just say you're done, call no tools"). Result: `num_turns: 13`,
  `is_error: false`, `stop_reason: "end_turn"`, `result: ""` — the exact
  S0.3 signature of the hook firing, forcing retries, exhausting its
  internal ~10-forced-stop cap, and the CLI reporting empty "success." The
  wrapper's layer 2 guarantee still caught it: row ended `failed`, rev
  assigned.
- **A reviewer reads its subject's artifact and produces a usable verdict
  input.** Spawned a reviewer depending on the coder row above. It read the
  file directly, verified content byte-for-byte, and gave a genuinely
  careful verdict — LGTM, with two explicitly-flagged verification gaps
  (couldn't distinguish a trailing newline via `Read`; `git status` calls
  were killed in this sandboxed trial and it said so rather than guessing).
  This is real judgment quality, not a rubber stamp.
- **Worktree inheritance: reviewer sees exactly the coder's tree.** Confirmed
  directly — both rows carry the identical `worktree_path`, and the reviewer
  read the coder's file in place with no merge step, per §4.7.

## Two bugs found only by real-model trials, both spec-corrected and fixed

Neither was reachable by fakes/mocks — both are specifically about what a
*real model* does when handed the prompt and tool grant as designed.

1. **Reviewer/tester had no way to read their own identity.** The first
   design passed `SYNAPSE_BIN`/`SUBTASK_ID`/`RUN_ID` as process env vars and
   told workers to invoke `$SYNAPSE_BIN`. A live reviewer run correctly
   refused to guess its own subtask id rather than proceed blind — no
   `Bash` grant permitted reading the environment at all. First fix
   (`Bash(printenv *)`) was itself incomplete.
2. **`Bash(synapse *)` never matched anything the worker could actually run.**
   Claude Code's `Bash(pattern *)` allowlist matches literal command text: it
   denies `$VAR`-expanding commands outright ("Contains simple_expansion")
   and denies a resolved absolute path as requiring approval. So no worker
   could ever have successfully called `synapse` under the original design,
   `printenv` fix included — this would have silently broken every real
   worker turn had it shipped. Root-caused by manually capturing the raw
   `claude -p` JSON result (`permission_denials` array) rather than trusting
   the wrapper's `exit 0`/`failed` summary alone.

**The fix** (spec §9 #24–25, D7 corrected): substitute the worker's identity
as literal text into the prompt at spawn time (`{{SYNAPSE_BIN}}` →
`process.execPath`, `{{SUBTASK_ID}}`, `{{RUN_ID}}` → real values, no
variable left for the shell to refuse), and grant `Bash(<that literal path>
*)` computed per spawn rather than a static `Bash(synapse *)`. Also added
`Bash(git *)` to reviewer, matching what its prompt already told it to do
but the original tool grant didn't actually permit.

Both fixes were applied to the spec (§4.5, D7, §9 rows 24–25) before being
applied to code, per rule 3 — proposed as diffs, approved, then implemented.

## Design points settled during implementation

1. **Per-role `--allowedTools` was a genuine spec gap** (flagged at spike
   S0.1, Phase 0, never resolved). Settled via an approved spec diff before
   any prompt was written: `coder` full edit access, `reviewer`/`tester`
   read-only plus what their job needs, `doc-writer` write access scoped to
   `.synapse/artifacts/` by prompt contract (not tool restriction — Claude
   Code's `Write`/`Edit` grants aren't path-scopable).
2. **`worktree_path` resolution (§4.7) had no implementation anywhere before
   this phase.** Added `resolveWorktreePath` to `subtasks.ts` (a subtask-row
   write, hence that file per CLAUDE.md's ownership rule): no deps → repo
   root (Tier 1 serializes, so "fresh worktree" has no isolation problem to
   solve yet — that's Phase 8); has deps → copy the first dep's
   `worktree_path`.
3. **`cmdHookCheck` is a plain function taking a parsed payload, tested
   directly**; `hooks/stop.ts` is an untested thin relay (stdin → CLI verb →
   stdout), matching D1's "keep the hook itself under ~20ms" — all real
   logic lives in the compiled binary, verified by unit test; the hook
   script itself was verified by the real Stop-hook trial instead, since a
   process-boundary relay isn't meaningfully unit-testable.
4. **The `hooks/stop.ts` registration in `.claude/settings.json` also
   applies to this outer session**, since Phase 4's own work happens inside
   this same repo. The hook checks for `SYNAPSE_BIN` in its own environment
   and no-ops if absent, so it does not affect this session's own turns —
   confirmed by this session continuing to run normally after registration.

## Not started

Phase 5 (the real manager — planning, judging, materializing dependency
graphs, the compaction-survival test). `notYetImplementedManagerTurn` in
`cli.ts` remains the explicit placeholder `synapse watch`/`start` use.
