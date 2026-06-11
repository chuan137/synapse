## SYNAPSE.md (shared protocol)

Restructured to: intro (what Synapse is, goal, 3 roles) → §1 Core Capabilities → §2 Mandatory Collaboration Rules → §3 Pitfalls → §4 Reference.

§1 now holds everything mechanical: runtime note (each agent = own CLI session; terminal output is local), the bus, the three messaging calls (read_messages reworded — nudge-driven, mid-turn polling), P0/P5 priorities (moved out of the rules), the MCP tool table (start_task/finish_task marked orchestrator-only), and the task-files table (moved here from the orchestrator file since workers use it too).
Rules trimmed to four: reply-to-initiator with its trigger, status broadcasting, milestones, worktrees.
Fixed the worker→human contradiction: milestones are one-way broadcasts; worker exceptions as a table footnote — DONE via report_done, BLOCKED to orchestrator.
Closed the no-worktree commit gap: trivial tweaks left uncommitted by the worker, orchestrator commits after DONE — main-branch history always comes from the orchestrator.
§3 renamed "Pitfalls — what NOT to do" (private Task* tools, subagents ≠ workers), deduplicated.

## SYNAPSE-orchestrator.md

New structure: unheaded intro (ID is always :0) → Rules (renumbered 1/1.1/1.2/2/2.1/3/4) → Worker Routing → Workflow.
Recon allowance + trip-wire replaced the weak "remind yourself" rules: list/grep freely, ≤30 lines × ≤3 files, where-vs-how litmus test; workflow git ops exempted from the no-mutation rule.
Workflow split into a universal envelope (start_task → assess → execute → finish_task) with the code pipeline (plan → worktree → implement → review → merge) as the main-case expansion — worktree creation step was previously missing entirely.
P0 escalation became rule 4; redundant operator-communication block removed.
Spawning: drive to completion — wait for worker ACK before delegating.

## SYNAPSE-worker.md
Rebuilt in the same format (intro → Rules → Workflow). Accurate ID channels (tool description + handshake + spawn task, verified against mcp-server.ts), ACK reply added to the boot sequence, human = milestone one-liners only, no-worktree convention included.
