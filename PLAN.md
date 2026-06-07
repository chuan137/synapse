# Synapse — Active Plan

## Channels API Migration (deferred — implement when ready)

Reference: https://code.claude.com/docs/en/channels-reference  
Requires: Claude Code v2.1.80+ (push), v2.1.81+ (permission relay)  
Flag needed during research preview: `--dangerously-load-development-channels server:synapse-bus`

### What it replaces

| Current | After |
|---|---|
| 500ms tmux send-keys poller (`pingAgent`) | `server.notification()` push from mcp-server.ts |
| Guard hook blocking poll loop | Native permission relay (`claude/channel/permission`) |
| ~500ms message delivery latency | <50ms push delivery |

### Phase 1 — Push delivery (highest priority, low risk)

**mcp-server.ts:**
- Add `experimental: { 'claude/channel': {} }` to Server capabilities
- Add `instructions` string describing `<channel source="synapse-bus">` tag format
- After `server.connect()`, start a 200ms DB poll loop that fetches new messages for `AGENT_ID` and pushes each via `server.notification({ method: 'notifications/claude/channel', params: { content, meta } })`
- Mark messages read after pushing

**src/index.ts (synapse run):**
- Add `--dangerously-load-development-channels server:synapse-bus` to claude args during preview
- Optionally: detect `claude --version` >= 2.1.80 and only add the flag if supported

**src/dashboard.ts:**
- Remove `pingAgent()` function (lines 287–294)
- Remove the `nudgedMsgId` map and idle-agent tmux nudge block from the 500ms poller (lines 115–166)
- Keep the poller at a longer interval (5s) for UI state refresh only
- Keep `tmux_pane` for spawn/kill/restart operations

### Phase 3 — Permission relay (replaces guard hook blocking loop)

**mcp-server.ts:**
- Add `'claude/channel/permission': {}` to Server experimental capabilities
- Add `setNotificationHandler` for `notifications/claude/channel/permission_request`
  - Insert into `approval_requests` table (S-Deck already polls and shows the card)
  - Store `request_id` alongside the approval request row
- In `POST /api/approvals/:id/resolve` (dashboard.ts), emit `notifications/claude/channel/permission` verdict via the `server.notification()` instance

**src/hooks/guard.ts:**
- Remove the 10-minute poll loop (the blocking wait for `approval_requests` resolution)
- Keep the lint checks (delegate_task requires source_msg_id, send_message to human requires needs_approval) — these are validation, not approval

**Caveats:**
- Permission relay covers Bash/Write/Edit only; project trust dialogs still need local terminal
- Must be gated on v2.1.81+

### Phase 2 — Skip

Channel reply tool would duplicate existing `send_message` MCP tool. No value to add.

### Phase 4 — Cleanup (after Phase 1 stable)

- Remove `pingAgent()` dead code
- Remove `getIdleAgentsWithUnreadSignature()` DB query
- Remove tmux send-keys call in model switching (replace with channel notification or remove)

---

## Other deferred items

- **Guard hook: orchestrator file-edit enforcement** — Option B: add file-extension check in guard hook to block orchestrator (slot 0) from editing `.ts`/`.js`/`.html`/`.css` files directly. Prevents the orchestrator from bypassing the delegate-to-worker rule mechanically.

---

## Context management & session lifecycle

Motivation: 73% of token usage in long sessions comes from MCP tool results (each `read_messages` response stays in context for the session). Auto-restart + handover docs keep sessions lean.

### Worker auto-restart after N tasks

After a worker completes N tasks in the same session (suggested threshold: 5), the orchestrator kills and respawns it. The restart is already supported via `POST /api/agents/:agentId/restart`. What to add:
- Track `tasks_completed_this_session` per agent (can be derived from DB: count tasks finished since the agent's `started_at`)
- After `finish_task`, orchestrator checks the worker's task count; if >= threshold, trigger restart before delegating the next task
- Include the last DONE report as context in the new session's boot task

### Orchestrator restart with handover doc

Before the orchestrator's context grows too large (or on explicit operator request), auto-generate a handover doc and restart:
- Handover doc written to `.synapse/handover-<timestamp>.md` containing: in-flight tasks, last 5 messages per agent, recent DECISION/FINDING events, current PLAN.md state
- The doc becomes the new orchestrator's boot task
- Trigger: operator sends "handover" or after N turns, or when context warning appears

### Handover doc as default for large task dispatches

- Make `task_file: true` the default in `delegate_task` when task content exceeds ~300 tokens (already supported, just needs to be automatic)
- Reduces inline context growth from task dispatch messages accumulating in the session

### Context-size warning

In `mcp-server.ts`, after N `read_messages` calls in a session (e.g. 20), inject a system note in the response reminding the agent to `/compact`. Low effort, reduces context blindness.
