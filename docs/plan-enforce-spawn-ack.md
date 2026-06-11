# Plan: Enforce worker spawn ACK in code

Status: planned
Scope: ignore the existing `developer-handshake-b` worktree — implement from scratch.

## Problem

`spawn_agent` (src/mcp-server.ts, ~lines 464–509) sends the handshake message
`{type:"handshake", orchestrator_id, worker_id}` and returns immediately. Nothing
confirms the worker received it; readiness is only enforced by protocol prose.

## Design

Server-side auto-ready on handshake delivery (no LLM cooperation required).

Each agent session runs its own `mcp-server.ts` instance against the shared SQLite
DB. The **worker's own server instance** writes the readiness field: when the worker
LLM calls `read_messages` and the server delivers the handshake among the pending
messages, the server sets `ready_at` on its own agent row as a side effect of
delivery. The orchestrator's server instance only reads the field (in the
`delegate_task` gate and `list_workers`). The write happens even if the worker LLM
ignores the handshake content; the only remaining trust assumption is that the
worker calls `read_messages` at all, which the boot nudge already drives.

Rejected alternative: requiring the worker to *send* an explicit ACK message. It
proves the worker can send, not just read, but the model can forget it — prose
enforcement is exactly what this change removes.

## Steps

1. **Track readiness in the DB.** Add a `ready_at` timestamp (or equivalent state)
   on the agent row. Written by the worker's server in the `read_messages` handler
   when the handshake is first delivered. Migration if needed.
2. **Gate `delegate_task`.** If the target worker has no `ready_at`, return an error
   (not silent success) telling the orchestrator the worker has not acknowledged yet
   and to retry after checking `list_workers`.
3. **Surface it.** `list_workers` output includes ready/not-ready (with age).
   `spawn_agent`'s result text states the worker is not ready until it has read the
   handshake.
4. **Update templates** (`templates/SYNAPSE-worker.md` workflow step 1,
   `templates/SYNAPSE-orchestrator.md` "Drive the spawn to completion") to describe
   the enforced behavior instead of the prose-only ACK message; the explicit
   worker-sent ACK can be dropped if superseded. Do not copy to `.synapse/`.

## Acceptance

- Fresh spawn → not ready.
- Worker reads handshake → ready.
- `delegate_task` pre-ready → error; post-ready → succeeds.
- Tests cover all three. Existing handshake message format unchanged.
