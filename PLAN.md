# Synapse Plan

A living list of pending work for this project. Source-of-truth file rendered in the S-Deck dashboard's Plan tab. Edit freely; the dashboard auto-refreshes on save.

## Open

- **Role visibility + customization** — surface the `templates/roles/*.md` library in S-Deck; let operator view, edit, create, delete roles from the UI. (Files-vs-DB still TBD.)
- **Recap-on-stop** — when an agent's session ends, send a short post-mortem to its orchestrator (and optionally human). Open Qs: recipient (orchestrator-only or +human), trigger (SessionEnd-only or also dashboard-restart), skip-empty (silent or "did nothing in 12 sec").
- **Kill button** — postponed earlier; would sit next to restart in the agent-card kebab menu.
- **Restart bootstrap orchestrator id** — known limitation: hardcoded `cec50b17:0` in restart task message. Should look up the live slot-0 agent_id at restart time. Trivial.

## In flight

- **Plan tab** — middle column, next to Messages. Renders this file as markdown. (Routed.)

## Done today

- `b879fb0` ticker text lowercase
- `aedb425` listLiveWorkers stale-window proxy removed
- `14be60b` SYNAPSE.md clarification on local Task tools
- `8458cd6` purge rework: tmux-pane ghost reaping, retired-only purge
- `4cfce7f` dashboard: drop stale badge, "purge stale" → "tidy"
- `83e7152` restart button on cards (initial)
- `6c87972` slot-preserving restart + kebab menu first pass
- `ff6d5e3` name=role enforcement, no worker self-rename
- `1be6adb` focus+ping on surface, kebab for cfg+restart, capitalize roles
- `b67cc89` blocked is system-set, not self-reported
- `051e737` Notification → blocked auto-detection
- `76ad54d` rename Activity panel → Events
- `2e482fa` worktree workflow protocol
- `67e40cf` `synapse worktree` CLI subcommands
- `2544de0` activity panel: per-agent task ledger with message + commit linking
