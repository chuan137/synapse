# Synapse Spec Update — Task Manifest

Supersedes sections 6.1–6.2 of `synapse-spec.md`.

## Summary of changes

- The config file is renamed from `team.yaml` to `task.yml` — it describes
  a unit of work, in addition to a team topology.
- Agent scratch directories are always auto-managed by synapse; `cwd` is
  removed from the config. Users don't manage working directories.
- Per-task state is split across two roots under `.synapse/`: durable
  records live in `.synapse/runs/<run-name>/`, agent scratch lives in
  `.synapse/agents/<run-name>/`.
- `synapse start <task.yml>` treats the supplied file as a template:
  it allocates a new run id, creates `.synapse/runs/run-<id>/`, copies
  `task.yml` into it, and creates the agent scratch tree under
  `.synapse/agents/run-<id>/`. The original template is never mutated.
- The run folder's `task.yml` records the path to its agent scratch root
  (`agents_dir`) so the two trees are linked from the durable record.
- One shared DB at `.synapse/synapse.db` covers all runs.
- `task.yml` records the synapse version so the correct `CLAUDE.md`
  templates are used when generating agent dirs.
- A `workflow` field selects the team topology. Currently only
  `hub-and-spoke` exists; future values could include `fan-out`,
  `pipeline`, etc.
- The `goal` field set via --goal or leave it for synapse to decide/set later
- The role formerly called `planner` is now `manager`.

## Directory layout

```
.synapse/
  synapse.db                       # durable, shared across all runs
  runs/                            # durable — audit trail, one folder per run
    run-1/
      task.yml                     # copied from template at start; includes agents_dir link
      42-spec.md
      42-plan.md
  agents/                          # scratch — one folder per run, created at start
    run-1/
      manager/
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

- **`.synapse/runs/` is durable.** It holds `task.yml` and the handoff
  artifacts agents produce while working. Backup/archival of a run = this
  tree plus the relevant rows in `synapse.db`.
- **`.synapse/agents/` is scratch.** Each run gets its own
  `.synapse/agents/<run-name>/` created once when `synapse start` runs.
  The `CLAUDE.md` files inside are generated from
  `templates/role-<role>.md` + `templates/shared.md` matching the
  `synapse_version` in `task.yml`. Nothing else writes to this tree on
  behalf of synapse — agents may write their own scratch alongside if they
  want.

Practical consequences:
- Run names are unique by construction (`run-<id>` from the DB autoincrement),
  so `synapse start` never overwrites either tree.
- Once a run is done, `rm -rf .synapse/agents/<run-name>/` is safe — its
  contents are regenerable from `task.yml` + templates if ever needed.
- `rm -rf .synapse/runs/<run-name>/` destroys that run's audit trail
  and is never safe unless you explicitly want it gone.
- Synapse upgrades are handled by the `synapse_version` field in
  `task.yml` driving template selection — no version-namespaced
  directories needed. New runs pick up new templates automatically;
  existing runs keep the templates they were started with.

## Handoff files

Detailed task specs, plans, and other artifacts agents hand to each other
go directly under `.synapse/runs/<run-name>/`, alongside `task.yml`.
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
- Message ids are globally unique across all runs (one shared DB, one
  autoincrement counter), so the prefix is unambiguous. The numeric
  prefix also keeps handoff files sorted in creation order and visually
  distinct from `task.yml` when listing the folder.

Example: `42-spec.md` is the detailed spec for TASK id 42; a later
`42-review.md` is the reviewer's notes on that same task.

## task.yml format

The file kept in `templates/` (e.g. `task.yml`) is the user-facing template.
`synapse start` copies it into `.synapse/runs/run-<id>/task.yml` and appends
two generated fields:

```yaml
synapse_version: 0.1.0        # version that wrote this task; used to pick templates
workflow: hub-and-spoke
goal: "Implement the new payment flow"
agents:
  - role: manager
  - role: coder
  - role: coder
  - role: reviewer
  - role: tester

# --- added by synapse start ---
run_id: 1
agents_dir: .synapse/agents/run-1   # path to the scratch tree for this run
```

- `name` is omitted in the template — synapse assigns names automatically
  (`manager`, `coder-1`, `coder-2`, etc.) from role + index.
- `cwd` is omitted — agent dirs are always
  `.synapse/agents/<run-name>/<name>/`, created automatically.
- Multiple agents with the same role get a numeric suffix (`coder-1`,
  `coder-2`). A single agent of a role gets no suffix (`manager`,
  `reviewer`).

## Starting a run

```
synapse start [task.yml]
```

If no argument is given, defaults to `templates/task.example.yml`.

Synapse does, in order:

1. Allocates a new run id from the DB and creates `.synapse/runs/run-<id>/`.
   Copies the supplied `task.yml` into it, appending `run_id` and
   `agents_dir` fields so the durable record links to its scratch tree.
2. Creates `.synapse/agents/run-<id>/` and generates each agent's
   `CLAUDE.md` from the role template matching `synapse_version`.
3. Creates the tmux session (named `run-<id>`), one window per agent.
4. In each window: `cd .synapse/agents/run-<id>/<name>/ && claude`,
   then captures the session id and registers the agent in `synapse.db`.
5. Starts the monitor as a background process or its own tmux window.
6. Registers `operator` as a pseudo-agent.
7. Sends `goal` as a `TASK` message from `operator` to `manager`.

## What stays the same

Everything in sections 2–5 of `synapse-spec.md` (SQLite schema, message
types, idle detection, delivery, audit) is unchanged.
