# Telegram bot remote access — Phase 1 design plan

**Date:** 2026-06-09
**Author:** developer-37
**Status:** Pending operator review

---

## 1. Executive summary

The Telegram bot bridge lets the operator control Synapse from any Telegram client. Operator messages typed in Telegram are forwarded to a target agent via the local Synapse bus; agent replies, milestones, and approval requests are sent back to the operator's Telegram chat. The bot runs as a long-lived sidecar process (`synapse remote --telegram`), managed in its own tmux pane alongside the orchestrator and workers. No public port is required — the bot polls Telegram's API over outbound HTTPS only, and connects to `http://localhost:<port>` for Synapse. When the bot is offline, S-Deck continues to work normally.

---

## 2. Architecture

```
Operator phone
      │
      ▼ HTTPS (outbound only)
 Telegram servers
      │
      │  long-poll getUpdates (bot → TG, pull)
      ▼
 ┌────────────────────────────────────┐
 │  synapse remote --telegram sidecar │
 │  src/remote/telegram.ts            │
 │                                    │
 │  Inbound loop:                     │
 │    getUpdates → POST /api/messages │  (operator → agent)
 │                                    │
 │  Outbound loop:                    │
 │    GET /api/state poll (every 2s)  │  (agent → operator)
 │    → sendMessage to Telegram chat  │
 │                                    │
 │  Approval loop:                    │
 │    inline keyboard click           │
 │    → POST /api/messages/:id/approve│
 └────────────────┬───────────────────┘
                  │ HTTP (localhost only)
                  ▼
 ┌────────────────────────────────────┐
 │  Synapse dashboard server          │
 │  src/dashboard.ts                  │
 │                                    │
 │  POST /api/messages                │  ← operator → agent
 │  GET  /api/state                   │  ← bot polls for new to_id=human msgs
 │  POST /api/messages/:id/approve    │  ← operator approves from Telegram
 │  POST /api/messages/:id/select-option│← operator selects an option
 └────────────────┬───────────────────┘
                  │
                  ▼
         Synapse bus (SQLite)
                  │
                  ▼
         Orchestrator / Workers
         (unaware of Telegram)
```

**Direction summary:**
- Operator → agent: bot receives Telegram message → `POST /api/messages`
- Agent → operator: bot polls `GET /api/state` every 2s, forwards new `to_id=human` messages to Telegram
- Approval: agent sends `needs_approval=true` → bot surfaces inline keyboard → operator clicks → `POST /api/messages/<id>/approve`

**Key finding:** S-Deck uses SSE (`GET /events`) for live updates, but the bot cannot use SSE easily in a simple polling loop. `GET /api/state` (already exists at `dashboard.ts:347`) returns all recent messages including `to_id=human` — the bot uses this endpoint with a cursor (last seen message ID) to detect new messages. No new server endpoint needed.

---

## 3. Components

### 3a. Telegram side

**Bot token:** Read from env var `SYNAPSE_TELEGRAM_TOKEN` at startup. Bot exits with a clear error if unset. Never committed to git. Obtained via BotFather (one-time setup).

**Long-poll vs webhook:** Long-poll for v1. No public endpoint, no certificate management, works behind NAT. `getUpdates` with `timeout=25` (25-second long-poll). On restart, pass the last `update_id + 1` as `offset` to avoid reprocessing.

**Allowlist:** Single env var `SYNAPSE_TELEGRAM_ALLOWED_CHATS` (comma-separated chat_ids). Any message from an unlisted chat_id is silently ignored (no reply — avoids enumerating the bot to attackers). For the simplest v1, allow a single operator chat_id.

### 3b. Sidecar process

**CLI entry:** `synapse remote --telegram` (long-lived process).

**Two concurrent loops** using `setInterval` / `Promise.race`:

