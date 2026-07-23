---
name: synapse-operator
description: Start, monitor, and drive a Synapse multi-agent team (the `synapse` CLI — manager/coder/reviewer/tester agents coordinating over a SQLite mailbox in tmux). Use when the user wants to kick off a Synapse run, check run/agent status, answer a QUESTION from the team, send a follow-up task, spawn an extra agent, update the goal, stop an agent, or end a run. Not for editing Synapse's own source — only for operating a team through its CLI.
---

# synapse-operator

Drive a Synapse team from the operator's seat. Synapse runs each team member
(`manager`, `coder`, `reviewer`, `tester`) as its own Claude Code session in a
tmux window; they coordinate through a shared SQLite mailbox, not through
you relaying messages by hand. This skill is the CLI reference for
starting, watching, and steering that team — for reaching directly into an
agent's pane (rare; mostly for debugging), see the `tmux` skill instead.

## Mental model

- **run** — one team instance, backed by one tmux session, tracked as a row
  in the `runs` table (`id`, `session`, `status`, `goal`).
- **agent** — one team member: a `window_name` (tmux window / mailbox
  address, e.g. `manager`, `coder-1`), a `role`, and idle/busy `status`.
  `operator` (you) is registered as a pseudo-agent too, so sending you a
  message is not a special-cased channel.
- **message** — a mailbox row: `from_agent`, `to_agent`, `type`, `ref_id`,
  `body`. Delivered to a tmux pane by the monitor process when that agent
  goes idle.
- **`ref_id`** — links a reply back to the message it closes. `<id>` is the
  number `synapse send` printed when that message was sent (or the id shown
  in `synapse pending`). Prefer `synapse reply <id> "<body>"` over a raw
  `send ... REPLY --ref-id <id>`: it resolves the recipient to the sender of
  message `<id>` for you, so a reply can't be sent to the wrong agent. A
  `REPLY` whose recipient isn't that sender is rejected either way.
- **Message types**: `TASK` (assignment, expects a `REPLY`), `QUESTION`
  (blocking, halts the sender until answered, requires `--options` when
  aimed at `operator`), `PROGRESS` (one-way status ping, no reply
  expected), `REPLY` (the actual answer/done-report, closes a `ref_id`).
  `broadcast` as a recipient is not supported — address a specific agent.

## Environment

Commands resolve these in order: explicit flag, then env var, then a
sensible default. Set them once per shell session to avoid repeating flags.

| Var | Used for | Default |
|---|---|---|
| `SYNAPSE_DB` | which SQLite file (`.synapse/synapse.db`) to talk to | `./.synapse/synapse.db`, resolved from cwd — **run from the project root**, or exports will silently talk to the wrong project's DB |
| `SYNAPSE_RUN_ID` | which run `status`/`pending`/`spawn`/`stop`/`set-goal` operate on when `--run-id` is omitted | latest run with `status='running'` (falls back to most recent run for `synapse status` with none running) |
| `SYNAPSE_AGENT` | sender identity for `synapse send` when `--from` is omitted | none — required by `send`/`done`; agent tmux windows have this pre-exported, your own shell does not |

When acting as the operator from an ordinary shell (not inside an agent's
tmux window), pass `--from operator` explicitly on `send`, or `export
SYNAPSE_AGENT=operator` once.

## Command reference

| Command | Purpose |
|---|---|
| `synapse start [task.yml] [--goal "text"] [--no-monitor]` | Launch a new team + tmux session from a task manifest; sends the goal as the root `TASK` to `manager`. No argument → uses `.synapse/task.yml` if present, else the built-in example (and writes it to `.synapse/task.yml` for next time). |
| `synapse runs` | List all runs: id, session, state, started/ended, goal. |
| `synapse status` | Roster for the active run: window, role, model, idle/busy, last-seen, pending-message count. |
| `synapse pending [agent] [--all]` | Show pending messages (defaults to the active run; `--all` spans every run). Only *marks messages read* if `$SYNAPSE_AGENT` matches the queried agent — safe to inspect anyone's inbox read-only otherwise. |
| `synapse send <to> <type> "<body>" [--from NAME] [--ref-id N] [--run-id N] [--options a,b,c] [--title "..."] [--body-file PATH]` | Queue a message. `--body-file -` reads from stdin (use for long or backtick-heavy bodies to dodge shell interpolation). A `REPLY` whose recipient isn't the sender of its `--ref-id` message is rejected — use `reply` below instead. |
| `synapse reply <ref-id> "<body>" [--from NAME] [--run-id N] [--body-file PATH]` | Reply to a message by id. Recipient is resolved to the sender of message `<ref-id>`, so you never name it and can't misroute — the preferred way to close a `TASK` or `QUESTION`. The id is shown by `synapse pending` and printed by `synapse send`. |
| `synapse spawn <role> [--run-id N]` | Add another agent (`coder`, `reviewer`, `tester`, or a second `manager`) to a running team; auto-numbers (`coder-2`, ...). |
| `synapse stop <name> [--session S] [--run-id N]` | Mark an agent stopped and close its tmux window. |
| `synapse attach <name> [--session S]` | `tmux attach` shortcut to one agent's window. |
| `synapse set-goal "<text>" [--run-id N]` | Update the running run's recorded goal. |
| `synapse done [run-id] [--reason "..."] [--status done\|failed] [--ref-id N]` | Mark a run terminal and send the final `REPLY` to `operator`. Requires sender identity — see Gotchas. |
| `synapse ui [--port N]` | Web dashboard (S-Deck) as an alternative to polling the CLI — default port 7700. |
| `synapse init` | Create/migrate the DB. Usually not needed by hand — `start` and `ui` call it. |

