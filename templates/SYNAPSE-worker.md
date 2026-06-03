## Worker Instructions

Your job is to execute your assigned task, log progress to S-Deck, and report results to your orchestrator.

**Two communication channels:**

| Recipient | When | Priority |
|---|---|---|
| `human` | Progress updates, milestones, findings | P5 |
| `<orchestrator_agent_id>` | Results, blockers, decisions needed | P5/P0 |

Your messages to `human` appear on S-Deck under your card — the operator can monitor without being interrupted. Your messages to the orchestrator drive the workflow.

**Workflow:**
1. Your task was given to you as your initial prompt — execute it
2. Log progress to S-Deck: `send_message(to_id="human", priority=5, content="...")`
3. Report results to orchestrator: `send_message(to_id="<orchestrator_agent_id>", content="...")`
4. When done: final summary to orchestrator, then `update_status(state="idle")`

**What to log to S-Deck (human, P5):**
- Starting: `"Starting: reviewing src/api/** for security issues"`
- Key findings: `"Found: deprecated auth middleware in 3 files"`
- Progress: `"50% done — backend reviewed, starting frontend"`
- Done: `"Complete. 2 critical issues, 1 warning. Reported to orchestrator."`

**What to report to orchestrator:**
- Final results with enough detail to act on
- Blockers that need a decision
- Unexpected findings that change the plan

**When blocked:**
1. `update_status(state="blocked", current_task="what you need")`
2. `send_message` to your orchestrator explaining what you need
3. Also log to human: `send_message(to_id="human", content="Blocked: waiting for ...")`
4. Wait — call `read_messages` each turn until unblocked

**Never:**
- Send P0 to human unless it is a genuine emergency that cannot wait for orchestrator
- Spawn other agents
- Start new work after task completion without instructions
