# E2E Run Issues — 2026-06-27

Problems encountered during the first real team run (operator UI task).

## 1. Session ID capture fails

**Symptom:** `synapse start` times out waiting for session ID from every agent, registers them with `session_id="-"`.

**Root cause:** The capture mechanism pipes claude's stdout through `grep` to extract the banner line (`Starting session <id>`). But `claude` is a TUI and requires a real TTY — as soon as stdout is piped, claude exits immediately.

**Workaround applied:** Switched to `script -q /dev/null claude` to provide a pseudo-TTY. Claude now starts correctly, but session ID capture still fails because `script` output can't be piped.

**Correct fix (agreed, not yet implemented):** After launching claude (with `script`), poll `~/.claude/projects/<slug>/` for a new `.jsonl` file that didn't exist before launch. The filename is the session ID. Slug is derived from the agent's absolute cwd by replacing `/` with `-`.

---

## 2. Monitor idle detection is broken without session ID

**Symptom:** All agents show `status=unknown` permanently. Monitor log shows only the startup line — no activity after that.

**Root cause:** `pollOnce()` queries `WHERE session_id IS NOT NULL`, so agents with `session_id="-"` are skipped entirely. No idle detection → no automatic message delivery.

**Consequence:** Every message delivery must be done manually with `tmux send-keys`.

**Fix (agreed, not yet implemented):** Fix session ID capture (issue #1) first. As fallback, `pollOnce` should not filter out agents with empty session IDs — use tmux pane prompt detection (`❯` at end of pane) as a fallback idle signal.

---

## 3. `synapse deliver` does not actually deliver

**Symptom:** Running `synapse deliver <id>` marks the message as `delivered` in the DB but does NOT send it to the agent's tmux window.

**Root cause:** `cmdDeliver` only updates the DB status. The actual `tmux send-keys` call lives in `dispatchNextDirectMessage`, which is only triggered by the monitor's idle detection loop.

**Fix needed:** Either `cmdDeliver` should also do `tmux send-keys`, or document clearly that it's a DB-only operation and provide a separate manual-delivery command.

---

## 4. Missing Enter on message delivery

**Symptom:** Monitor (and manual send-keys) injects the message text into the agent's input box but does NOT send it — the agent sits waiting for Enter.

**Root cause:** `dispatchNextDirectMessage` calls `tmux send-keys -t <target> "<message>"` but does not append `Enter` (or sends it as a separate call that may not arrive). The message is visible in the input box but never submitted.

**Status:** **Fixed** — `tmuxSendKeys` sends the message body literally with `tmux send-keys -l -- <message>`, then immediately sends `tmux send-keys <target> Enter`. Covered by `tests/monitor.test.ts` and `tests/e2e-monitor.sh`.

---

## 5. Agent permission prompts block automation

**Symptom:** Every file read, edit, and bash command triggers a permission confirmation dialog inside each agent window. This completely breaks unattended operation — a human must sit and press `1` or `2` repeatedly.

**Fix options:**
- **Option A:** Add `.claude/settings.json` to each agent's cwd with pre-approved permission patterns (`Read(*)`, `Edit(*)`, `Bash(synapse*)`, `Bash(make*)`, etc.)
- **Option B:** Launch claude with `--dangerously-skip-permissions` flag in `launchAgentWindow`.
- Option B is simpler for a controlled single-machine environment; Option A is more surgical.

---

## 6. Monitor delivers one message at a time — too conservative

**Symptom:** When an agent has multiple pending messages, monitor delivers them one by one, waiting for the next idle cycle between each delivery.

**Root cause:** `dispatchNextDirectMessage` fetches only the oldest pending message and delivers it, then stops. The assumption is the agent needs to process each message before receiving the next.

**Why this is wrong:** Claude can handle multiple messages at once — it reads the full input and decides how to act. Delivering one message at a time adds unnecessary latency and round-trips.

**Fix:** Replace `dispatchNextDirectMessage` with `dispatchAllPendingMessages` — concatenate all pending messages for an agent into a single `tmux send-keys` call, delivered together when the agent goes idle.

---

## 7. Task handoff via message body — should use handoff files instead

**Symptom:** Planner sends coder a TASK message with the full spec inline (50-200 lines). Coder sends reviewer a REVIEW message with the full checklist inline. All context travels through the SQLite `messages.body` field and `tmux send-keys`.

**Why this is wrong:**
- `tmux send-keys` has practical length limits; long messages get truncated or garbled
- Special characters (`#`, backticks, quotes) in message bodies break shell quoting
- The message bus is designed for signaling ("go look at X"), not for carrying specs
- Bloats the DB and makes `synapse pending` output unreadable

**Correct pattern:** Message body is a pointer only. Actual spec/context lives in a handoff file.

```
# Planner → Coder-1
synapse send coder-1 TASK "See .synapse/tasks/task-001-backend.md" --from planner

# Coder-1 → Reviewer  
synapse send reviewer REVIEW "See .synapse/tasks/task-001-backend.md (results in task-001-backend-result.md)" --from coder-1

# Reviewer → Planner
synapse send planner STATUS "LGTM. See .synapse/tasks/task-001-backend-review.md" --from reviewer --ref-id N
```

**Handoff file location:** `.synapse/tasks/<task-id>-<role>.md` — one file per task per role transition. Agent reads the file, does the work, writes results to a sibling file, then sends a short message pointing at it.

**Impact:** Fixes tmux quoting issues, keeps messages scannable, and gives each agent a durable written spec to re-read if needed.

---

## Summary

| # | Issue | Status |
|---|-------|--------|
| 1 | Session ID capture fails (TTY vs pipe conflict) | **Fixed** — pass `--session-id <uuid>` at launch |
| 2 | Monitor broken without session ID | **Fixed** — unblocked by #1 |
| 3 | `synapse deliver` DB-only, no tmux send | Fix needed |
| 4 | Missing Enter on message delivery | **Fixed** — body + immediate Enter send |
| 5 | Agent permission prompts block automation | Fix needed |
| 6 | Monitor delivers one message at a time, too conservative | Fix needed |
| 7 | Task handoff via message body — should use handoff files | Fix needed |
