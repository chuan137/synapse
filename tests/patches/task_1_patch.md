# Critic patch for Task #1

## Analysis

### 1. Root Cause

The trajectory shows all three traceability fields (`source_msg_id`, `trigger_msg_id`, `result_msg_id`) are missing, which is the canonical symptom of the orchestrator using `start_task` + `send_message` instead of `delegate_task`. The orchestrator rules explicitly warn *"NEVER substitute start_task + send_message for delegate_task — that breaks source_msg_id, trigger_msg_id, and result_msg_id wiring"*, yet the agent did exactly that. The high tool-call count (24) and long duration (838s) suggest the agent also ran multiple monitoring/retry loops that `delegate_task` would have handled atomically, compounding the traceability gap with unnecessary overhead.

---

### 2. Proposed Rule Change

The existing warning is buried as a parenthetical bullet inside step 2 of the canonical workflow. It needs to be elevated to a named, numbered rule with the same weight as Rule 0 (never implement code directly), and it needs a detectable self-check the agent can apply before acting.

```diff
--- a/SYNAPSE-orchestrator.md
+++ b/SYNAPSE-orchestrator.md
@@ -Rule 0 block, after the existing Rule 0 paragraph -

+**Rule 1 — Never use `start_task` + `send_message` to delegate worker tasks.**
+`delegate_task` is the ONLY permitted call for opening an activity and routing work
+to a worker. Using `start_task` followed by `send_message` severs the
+`source_msg_id` / `trigger_msg_id` / `result_msg_id` traceability chain and will
+produce a permanently incomplete activity record.
+
+**Self-check before every delegation:** ask yourself:
+  - "Am I about to call `start_task` AND `send_message` for the same worker task?" → STOP. Use `delegate_task` instead.
+  - "Is this work I am doing myself (doc edit, investigation)?" → `start_task` is correct.
+  - "Is this work I am routing to a worker?" → `delegate_task` only, no exceptions.
+
+If `delegate_task` is unavailable or returns an error, escalate to the human
+immediately via `send_message(to_id="human", priority=0)` — do NOT fall back to
+`start_task` + `send_message` as a workaround.

 **Canonical per-task workflow — follow this sequence exactly:**

 ```
 1. Plan          — clarify the task; decide role, worktree needs, file-brief vs inline
 2. delegate_task — opens activity + sends task to worker in one call
-                  • large spec (>~300 tokens): pass task_file: true
-                    → brief written to .synapse/tasks/<activityId>.md
-                    → worker receives short pointer; reads the file before starting
-                  • NEVER substitute start_task + send_message for delegate_task —
-                    that breaks source_msg_id, trigger_msg_id, and result_msg_id wiring
+                  • large spec (>~300 tokens): pass task_file: true
+                    → brief written to .synapse/tasks/<activityId>.md
+                    → worker receives short pointer; reads the file before starting
+                  • See Rule 1 — substituting start_task + send_message is
+                    PROHIBITED and will fail the traceability audit.
 3. Wait          — call read_messages each turn until the worker's DONE arrives
```

Additionally, add a lint note at the top of the file:

```diff
+> **Audit note:** Any completed activity with `source_msg_id`, `trigger_msg_id`,
+> or `result_msg_id` missing is evidence of a Rule 1 violation. Review the
+> orchestrator's tool-call log for a `start_task` call that preceded a
+> `send_message` to a worker.
```

---

### 3. Expected Impact

| Metric | Current | Expected after change |
|---|---|---|
| Traceability missing fields per task | 3/3 (100%) | 0/3 (0%) — `delegate_task` populates all three atomically |
