# Critic patch for Task #32

## Analysis

### 1. Root Cause

The trajectory shows all three traceability fields (`source_msg_id`, `trigger_msg_id`, `result_msg_id`) are **missing**, which is the canonical symptom of the orchestrator using `start_task` + `send_message` instead of `delegate_task`. The rules explicitly warn *"NEVER substitute start_task + send_message for delegate_task — that breaks source_msg_id, trigger_msg_id, and result_msg_id wiring"*, yet the agent did exactly that — likely because `delegate_task` is buried in step 2 of the canonical workflow without a hard enforcement mechanism. The 40 tool calls and 165s duration suggest the agent also over-polled or re-sent messages trying to recover, compounding the problem.

---

### 2. Proposed Rule Change

Add a **pre-delegation checklist** as a named, prominently placed rule (Rule 0.5, immediately after Rule 0) that acts as a hard gate:

```diff
--- a/SYNAPSE-orchestrator.md
+++ b/SYNAPSE-orchestrator.md
@@ ## Orchestrator Instructions
 **Rule 0 — Never implement code directly.** [existing text unchanged]
 
+**Rule 0.5 — Never use `start_task` + `send_message` to dispatch worker tasks.**
+
+`delegate_task` is the ONLY permitted call for handing a task to a worker. It
+wires `source_msg_id`, `trigger_msg_id`, and `result_msg_id` automatically.
+Splitting this into `start_task` + `send_message` silently drops all three
+traceability fields and cannot be fixed after the fact.
+
+**Pre-delegation gate — run this mental check before every worker dispatch:**
+
+| Check | Correct call |
+|---|---|
+| Am I about to call `start_task` before `send_message`? | STOP — use `delegate_task` instead |
+| Am I about to call `send_message` without an open activity? | STOP — use `delegate_task` instead |
+| Task spec > ~300 tokens? | Add `task_file: true` to `delegate_task` |
+| Task modifies ≥ 3 lines? | Create worktree first, pass path in `delegate_task` |
+
+If you catch yourself having already called `start_task` without `delegate_task`,
+do NOT proceed. Call `finish_activity(activity_id, status='failed',
+result_msg_id=null)` immediately, then restart the delegation using `delegate_task`.
+
+**Audit step:** After every `delegate_task` call, confirm the response contains
+non-null values for `source_msg_id` and `trigger_msg_id` before proceeding.
+If either is null, treat the delegation as failed and retry.
+
 1. Understand the goal — clarify with the human before delegating
```

---

### 3. Expected Impact

| Metric | Current | Expected after change |
|---|---|---|
| Traceability missing fields (3/3) | Occurs when wrong call sequence used | Drops to 0/3 — `delegate_task` wires all fields automatically |
| Tool calls per task | 40 (inflated by recovery polling) | ~15–20 — eliminates the re-send/re-poll loop caused by broken message linkage |
| Failed traceability tasks across fleet | Unknown baseline | The audit-step catch (checking for null `source_msg_id` on the response) creates an early-exit before the agent spirals into 40+ calls trying to compensate |

The audit step is the critical addition: it converts a *silent* failure (the agent proceeds unaware) into an *immediate* detected failure, capping wasted tool calls at ~5 rather than 40.