`register` and `monitor` also exist but are launched automatically by
`start`/`spawn` — no reason to call them directly as operator.

## Workflows

**Start a new run**
```bash
synapse start --goal "Fix the file-viewer refresh bug"
# or, with a custom manifest:
synapse start path/to/task.yml --goal "..."
```
A manifest (`task.yml`) needs `synapse_version`, `workflow: hub-and-spoke`,
and an `agents` list of `{role, name?, focus?, model?}` — exactly one
`manager`. `focus` is free text appended to that agent's generated
`CLAUDE.md`, useful to hand a coder-specific brief without cramming it into
the shared goal.

**Check on a run**
```bash
synapse runs                 # which runs exist
export SYNAPSE_RUN_ID=<id>   # pin the one you care about
synapse status                # who's idle/busy, pending counts
synapse pending --all         # read (don't consume) everyone's backlog
```
or open `synapse ui` for the live view.

**Answer a blocking QUESTION from manager**
`manager` sends `QUESTION` to `operator` with `--options` and then halts.
Find the message id (`synapse pending operator` or the UI), then reply to
it — `reply` routes it back to whoever asked (usually `manager`):
```bash
synapse reply <question_msg_id> "<chosen option, or free text>" --from operator
```

**Send a follow-up task after the run is already going**
```bash
synapse send manager TASK "<new task text>" --from operator
```
Send to `manager`, not directly to a coder/reviewer — hub-and-spoke routing
means `manager` is the one tracking `ref_id` chains to completion.

**Add an agent mid-run**
```bash
synapse spawn coder --run-id <id>
```

**Watch or nudge one agent's pane directly** — use the `tmux` skill
(`tmux attach -t <session>:<window>`, or `synapse attach <name>`).

**Update the goal / stop an agent**
```bash
synapse set-goal "New/refined goal text" --run-id <id>
synapse stop coder-2 --run-id <id>
```

**End a run**
```bash
export SYNAPSE_AGENT=operator
SYNAPSE_RUN_ID=<id> synapse done --status done --reason "<what shipped>"
```

## Gotchas

- **Run from the project root**, or export `SYNAPSE_DB` — a wrong cwd means
  `synapse status` silently queries an unrelated (or nonexistent) DB.
- **`synapse done` needs a sender identity** but has no `--from` flag —
  export `SYNAPSE_AGENT=operator` first, or the call fails with "missing
  sender." Note: `templates/role-manager.md` explicitly tells `manager`
  *never* to call `synapse done` ("closing the run is the operator's
  call"), while the hint `synapse start` prints on launch says the
  opposite ("manager calls this, not the operator") — these two are
  currently inconsistent. Until that's reconciled in the repo, treat the
  role template as authoritative (it's what agents actually read) and call
  `done` yourself as operator.
- **`QUESTION` to `operator` requires `--options`** (2-4 short labels) —
  rejected otherwise; there's no generic UI fallback.
- **No unbroken numbered-list bodies** — `synapse send` rejects a body with
  two or more `(1)`/`(2)`/①② markers and no real line breaks. Use `- `
  bullets or literal newlines (or `--body-file`) instead.
- **`broadcast` isn't a valid recipient** — address a specific agent.
- Long or backtick-heavy bodies: use `--body-file -` with stdin rather than
  inline shell quoting.

## See also

- `tmux` skill — direct pane access for inspection/debugging outside the
  message bus.
- `docs/synapse-spec.md` in this repo — original design spec (draft; the
  implementation has since diverged in places, e.g. message types are
  `TASK/QUESTION/PROGRESS/REPLY` in code, not the spec's
  `TASK/STATUS/REVIEW/ACK/INFO`). Prefer this skill and `synapse help
  <command>` over the spec for current CLI behavior.