```
Loop A — Inbound (Telegram → Synapse)
  every 25s (long-poll), or shorter if TG returns immediately:
  1. getUpdates(offset, timeout=25)
  2. For each update:
     a. Reject if chat_id not in allowlist
     b. Parse routing prefix (`@<slot> <text>` or sticky target)
     c. POST /api/messages { to_id, content, priority }
  3. Advance offset

Loop B — Outbound (Synapse → Telegram)
  every 2s:
  1. GET /api/state (returns recent 200 messages)
  2. Filter: to_id=human AND id > lastSeenMsgId
  3. For each new message:
     a. Format: "[from_id][type] content"
     b. If needs_approval=true: attach inline keyboard (Approve, Reject)
     c. If request_options: attach inline keyboard (one button per option)
     d. sendMessage / sendMessageWithInlineKeyboard to TG
  4. Update lastSeenMsgId
```

**Restart resilience:**
- Telegram side: `update_id` offset persisted to `.synapse/telegram-offset.txt` (written after each batch). On restart, read it to resume without replaying. If file missing, start from `offset=0` (accepts some replay risk for simplicity).
- Synapse side: `lastSeenMsgId` read from `GET /api/state` at startup — take max(id) of all existing `to_id=human` messages so we don't flood the operator with old history on restart.

**Process model:** tmux-managed, same as orchestrator/workers. `synapse remote --telegram` is launched manually by the operator (or added to `synapse start` in a later phase). Tmux pane title: `[remote:telegram]`.

### 3c. Bus integration

**Routing (operator → agent):** `@<slot>` prefix. Operator types `@0 what's the status?` → bot routes to agent in slot 0. Reason: S-Deck shows agents by slot; operator already thinks in slot terms. If no prefix and no sticky target set, bot replies "specify target: @0 <message>". Sticky-target state per chat (persisted in memory) is a Phase 2 enhancement.

**Message format (agent → operator):**
```
[:37 developer] DONE — Fixed auth bug (commit abc123)
#1234 | 2 min ago
```
Include: sender slot/role, message type badge, first 500 chars of content, message ID, age.

**Approvals:** When `needs_approval=true`, bot sends the message with an inline keyboard:
```
[✓ Approve]  [✗ Reject]
```
On callback_query: POST `/api/messages/<id>/approve` (or `/api/approvals/<id>/resolve`). See §3d below.

**Request options:** When `request_options` is set, bot renders one button per option. On callback_query: POST `/api/messages/<id>/select-option` with `{ option_index }`.

### 3d. Approval endpoint finding

The investigation found **two** approval mechanisms in `dashboard.ts`:
- `POST /api/messages/:id/approve` (line 391) — the message-level approve for `needs_approval` messages
- `POST /api/approvals/:id/resolve` (line 360) — for `approval_requests` table (separate feature)

The bot should use `/api/messages/:id/approve` for the message-level approval that agents use (e.g., `request_approval` MCP tool sends `needs_approval=true`).

---

## 4. Auth & security

| Concern | Design |
|---|---|
| Bot token | `SYNAPSE_TELEGRAM_TOKEN` env var. Process exits if unset. Never committed. |
| Allowed operator chats | `SYNAPSE_TELEGRAM_ALLOWED_CHATS` env var (comma-separated chat_ids). Reject silently if not listed. |
| HTTP | `http://localhost:<port>` only. Port from `SYNAPSE_DECK_PORT` (already used in mcp-server.ts). |
| TLS (Telegram side) | Handled by the chosen library. Verify it uses Node's native TLS (no `rejectUnauthorized: false`). |
| Message replay on restart | Offset file prevents Telegram replay. Synapse cursor prevents flooding on reconnect. |
| No server-side auth | `/api/messages` has no auth today (finding from investigation). This is acceptable for localhost-only access since the attacker would need local machine access to reach it. If public exposure is ever added, auth must come first. |

---

## 5. Library choice

**Recommended: `node-telegram-bot-api`** (npm: `node-telegram-bot-api`)

