---
name: synapse-operator
description: Start, monitor, and drive a Synapse multi-agent team (the `synapse` CLI — manager/coder/reviewer/tester agents coordinating over a SQLite mailbox in tmux). Use when the user wants to kick off a Synapse run, check run/agent status, answer a QUESTION from the team, send a follow-up task, spawn an extra agent, update the goal, stop an agent, or force-close a run. Not for editing Synapse's own source — only for operating a team through its CLI.
---

# synapse-operator

Drive a Synapse team from the operator's seat. Each team member (`manager`,
`coder`, `reviewer`, `tester`) runs as its own Claude Code session in a tmux
window, coordinating through a shared SQLite mailbox — you don't relay messages
by hand. This skill is the operator's CLI reference: the commands *you* run and
the traps in running them. The agents' own message discipline lives in their
role templates, not here.

## Mental model

- **run** — one team instance = one tmux session = one row in `runs`.
- **agent** — one member: a `window_name` (mailbox address, e.g. `manager`,
  `coder-1`), a `role`, idle/busy `status`. `operator` (you) is a pseudo-agent.
- **message** — a mailbox row (`from_agent`, `to_agent`, `type`, `ref_id`,
  `body`), delivered to a pane by the monitor when the recipient goes idle.
- **`ref_id`** — links a reply to the message it closes. Prefer `synapse reply
  <id> "<body>"`: it resolves the recipient to that message's sender, so it
  can't be misrouted.

## Environment

Resolved in order: explicit flag → env var → default. Set once per shell.

| Var | Used for | Default |
|---|---|---|
| `SYNAPSE_DB` | which SQLite file to talk to | `./.synapse/synapse.db` from cwd — **run from the project root**, or you silently hit the wrong DB |
| `SYNAPSE_RUN_ID` | which run `status`/`pending`/`spawn`/`stop`/`set-goal` act on | latest `running` run |
| `SYNAPSE_AGENT` | sender identity for `task`/`ask`/`progress`/`reply`/`send`/`done` | none — from an ordinary shell, pass `--from operator` or `export SYNAPSE_AGENT=operator` |

## Command reference (operator-facing)

| Command | Purpose |
|---|---|
| `synapse start [task.yml] [--goal "text"] [--no-monitor]` | Launch a new team + tmux session; sends the goal as the root `TASK` to `manager`. No arg → `.synapse/task.yml` if present, else the built-in example. |
| `synapse runs` | List all runs: id, session, state, times, goal. |
| `synapse status` | Roster for the active run: window, role, model, idle/busy, last-seen, pending count. Flags subtasks whose review chain is still open. |
| `synapse pending [agent] [--all]` | Show pending messages (active run; `--all` = every run). Only marks read if `$SYNAPSE_AGENT` matches the queried agent — safe to inspect anyone read-only. |
| `synapse reply <id> "<body>" [--from operator]` | Answer a message by id; recipient is resolved to its sender. This is how you answer a manager `QUESTION`. |
| `synapse task manager "<text>" --from operator` | Send a follow-up task into a running team. Always to `manager`, never straight to a coder — `manager` owns `ref_id` tracking. (Low-level: `synapse send manager TASK "…"`.) |
| `synapse spawn <role> [--model M] [--focus "text"] [--run-id N]` | Add an agent to a running team; auto-numbers (`coder-2`, …). |
| `synapse stop <name> [--run-id N]` | Mark an agent stopped and close its tmux window. |
| `synapse set-goal "<text>" [--run-id N]` | Update the running run's recorded goal. |
| `synapse ui [--port N]` | Web dashboard (S-Deck); default port 7700. |
| `synapse done` | Close the run — call this once manager's final `REPLY` confirms every subtask chain is done; see Gotchas for the `--force` override form. |
| `synapse init` | Create/migrate the DB. Rarely needed by hand — `start`/`ui` call it. |

The everyday message verbs are `synapse task` / `ask` / `progress` / `reply`
(each carries only that type's flags — including `--handoff <kind>:<file>` to
attach an artifact; `synapse send <to> <type>` is the low-level escape hatch
that still sends any of them). `register`, `monitor`, and the agent-side
commands (`task`/`doc`/`--handoff`) are driven by `start`/`spawn`
or by the agents themselves — you don't run them as operator; they're
documented in the role templates.

## Gotchas

- **Run from the project root** (or export `SYNAPSE_DB`) — wrong cwd silently
  queries an unrelated or nonexistent DB.
- **Operator owns run closure.** Manager never calls `synapse done` — it stops
  at the final `REPLY`. Once that REPLY confirms every subtask chain is
  reviewed (and tested, when required), you call `synapse done`; the
  completion gate refuses to close a run with open chains. To override a stuck
  team instead, use `SYNAPSE_AGENT=operator synapse done --status done --force
  --reason "<why>"` (the `--force` + `--reason` are required and the override
  is logged to `events`).
- **Answer a `QUESTION` with `reply`, not `send`** — `synapse reply
  <question_id> "<choice or free text>" --from operator` routes back to whoever
  asked. The UI's "Chat about this" free-text arrives as the reply body.
- **No unbroken numbered-list bodies** — the message commands reject two-plus
  `(1)`/`(2)` markers with no line breaks. Use `-` bullets, real newlines, or `--body-file`.
- **`broadcast` isn't a recipient** — address a specific agent.
- **Long or backtick-heavy bodies** — use `--body-file -` (stdin) to dodge
  shell interpolation.

## See also

- `tmux` skill — direct pane access for inspection/debugging off the bus.
- `docs/synapse-spec.md` — original design draft; the implementation has since
  diverged (message types are `TASK/QUESTION/PROGRESS/REPLY`). Prefer this
  skill and `synapse help <command>` for current behavior.
