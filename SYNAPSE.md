# Synapse Agent Protocol

This project uses **Synapse**, a human-in-the-loop observation layer for AI agents. If you are an AI agent working in this directory, this file defines how you must behave.

---

## What Synapse Is

Synapse is **not** a controller and **not** an autonomous coordination framework. It is an observation layer that lets a human operator watch what you are doing in real time and inject instructions when needed.

Everything you report — your status, your messages — is displayed on a dashboard (S-Deck) that the operator is watching. Your job is to keep that view accurate and to listen for the operator's instructions.

---

## MCP Tools Available

You have access to these tools via the `synapse-bus` MCP server:

| Tool | Purpose |
|---|---|
| `read_messages` | Check for instructions from the human operator |
| `send_message` | Report a decision or ask the operator a question |
| `update_status` | Tell the operator what state you are in and what you are doing |

---

## The Only Two Rules

Synapse asks almost nothing of you. There are exactly two mandatory behaviours.

### Rule 1 — Read before you act

At the **start of every turn**, before doing anything else:

1. Call `read_messages`
2. If there is a message from the operator, it takes priority over your current plan — handle it first
3. Then continue with your work

### Rule 2 — Report when you change state

Whenever your state changes (and at the **end of every turn**):

1. Call `update_status` with your current state: `idle`, `working`, `blocked`, or `error`
2. Set `current_task` to a short, human-readable description of what you are doing

That's it. If you do these two things reliably, the operator can see you and direct you. If you skip them, you become invisible — and an invisible agent will be interrupted or stopped.

---

## Priority

Messages carry a priority number. Lower = more urgent.

- **Priority 0 (P0)** = the operator needs you to act now. Stop what you are doing, handle it, confirm with `send_message`.
- **Priority 5** = normal. Handle at your next natural checkpoint.

Never defer a P0.

---

## When to Speak to the Operator

Use `send_message` (to_id = `human`) when:

- You are about to take an action you are not confident about
- You are blocked and cannot proceed without a decision
- You have finished a significant piece of work and want it acknowledged

Keep messages short. The operator is watching several things at once.

---

## What You Must Never Do

- **Never skip Rule 1** — even when you are sure no message is waiting
- **Never skip Rule 2** — an unreported state makes you invisible
- **Never ignore a P0**
- **Never modify the `.synapse/` directory** — it belongs to the observation layer

---

*You are being watched — not to be controlled, but so a human can help when you need it. Keep your status honest and your instructions read. Everything else is up to your judgment.*
