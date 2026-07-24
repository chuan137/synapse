# Synapse — Shared Protocol

You are one agent in a Synapse team: separate Claude Code sessions in tmux
windows, coordinating through a shared SQLite mailbox.

`SYNAPSE_DB`, `SYNAPSE_AGENT`, `SYNAPSE_PROJECT_ROOT`, and `SYNAPSE_WORKDIR` are pre-exported.

- `SYNAPSE_PROJECT_ROOT` — the directory containing `.synapse/` (synapse home).
- `SYNAPSE_WORKDIR` — the code repo to work in. **Always use this for git operations, worktrees, builds, and tests.** It equals `SYNAPSE_PROJECT_ROOT` unless `--workdir` was passed to `synapse start`.

## Bootstrap

Your launch prompt is just `synapse pending <your-name>`. Run it once on
launch to pull work. The monitor re-sends it when new work arrives — don't
call it again mid-turn.

## Roles

`operator` → `manager` → `coder` / `reviewer` / `tester`

Manager is the hub. Coders send review TASKs peer-to-peer to reviewers.
Testers report to manager. Nothing else bypasses manager.

## Message types

| Type | Intent verb | When to use |
|------|-------------|-------------|
| `TASK` | `synapse task <to> "<body>"` | Assign work; sender expects a REPLY when done |
| `QUESTION` | `synapse ask <to> "<body>" --options a,b,c` | Blocking question — halt until answered |
| `PROGRESS` | `synapse progress <to> "<body>"` | One-way lifecycle marker; no reply expected |
| `REPLY` | `synapse reply <id> "<body>"` | Close a TASK or QUESTION; routes to sender of `<id>` |

`synapse send <to> <type> "<body>"` is the low-level escape hatch; prefer the
intent verb (it nudges you on stderr).

**`synapse send ... REPLY` is rejected** — `reply` is the only path.

> REPLY vs PROGRESS: if the recipient must read it to act → REPLY. If it only
> signals activity → PROGRESS.

## Handoff docs

Long artifacts (specs, plans, reviews) go to files; messages point at them.
The canonical path is derived from `run-id + ref-id + kind` — never guess it.

```bash
# Attach a doc TO a message (writes file + appends path to body):
# kind ∈ spec | plan | testplan | review | notes
synapse reply <id> "LGTM" --handoff review:./review.md
synapse task coder-1 "Build per the plan" --ref-id <root_id> --handoff plan:./plan.md

# Write a doc with NO message (reference the printed path later):
synapse doc testplan <root_id> ./testplan.md
```

### Plan doc format

The plan doc **must** use this checklist format — `synapse doc plan` parses
the `## Plan` section to populate step records, which `synapse step` ticks:

```markdown
## Plan

- [ ] Step one description
- [ ] Step two description
- [ ] Step three description

## Notes

Optional free-text: constraints, risks, decisions worth recording.
```

Steps are coarse units a coder can tick off — aim for 3–7 per task, not one
per file edit and not one for the whole task.

### Reporting step progress

```bash
# Tick step N done and emit a notification to operator:
synapse step <root-id> <n> "What actually happened at this step"
```

`root-id` is the same ref-id used when the plan was written. Steps only exist
if the plan was written with `synapse doc plan` or `--handoff plan:<file>`.
For unplanned tasks, `[start]`/`[done]` are the only notifications.

## Direct PROGRESS to operator (coder / reviewer / tester only)

Send `PROGRESS` straight to `operator` — bypassing manager — only as lifecycle
markers. Body must start with one of these tags:

- `[start]` — once, right after accepting a TASK
- `[done]` — once, right before the REPLY that closes it out
- `[blocked]` — if stalled on something not yet a QUESTION

The harness rejects a direct-to-operator PROGRESS from a non-manager agent
with any other tag. Mid-task progress is reported via `synapse step` (see
Handoff docs) when a plan exists — not as ad-hoc PROGRESS messages.

## QUESTION rules

- `--options` is **required** on every `ask` to `operator` (the UI card has no
  fallback; `synapse ask` rejects without it). Pass `--title` for a short header.
- 2–4 real, distinct choices. The UI always appends "Chat about this" for
  free-text — a missed option isn't a dead end.
- One QUESTION in flight at a time. After sending it, send nothing else until
  the REPLY arrives.

## Only communicate through the mailbox

**No `AskUserQuestion`, `EnterPlanMode`, or `tmux send-keys` to other agents.**
Those bypass the mailbox — invisible to operator and manager. Questions go via
`synapse ask`; inter-agent messages via the message verbs.

## ref_id

`synapse reply <id>` routes to the sender of message `<id>` — you can't
misroute it. Track open work via `synapse pending` and DB queries, not context.
Note the id printed when you `synapse task` so you can track the chain.

## Communication rules

1. **Reply with the full result** — concrete: what changed, outcome, evidence.
   "Done" alone is not a result.
2. **Send `[start]`/`[done]` PROGRESS; stay silent otherwise.** Milestones are
   one-way markers, not questions or summaries.
3. **One QUESTION at a time.** Block and wait; do not guess and proceed.

## Language

English or Chinese everywhere — thinking, messages, comments, code docs.
