# Critic patch for Task #27

## Analysis

### 1. Root Cause

The trajectory shows all three traceability fields (`source_msg_id`, `trigger_msg_id`, `result_msg_id`) are missing, which is the exact failure mode the canonical workflow warns about when `start_task + send_message` is substituted for `delegate_task`. The orchestrator almost certainly used `start_task` + `send_message` manually instead of the single `delegate_task` call, breaking the automatic wiring of message IDs that `delegate_task` performs atomically. This is confirmed by the fact that a commit *was* made (the work succeeded technically) but the activity record has no message linkage — the plumbing was bypassed, not the work itself.

---

### 2. Proposed Rule Change

The existing warning exists but is buried as a bullet under step 2. The fix is to make it a **hard numbered rule** at the same visual weight as Rule 0, and to add a pre-flight checklist that fires before any delegation:

```diff
--- a/SYNAPSE-orchestrator.md
+++ b/SYNAPSE-orchestrator.md
@@ -  **Rule 0 — Never implement code directly.** ...
 
+**Rule 1 — Never split delegate_task into start_task + send_message.**
+`delegate_task` is the *only* permitted way to open an activity and route a task
+to a worker. It wires `source_msg_id`, `trigger_msg_id`, and `result_msg_id`
+atomically. Using `start_task` followed by `send_message` silently produces an
+activity with all three traceability fields missing — the task may complete, but
+the activity record is unauditable and finish_activity will log a broken trace.
+
+**Pre-delegation checklist (run mentally before every worker routing):**
+- [ ] Am I about to call `start_task` + `send_message`? → STOP. Use `delegate_task` instead.
+- [ ] Does my `delegate_task` call include either inline `task:` content or `task_file: true`? → Required.
+- [ ] Do I have the worker's agent_id from `pick_worker` or `list_workers`? → Required before calling.
+
+Violation of this rule is detectable post-hoc: if `finish_activity` is called on
+an activity where any of `source_msg_id`, `trigger_msg_id`, or `result_msg_id`
+is null, the orchestrator MUST NOT mark it `completed` — it must reopen the
+activity, locate the correct message IDs from `read_messages` history, and patch
+them before closing.
+
 **Rule 0 — Never implement code directly.** ...
```

Additionally, harden the canonical workflow step 2 to reinforce the prohibition inline:

```diff
 2. delegate_task — opens activity + sends task to worker in one call
-                   • NEVER substitute start_task + send_message for delegate_task —
-                     that breaks source_msg_id, trigger_msg_id, and result_msg_id wiring
+                   • ⛔ NEVER substitute start_task + send_message for delegate_task.
+                     This is Rule 1. Violation produces 3/3 missing traceability fields
+                     with no runtime error — the failure is silent and only visible
+                     after the fact in the activity record.
+                   • If you are unsure whether delegate_task was used: check the
+                     activity record for source_msg_id before proceeding to step 3.
```

---

### 3. Expected Impact

| Metric | Current | Expected after change |
|---|---|---|
| Tasks with 3/3 missing traceability fields | Occurs (as in this trajectory) | Drops to ~0% for correctly-executed orchestrator runs — the pre-delegation checklist creates an explicit gate before the wrong path is taken |
| Silent completion of broken activities | Possible (commit made, fields missing, status=completed) | Eliminated — the new recovery rule forces the orchestrator to patch IDs before closing, so `completed` status becomes a meaningful signal |
| Time to detect the error | Post-hoc review only | Detectable at `finish_activity` call time, same session |

The core improvement is converting a **silent failure**
