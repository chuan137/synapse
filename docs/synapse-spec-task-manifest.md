# Synapse Spec Update — Task Manifest

Supersedes sections 6.1–6.2 of `synapse-spec.md`.

## Summary of changes

- The config file is renamed from `team.yaml` to `task.yml` — it describes
  a unit of work, in addition to a team topology.
- Agent scratch directories are always auto-managed by synapse; `cwd` is
  removed from the config. Users don't manage working directories.
- Per-task state is split across two roots under `.synapse/`: durable
  records live in `.synapse/tasks/<task-name>/`, agent scratch lives in
  `.synapse/agents/<task-name>/`.
- Each `synapse start` creates a new task with a unique task name —
  existing task folders are never overwritten.
- One shared DB at `.synapse/synapse.db` covers all tasks.
- `task.yml` records the synapse version so the correct `CLAUDE.md`
  templates are used when generating agent dirs.
- A `workflow` field selects the team topology. Currently only
  `hub-and-spoke` exists; future values could include `fan-out`,
  `pipeline`, etc.
- The `goal` field set via --goal or leave it for synapse to decide/set later

## Directory layout

```
.synapse/
  synapse.db                       # durable, shared across all tasks
  tasks/                           # durable — audit trail, one folder per task
    my-feature-task/
      task.yml
      42-spec.md
      42-plan.md
  agents/                          # scratch — one folder per task, created at start
    my-feature-task/
      planner/
        CLAUDE.md
      coder-1/
        CLAUDE.md
      coder-2/
        CLAUDE.md
      reviewer/
        CLAUDE.md
```

## Durable vs scratch

The two top-level subtrees under `.synapse/` have different lifecycles, and
the rule is structural — not a per-file convention:

- **`.synapse/tasks/` is durable.** It holds `task.yml` and the handoff
  artifacts agents produce while working. Backup/archival of a task = this
  tree plus the relevant rows in `synapse.db`.
- **`.synapse/agents/` is scratch.** Each task gets its own
  `.synapse/agents/<task-name>/` created once when `synapse start` runs.
  The `CLAUDE.md` files inside are generated from
  `templates/role-<role>.md` + `templates/shared.md` matching the
  `synapse_version` in `task.yml`. Nothing else writes to this tree on
  behalf of synapse — agents may write their own scratch alongside if they
  want.

Practical consequences:
- Task names are unique by construction. `synapse start` generates a fresh
  task name (or rejects a `task.yml` whose folder already exists) so it
  never overwrites either tree.
- Once a task is done, `rm -rf .synapse/agents/<task-name>/` is safe — its
  contents are regenerable from `task.yml` + templates if ever needed.
- `rm -rf .synapse/tasks/<task-name>/` destroys that task's audit trail
  and is never safe unless you explicitly want it gone.
- Synapse upgrades are handled by the `synapse_version` field in
  `task.yml` driving template selection — no version-namespaced
  directories needed. New tasks pick up new templates automatically;
  existing tasks keep the templates they were started with.

## Handoff files

Detailed task specs, plans, and other artifacts agents hand to each other
go directly under `.synapse/tasks/<task-name>/`, alongside `task.yml`.
Filename convention:

```
<message-id>-<kind>.md
```

- `<message-id>` is the `messages.id` autoincrement primary key of the
  originating `TASK` row in `synapse.db`. This is the same id used as
  `ref_id` to chain `STATUS`/`REVIEW` replies back to the task, so the
  filename and the DB row correspond directly.
- `<kind>` is a short label for what the artifact is (`spec`, `plan`,
  `review`, etc.).
- Message ids are globally unique across all tasks (one shared DB, one
  autoincrement counter), so the prefix is unambiguous. The numeric
  prefix also keeps handoff files sorted in creation order and visually
  distinct from `task.yml` when listing the folder.

Example: `42-spec.md` is the detailed spec for TASK id 42; a later
`42-review.md` is the reviewer's notes on that same task.

## task.yml format

```yaml
synapse_version: 0.1.0        # version that wrote this task; used to pick templates
workflow: hub-and-spoke
goal: "Implement the new payment flow"
agents:
  - role: planner
  - role: coder
  - role: coder
  - role: reviewer
```

- `name` is omitted — synapse assigns names automatically (`planner`,
  `coder-1`, `coder-2`, etc.) from role + index.
- `cwd` is omitted — agent dirs are always
  `.synapse/agents/<task-name>/<name>/`, created automatically.
- Multiple agents with the same role get a numeric suffix (`coder-1`,
  `coder-2`). A single agent of a role gets no suffix (`planner`,
  `reviewer`).

## Starting a task

```
synapse start .synapse/tasks/my-feature-task/task.yml
```

Synapse does, in order:

1. Creates `.synapse/agents/<task-name>/` and generates each agent's
   `CLAUDE.md` from the role template matching `synapse_version`. The
   task folder under `.synapse/tasks/<task-name>/` must already exist
   (that's where `task.yml` was read from); handoff files are written
   into it on-demand by agents as the task progresses.
2. Creates the tmux session (named after the task folder), one window per
   agent.
3. In each window: `cd .synapse/agents/<task-name>/<name>/ && claude`,
   then captures the session id and registers the agent in `synapse.db`.
4. Starts the monitor as a background process or its own tmux window.
5. Registers `operator` as a pseudo-agent.
6. Sends `goal` as a `TASK` message from `operator` to `planner`.

## What stays the same

Everything in sections 2–5 of `synapse-spec.md` (SQLite schema, message
types, idle detection, delivery, audit) is unchanged.
