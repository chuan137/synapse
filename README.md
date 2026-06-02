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

## Register the MCP server

Do this once globally — it works for all projects.

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "synapse-bus": {
      "command": "node",
      "args": ["/path/to/synapse/dist/mcp-server.js"]
    }
  }
}
```

**Zed** (`~/.config/zed/settings.json`):
```json
{
  "context_servers": {
    "synapse-bus": {
      "command": {
        "path": "node",
        "args": ["/path/to/synapse/dist/mcp-server.js"]
      }
    }
  }
}
```

## Per-project setup

Run once in each project you want to observe:

```bash
cd my-project
synapse init
```

This creates `.synapse/synapse.db` and copies `SYNAPSE.md` into the project root.

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

## Development

```bash
npm start          # run without building (tsx)
npm run build      # compile to dist/
```
