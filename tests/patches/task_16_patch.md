# Critic patch for Task #16

## Analysis

### 1. Root Cause

The agent used `start_task` + `send_message` instead of the single `delegate_task` call, which is precisely the anti-pattern the canonical workflow warns against — this directly caused `source_msg_id` and `result_msg_id` to go unwired (2/3 traceability fields missing). The agent also never ran `synapse worktree merge` and thus never triggered the post-commit hook that closes the activity, explaining both the missing commit and the missing `result_msg_id`. In short, the agent ignored the "NEVER substitute" warning because it was buried in a parenthetical note rather than enforced as a numbered rule with observable failure consequences.

---

### 2. Proposed Rule Change

The existing canonical workflow already has the right intent but buries the enforcement signal. The fix is twofold: (a) elevate the `delegate_task` requirement to a named, numbered rule at the same level as Rule 0, and (b) add an explicit checklist the orchestrator must self-verify before calling `finish_activity`.

```diff
--- a/SYNAPSE-orchestrator.md
+++ b/SYNAPSE-orchestrator.md
@@ -Rule 0 block, after "Rule 0 — Never implement code directly." -
+**Rule 1 — Never split delegate_task into start_task + send_message.**
+Using `start_task` followed by a bare `send_message` to hand off work to a worker
+breaks three traceability fields simultaneously: `source_msg_id` (not set because
+no task envelope is created), `result_msg_id` (never wired because the activity has
+no outbound message anchor), and the commit hook (never fires because the activity
+was opened outside the delegate/merge/finish lifecycle). There is no valid reason
+to substitute this pattern. If `delegate_task` is unavailable, stop and escalate to
+the human rather than improvising.
+
+**Rule 2 — Complete the full close sequence before finish_activity.**
+Before calling `finish_activity`, verify ALL of the following — if any box is
+unchecked, resolve it first:
+  - [ ] Worker has replied with an explicit DONE message (you have its message id)
+  - [ ] `synapse worktree merge <slug>` has been run and printed `(ff)` or `(squash)`
+        (skip only if no worktree was created for this task)
+  - [ ] A git commit exists that captures the worker's diff
+  - [ ] You are calling `finish_activity(activity_id, status='completed',
+        result_msg_id=<DONE msg id>)` with the actual DONE message id, not a
+        placeholder
+
+Calling `finish_activity` without a commit or without `result_msg_id` set is a
+traceability violation and will cause the task to appear as failed in the audit log.

 **Canonical per-task workflow — follow this sequence exactly:**
 
 ```
 1. Plan          — clarify the task; decide role, worktree needs, file-brief vs inline
 2. delegate_task — opens activity + sends task to worker in one call
-                   • NEVER substitute start_task + send_message for delegate_task —
-                     that breaks source_msg_id, trigger_msg_id, and result_msg_id wiring
+                   • See Rule 1 — this substitution is prohibited unconditionally
 3. Wait          — call read_messages each turn until the worker's DONE arrives
                    • do NOT proceed until you have the worker's reply
 4. git commit    — integrate the worker's diff; post-commit hook closes the activity
-5. finish_activity(activity_id, status='completed', result_msg_id=<DONE msg id>)
+5. finish_activity(activity_id, status='completed', result_msg_id=<DONE msg id>)
+   • See Rule 2 checklist — run it before this call
 6. Update PLAN.md if this commit closes or opens a planned item
 ```
```

---

### 3. Expected Impact

| Metric | Current | Expected after change |
|---|---|---|
| Traceability completeness (fields present) | 1/3 (33%) | 3/3 (100
