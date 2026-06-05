# Synapse Plan

Living list of pending work. Source of truth for the Plan tab in S-Deck. Edit freely; the dashboard auto-refreshes on save.

## Open

- **Recap-on-stop** — when an agent's session ends, send a short post-mortem to its orchestrator (and optionally human). Open Qs: recipient (orchestrator-only or +human), trigger (SessionEnd-only or also dashboard-restart), skip-empty (silent or "did nothing in 12 sec").
- **Kill button** — postponed earlier; would sit next to restart in the agent-card kebab menu.
- **Restart bootstrap orchestrator id** — known limitation: hardcoded `cec50b17:0` in the restart task message. Should look up the live slot-0 agent_id at restart time.
- **Workers not posting DONE to human** — protocol fix shipped in `60d7a9c` re-emphasizes the human milestone. Existing running workers won't pick it up until restarted; only future-spawned workers see the new doc at boot.
- **Custom orchestrator name preserved across restart** — slot-0 boot path now unconditionally writes `name='orchestrator'`. If operator wants a custom name to survive, add a "skip if a non-default name is already set" guard.

## Done

### Activity panel + ledger

- `2544de0` activity panel: per-agent task ledger with message + commit linking
- `fe9d372` activities: orchestrator-recorded, with optional `agent_id`
- `fda5d59` worktree merge: auto-attach commit_sha to worker's activity by slot
- `b459c77` activities lifecycle: commit closes; `finishActivity` merges fields
- `ea82a06` orchestrator card hides `:0` suffix and shows global activities
- `e7f603e` drop `:N` suffix from tab headers; add slot tag in :0 global view
- `63d0544` wrap activity lifecycle in `delegate_task` and `report_done` MCP tools

### Roles + project name

- `a1b5e28` roles: dashboard CRUD for `templates/roles/*.md`
- `ff6d5e3` name=role enforcement, no worker self-rename
- `6fced86` worker name regression: stop `update_status` from clobbering DB name

### Plan tab

- `1c0acaa` Plan tab: render PLAN.md alongside Messages
- `c955840` fix dashboard "Connecting…" freeze (duplicate `messagesList` const)

### Worker lifecycle

- `b67cc89` blocked is system-set, not self-reported
- `051e737` `Notification` → blocked auto-detection
- `aedb425` `listLiveWorkers` stale-window proxy removed
- `8458cd6` purge rework: tmux-pane ghost reaping, retired-only purge
- `83e7152` restart button on cards (initial)
- `6c87972` slot-preserving restart + kebab menu first pass
- `60d7a9c` worker doc: re-emphasize human milestones; soften "Never" clause

### Worktree workflow

- `2e482fa` worktree workflow protocol
- `67e40cf` `synapse worktree` CLI subcommands

### Tmux + cards

- `39b3d2f` tmux: rename worker window to `<role>--<slot>` after registration
- `d2a0d8a` tmux rename: lock the name + capitalize role
- `1be6adb` focus+ping on surface, kebab for cfg+restart, capitalize roles
- `4cfce7f` dashboard: drop stale badge, "purge stale" → "tidy"

### Theme polish

- `876c89a` light-theme polish: message hover, contrast, P0 emphasis
- `b2ce903` P0 styling: tone down text color and hover background
- `043d33a` restraint pass on hover effects: message rows are inert content
- `39b6df8` restore subtle hover on message rows (~2% tint)

### Earlier

- `b879fb0` ticker text lowercase
- `14be60b` SYNAPSE.md clarification on local Task tools
- `76ad54d` rename Activity panel → Events
