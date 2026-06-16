# Settings Schema

The `.synapse/settings.json` file configures Synapse's runtime behaviour. The orchestrator reads all keys at startup. Health-monitor keys are re-read every 15 seconds, so thresholds can be tuned live without restarting the dashboard.

## Overview

| Key | Type | Default | Component | Description |
|---|---|---|---|---|
| `projectId` | string | — | orchestrator | Project identifier (set at `synapse init`) |
| `name` | string | — | orchestrator | Human-readable project name |
| `theme` | string | `"dark"` | dashboard | UI theme (`"dark"` or `"bright"`) |
| `autoRestartTasks` | number | — | dashboard | Auto-restart workers after N completed tasks (0 = disabled) |
| `toolCallRestartHint` | number | **200** | health-monitor | Worker tool-call count that triggers a warning badge and eligibility for auto-compact. Re-read every 15 s. |
| `orchToolCallHint` | number | **250** | health-monitor | Orchestrator tool-call count that triggers a `[health]` alert message to the operator. Re-read every 15 s. |
| `compactHint` | number | `floor(toolCallRestartHint / 2)`, default 100 | health-monitor | Worker tool-call count that triggers automatic `/compact` via tmux. Re-read every 15 s. |
| `idleBlockedThresholdMs` | number | **60000** | health-monitor | Milliseconds the orchestrator must remain idle while workers are blocked before a `[health]` alert fires. Re-read every 15 s. |

## Health-monitor behaviour

The health-monitor runs a background poll every 15 seconds, checking worker and orchestrator tool-call totals against thresholds:

- **At `toolCallRestartHint`:** Worker shows a warning badge on S-Deck and becomes eligible for `/compact`.
- **At `compactHint`:** Worker receives an automatic `/compact` command via tmux (context is cleared, tool-call counter resets to 0).
- **At `orchToolCallHint`:** Orchestrator sends a `[health]` message to the human operator and notes the high tool-call count.
- **Idle + blocked for `idleBlockedThresholdMs`:** If the orchestrator is idle while all workers are blocked, a `[health]` alert fires.

**Note:** `compactHint` defaults to half of `toolCallRestartHint` and re-derives on every poll. If you set `toolCallRestartHint: 400` without an explicit `compactHint`, compact automatically fires at 200. Set `compactHint` explicitly only when you want a non-half ratio.

## Example settings file

```jsonc
{
  "projectId": "cec50b17",
  "name": "Synapse",
  "theme": "bright",
  "autoRestartTasks": 5,

  // Health-monitor thresholds (re-read every 15 s — no restart needed)
  "toolCallRestartHint": 200,      // warn + compact eligibility
  "compactHint": 100,               // auto-compact at this count
  "orchToolCallHint": 250,          // orch health alert
  "idleBlockedThresholdMs": 60000   // 60 seconds idle + blocked before alert
}
```

## Tuning guide

- **High context runs:** If your workflows use many tool calls and compact frequently, increase `toolCallRestartHint` (compact automatically scales to half). Set `compactHint` explicitly only if you want a different ratio. E.g., `toolCallRestartHint: 400` warns at 400 and auto-compacts at 200.
- **Long workflows:** Increase `idleBlockedThresholdMs` if workers often spend long periods blocked without it being a problem. Default (60 s) catches most deadlocks.
- **Bursty orchestrator work:** If the orchestrator spikes above 250 tool calls during normal delegation, raise `orchToolCallHint` to reduce false alarms. Monitor `.synapse/synapse.db` logs to find a good threshold.

## Reloading

All keys are read from disk:
- On startup (when the orchestrator launches)
- Every 15 seconds (health-monitor poll tick)

Edit `.synapse/settings.json` and the new values take effect at the next poll. No restart needed.
