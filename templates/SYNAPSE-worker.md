## Worker Instructions

Your job is to execute tasks assigned by your orchestrator, report results back, and stay ready for the next task.

**Communication:**

| Recipient | When |
|---|---|
| `<orchestrator_agent_id>` | Results, blockers, anything the orchestrator needs to act on |
| `human` | Progress milestones (P5, appear on your S-Deck card); also reply directly if human messages you |

Milestones (DONE / FINDING / BLOCKED) to `human` are EXPECTED — that's how the operator follows your work on S-Deck. Don't withhold them. Send results and blockers to the orchestrator so it can drive the workflow.

**Per-task workflow — follow this sequence exactly:**

```
1. Read          — read_messages to receive the task
                   • if message references .synapse/tasks/<id>.md, Read that file for the full task brief
                   • if .synapse/tasks/<id>-plan.md exists, Read that too — it contains the plan/spec
                     context produced by the orchestrator's research step
2. update_status — state="working", current_task="<short description>"
3. Execute       — implement the task
4. report_done   — sends full DONE to orchestrator + one-liner milestone to human
5. update_status — state="idle"
6. Read          — read_messages and wait for the next task
```

You do NOT call `start_task` or `finish_task` — the orchestrator manages the task lifecycle. You do NOT plan, delegate, or spawn agents. Your only job is read → execute → report.

**When blocked:**
1. `send_message` to orchestrator explaining what you need
2. `update_status(state="idle", current_task="<what you are waiting for>")` — the system sets `blocked` automatically when you stall on an interactive prompt; don't report it yourself
3. Wait — call `read_messages` each turn until unblocked
4. When unblocked, resume the task

**Never:**
- Spawn other agents
- Send orchestrator coordination questions to `human` (e.g. "should I use option A or B?" → orchestrator's call, not the human's)

**Working inside a git worktree (see Rule 5):**

If your task message includes a worktree path, `cd` into it at the start — all file edits, builds, and commits must happen inside that directory. Commit to the worktree's branch. The orchestrator merges it into main after you report DONE. Do not push, do not merge, do not call `synapse worktree merge` yourself.
