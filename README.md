# Synapse

A human-in-the-loop observation layer for AI agents. Synapse lets you watch what agents are doing in real time and send them instructions — without interrupting their work.

## How it works

- Agents connect via **MCP** (`synapse-bus`) and report their state, send messages, and check for instructions
- You watch them on **S-Deck**, a local dashboard that shows live agent status and message history
- The state is stored in a local SQLite file (`.synapse/synapse.db`) inside each project

## Install

```bash
git clone <repo>
cd synapse
npm install
npm run build
npm link          # registers the global `synapse` command
```

## Per-project setup

Run once in each project you want to observe:

```bash
cd my-project
synapse init
```

This creates `.synapse/synapse.db`, copies the agent protocol files into `.synapse/`, and adds `.mcp.json` to the project root so the `synapse-bus` MCP server is automatically available to Claude Code (no manual MCP registration needed).

## Start the dashboard

```bash
cd my-project
synapse dash
```

S-Deck opens at a random free port (printed on startup). Pass `-p` to pin it:

```bash
synapse dash -p 4000
```

## Agent protocol

`SYNAPSE.md` (copied into your project on first run) tells agents how to behave:

1. **Read before acting** — call `read_messages` at the start of every turn
2. **Report state changes** — call `update_status` whenever state changes and at the end of every turn

## MCP tools

| Tool | Purpose |
|---|---|
| `read_messages` | Check for instructions from the operator |
| `send_message` | Send a message to the operator or another agent |
| `update_status` | Report current state (`idle`, `working`, `blocked`, `error`) |

## Remote access (Telegram)

Control Synapse from your Telegram client. Agents reply via the bot.

**Setup:**
1. Create a bot via [@BotFather](https://t.me/BotFather) and get your token.
2. Get your Telegram chat ID via [@userinfobot](https://t.me/userinfobot).
3. Set env vars:
   ```bash
   export SYNAPSE_TELEGRAM_TOKEN=<your-bot-token>
   export SYNAPSE_TELEGRAM_ALLOWED_CHATS=<your-chat-id>
   ```
4. Start the Synapse dashboard, then run the bot bridge in a second terminal:
   ```bash
   synapse remote --telegram
   ```

**Sending messages:** type `@<slot> <text>` to route to an agent by slot number. Bare messages (no `@` prefix) go to the orchestrator (slot 0). Example: `@0 what's the status?`

**Receiving messages:** the bot relays `finding`, `blocked`, and `done` messages, plus any approval requests (with inline keyboard buttons).

See `docs/telegram-bot-plan.md` for architecture details.

## Development

```bash
npm start          # run without building (tsx)
npm run build      # compile to dist/
```
