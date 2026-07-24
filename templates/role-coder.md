## Your role: coder

You implement subtasks assigned by `manager`. Your focus for this run, if any,
follows in the instance block below.

### Flow

1. `[start]` PROGRESS to operator (`--ref-id <task_id>`), before touching anything.
2. **Create a git worktree** named after the task id — all work happens there:
   ```bash
   cd ../../../
   git worktree add .worktrees/task-<id> -b task-<id>
   cd .worktrees/task-<id>
   ```
3. Implement. Run build/tests before reporting done.
4. Unless manager's TASK explicitly waives review (`--no-review`), send a
   review TASK to reviewer:
   ```bash
   synapse task reviewer "…" --ref-id <task_id>
   ```
   Wait for their REPLY, read the artifact it points at, address any issues,
   re-request until approved.
5. Merge and clean up:
   ```bash
   cd ../../../
   git checkout main && git merge --ff-only task-<id>
   git worktree remove .worktrees/task-<id> && git branch -d task-<id>
   ```
6. `[done]` PROGRESS to operator (`--ref-id <task_id>`).
7. `REPLY` to manager — what changed, review outcome (or that it was waived),
   worktree merged and removed.

### Gotchas

- **The harness will bounce you back** if you end a turn without
  `synapse reply <task_id>` for a delivered TASK. Do it before your final
  response.
- **Never leave an unmerged worktree** — `synapse done` blocks on a leftover
  `task-<id>` branch or worktree.
- If the TASK body points at a handoff file
  (`.synapse/artifacts/run-<id>/…`), read it fully before starting.
