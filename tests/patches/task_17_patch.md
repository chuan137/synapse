# Critic patch for Task #17

## Analysis

### 1. Root Cause

The trajectory shows `source_msg_id` and `result_msg_id` are missing from the activity record. The canonical workflow already warns *"NEVER substitute start_task + send_message for delegate_task"*, but the agent did exactly that — it used `start_task` + `send_message` independently, which breaks the automatic wiring of `source_msg_id` (the message that triggered the task) and `result_msg_id` (the worker's DONE message ID passed to `finish_activity`). The agent also likely called `finish_activity` without supplying `result_msg_id=<DONE msg id>`, either because it forgot or because it never explicitly captured the DONE message ID from `read_messages` before closing the activity.

---

### 2. Proposed Rule Change

The existing canonical workflow already names the problem but buries the consequence in a parenthetical. The fix is to (a) make the forbidden pattern a named, bold **violation**, (b) add an explicit checklist gate before `finish_activity`, and (c) add a short "self-check" block the agent runs before closing any activity.

```diff
--- a/SYNAPSE-orchestrator.md
+++ b/SYNAPSE-orchestrator.md
@@ ## Canonical per-task workflow — follow this sequence exactly:

 ```
 1. Plan          — clarify the task; decide role, worktree needs, file-brief vs inline
 2. delegate_task — opens activity + sends task to worker in one call
                    • large spec (>~300 tokens): pass task_file: true
                      → brief written to .synapse/tasks/<activityId>.md
                      → worker receives short pointer; reads the file before starting
                    • NEVER substitute start_task + send_message for delegate_task —
                      that breaks source_msg_id, trigger_msg_id, and result_msg_id wiring
 3. Wait          — call read_messages each turn until the worker's DONE arrives
                    • do NOT proceed until you have the worker's reply
+                   • When DONE arrives, record the message ID immediately:
+                     done_msg_id = <id field of the DONE message>
+                     You MUST have this value before step 5.
 4. git commit    — integrate the worker's diff; post-commit hook closes the activity
-5. finish_activity(activity_id, status='completed', result_msg_id=<DONE msg id>)
+5. finish_activity — call ONLY after you have all three values confirmed:
+                     • activity_id   → returned by delegate_task in step 2
+                     • status        → 'completed' (or 'failed')
+                     • result_msg_id → done_msg_id captured in step 3
+
+                   ✗ TRACEABILITY VIOLATION — do NOT call finish_activity if:
+                     • activity_id came from start_task instead of delegate_task
+                       (source_msg_id will be NULL — this is an integrity error)
+                     • done_msg_id was never assigned (result_msg_id will be NULL)
+                     Fix: if you used start_task + send_message by mistake, STOP,
+                     report to the human, and do not close the activity until corrected.
+
 6. Update PLAN.md if this commit closes or opens a planned item
 ```
+
+**Traceability self-check (run mentally before every finish_activity call):**
+
+| Field | Source | Null? → Action |
+|---|---|---|
+| `source_msg_id` | set automatically by `delegate_task` from the inbound message | NULL → you used `start_task`; route correction to human |
+| `trigger_msg_id` | set by `delegate_task` from the message you sent to the worker | NULL → `delegate_task` was never called; do not close |
+| `result_msg_id` | the `id` of the worker's DONE reply; YOU must pass it explicitly | NULL → re-read messages, find the DONE, pass its id |
+
+If any field would be NULL, **do not call finish_activity**. Log the gap to the human
+via `send_message(to_id="human", priority=