Reasons:
- Maintained, 7k+ stars, TypeScript types via `@types/node-telegram-bot-api`
- Supports both long-poll and webhook modes
- Low dependency count vs `telegraf` (telegraf's middleware model is overkill for a simple bridge)
- `new TelegramBot(token, { polling: true })` — one line to start

Alternative: `telegraf` is more ergonomic for complex bots but adds ~300KB and a middleware stack the bridge doesn't need.

**Install:**
```sh
npm install node-telegram-bot-api
npm install -D @types/node-telegram-bot-api
```

Estimated dependency weight: ~500KB. No native binaries. No heavy transitive deps.

---

## 6. Failure modes & graceful degradation

| Failure | Behavior |
|---|---|
| Bot process dies | Synapse continues normally. Operator falls back to S-Deck. |
| Telegram API unreachable | Long-poll timeout fires, loop retries with backoff (1s, 2s, 4s, max 30s). Logs warning every retry. |
| Synapse server dies | `GET /api/state` returns ECONNREFUSED. Bot catches, sends "⚠ Synapse offline" to Telegram chat, retries every 10s. |
| Network partition | Long-poll naturally handles it — `getUpdates` re-connects. |
| Bot token revoked (BotFather) | Telegram API returns 401. Bot logs error, exits with code 1 (clean exit for tmux restart policy). |
| Unknown chat_id messages | Silently ignored. No reply (avoids enumeration). |
| `/api/messages` returns non-200 | Bot logs the error + body, skips that message. Does not crash. |

---

## 7. Implementation sketch

**File layout:**
```
src/remote/
  telegram.ts       — TelegramBridge class: constructor(token, allowedChats, port)
                      methods: start(), stop(), handleUpdate(), pollSynapse()
  index.ts          — `synapse remote` subcommand (Commander.js, same pattern as eval-summarize)
  auth.ts           — allowlistCheck(chatId, allowedChats): boolean
```

**Key src/index.ts change:**
```typescript
program
  .command('remote')
  .description('Start a remote access bridge (Telegram)')
  .option('--telegram', 'Run Telegram bot bridge')
  .action(async (options) => {
    if (options.telegram) {
      const { startTelegramBridge } = await import('./remote/telegram.js');
      await startTelegramBridge();  // long-lived; resolves only on SIGINT
    }
  });
```

**Estimated LOC:**
- `src/remote/telegram.ts`: ~150 lines
- `src/remote/index.ts`: ~30 lines
- `src/remote/auth.ts`: ~20 lines
- Tests: ~100 lines
- **Total: ~300 lines** (within the ~150-250 target for core; tests push it over)

**Tests (no real API calls):**
- Allowlist check: `allowlistCheck('123', '123,456')` → true; `allowlistCheck('999', '123')` → false
- Message format: given a message object, assert the formatted string shape
- Routing parse: `@0 hello world` → `{ slot: 0, text: 'hello world' }`
- Approval callback: given callback_query with `message_id=42`, assert `POST /api/messages/42/approve` is called (mock `fetch`)

---

## 8. Open questions for operator

These must be answered before Phase 2 is dispatched:

**Q1: Bot token storage** — Env var `SYNAPSE_TELEGRAM_TOKEN` is recommended (matches existing `SYNAPSE_*` pattern in the codebase). Alternative: `.synapse/telegram.env` file (gitignored). Dotfile is slightly more convenient for local dev (no export needed on each shell start). **Which do you prefer?**

**Q2: Routing — `@slot` prefix vs sticky target** — v1 design uses `@<slot>` prefix on every message (e.g., `@0 check the queue`). Simpler to implement, no state. Sticky target (operator sets current agent once per chat, subsequent messages go there) is more ergonomic but adds state management. **v1: @-prefix only, sticky target deferred to Phase 3 — OK?**

**Q3: Rejection handling for `needs_approval`** — When an agent sends `needs_approval=true` with a question, the bot surfaces `[Approve] [Reject]` buttons. But `POST /api/messages/:id/approve` only approves — there's no reject endpoint for message-level needs_approval (only for approval_requests table). We have two options: (a) add a `POST /api/messages/:id/reject` endpoint, or (b) v1 bot only shows `[Approve]` (operator can ignore to effectively reject). **Add reject endpoint, or defer?**

**Q4: Should bot relay ALL `to_id=human` messages, or only milestone-type?** — The bus has typed messages (done, decision, finding, blocked, commit, message). Relaying ALL may be noisy. Alternative: relay only `finding`, `blocked`, `done` types, plus all `needs_approval=true`. **All types, or filtered?**

**Q5: What happens when Synapse is unreachable on bot startup?** — Two options: (a) bot exits with error ("start Synapse first"), or (b) bot waits and retries on a loop (10s backoff). For tmux-managed use, retry-loop is more resilient if Synapse restarts. **Fail-fast on startup, or wait?**

---

## 9. Phase plan

| Phase | Description | Owner |
|---|---|---|
| 1 | This design document (current task). Operator review + Q1-Q5 answers | Operator |
| 2 | Implementation (`src/remote/`, tests, CLI wiring). Single developer task | Developer worker |
| 3 | Operator runs a test bot; roundtrip smoke test (send message, get reply, approve) | Operator |
| 4 | Hardening: rate-limit (Telegram allows 30 msgs/sec), retry backoff polish, log noise reduction, error reporting via a bot admin message | Developer worker |

Phase 2 is unblocked once Q1-Q5 above are answered. Estimated Phase 2 size: 1 developer task, ~4h wall-clock.

---

## Appendix: Code paths referenced

| Concern | File:line |
|---|---|
| `POST /api/messages` | `src/dashboard.ts:372` |
| `POST /api/messages/:id/approve` | `src/dashboard.ts:391` |
| `POST /api/messages/:id/select-option` | `src/dashboard.ts:402` |
| `GET /api/state` (full state incl. messages) | `src/dashboard.ts:347` |
| `GET /events` (SSE — not used by bot) | `src/dashboard.ts:839` |
| `SYNAPSE_DECK_PORT` env var | `src/mcp-server.ts:~609` |
| `process.env.SYNAPSE_*` pattern | `src/dashboard.ts:39` |
| CLI subcommand pattern (Commander.js) | `src/index.ts:825-846` |
| `sendMessage()` DB helper | `src/db.ts:487` |

---

## Phase 2 implementation notes

**Files shipped:**
- `src/remote/auth.ts` (13 lines) — `parseAllowedChats` + `isAllowedChat`
- `src/remote/telegram.ts` (222 lines) — `TelegramBridge` class + `parseRoutingPrefix`, `shouldRelay` helpers
- `src/remote/index.ts` (43 lines) — `startTelegramBridge` entry point
- `src/index.ts` — `synapse remote --telegram [--port <n>]` subcommand
- `tests/telegram-bot.test.mjs` — 38/38 passing (no real Telegram/Synapse calls)
- `.env.example` — token + allowed chats placeholder
- `README.md` — "Remote access (Telegram)" section

**Deviations from Phase 1 design:**

1. **`polling` constructor option added** — `TelegramBridge` constructor defaults `polling: true` for production; tests pass `polling: false` to prevent real HTTPS calls. Phase 1 didn't anticipate this; minor addendum.

2. **Dependency vulnerabilities** — `node-telegram-bot-api@0.66.0` brings 9 npm audit vulnerabilities (7 moderate, 2 critical) via its transitive `request` dependency (deprecated). The criticals are in `form-data` (boundary randomness) and `tough-cookie` (cookie parsing) inside `request`, which the bot doesn't directly exercise (it sends JSON, not form-data; no cookie jar). Risk is low for a localhost-only outbound-HTTPS process. Recommend upgrading to `node-telegram-bot-api@0.67+` or migrating to `telegraf` in Phase 4 hardening.

3. **`@unknown_thing` parsing** — non-numeric slots like `@unknown_thing` are parsed as NaN, which falls back to slot 0 (per spec "parser doesn't validate; resolution is a separate step"). The resolution step checks `agent_status` and returns "no agent at slot 0" if slot 0 isn't running.

4. **`/api/messages` shape** — confirmed at investigation: accepts `{to_id, content, priority}`. No auth. No slot→agent_id resolution server-side; the bot resolves it client-side via `GET /api/state` statuses array (matches Phase 1 design).

5. **Approve endpoint** — `POST /api/messages/:id/approve` takes no body. `POST /api/messages/:id/select-option` takes `{option_index}`. These are separate endpoints (confirmed at investigation). The design correctly separated `approve:<id>` and `option:<id>:<i>` callback_data patterns.
