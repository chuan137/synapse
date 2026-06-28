#!/usr/bin/env bash
# Probe: does interactive `claude "<prompt>"` auto-execute a positional prompt
# argument on launch (vs. just pre-filling the input box), under the same
# tmux + script(1) wrapper that synapse's launchAgentWindow uses?
#
# Decides bootstrap-spec #7 (first-kick via `claude` initial prompt).
# PASS  => keep the chosen approach.
# FAIL  => fall back to send-keys delivery, or add a single Enter nudge.
#
# Run on the machine where `claude` is installed (NOT a sandbox).
set -u

SESS="synapse-probe-$$"
# Canonicalize: macOS mktemp returns /var/... but /var symlinks to /private/var,
# and Claude Code records trust under the symlink-resolved (physical) path.
# `pwd -P` gives the canonical form the trust key must match.
PROBE_DIR="$(cd "$(mktemp -d)" && pwd -P)"
CLAUDE="$(command -v claude || echo claude)"

# Workspace trust is stored in ~/.claude.json under
#   .projects["<abs cwd>"].hasTrustDialogAccepted
# (git-init does NOT clear the prompt on all versions). Pre-seed the flag for
# the probe dir — the same fix synapse's launchAgentWindow should apply per
# agent dir before launching claude.
CFG="$HOME/.claude.json"
if command -v jq >/dev/null 2>&1; then
  [ -f "$CFG" ] || echo '{}' > "$CFG"
  cp "$CFG" "$CFG.synapse-probe.bak"
  tmp="$(mktemp)"
  jq --arg d "$PROBE_DIR" \
     '.hasCompletedOnboarding = true | .projects[$d].hasTrustDialogAccepted = true' \
     "$CFG" > "$tmp" && mv "$tmp" "$CFG"
  echo "pre-seeded trust for $PROBE_DIR (backup: $CFG.synapse-probe.bak)"
else
  echo "WARN: jq not found — cannot pre-seed trust; you may still hit the prompt"
fi

# Skip *tool* permission prompts so the Bash side-effect runs unattended.
# (Separate gate from workspace trust above.) Refused under root/sudo.
SKIP="--dangerously-skip-permissions"

# Prompts whose ONLY observable effect is writing a probe file via a tool call.
# If the file appears with no human keystrokes, the positional prompt auto-ran.
P_BARE="Use the Bash tool right now to run exactly: echo ok > '$PROBE_DIR/bare.txt' — then stop."
P_SCRIPT="Use the Bash tool right now to run exactly: echo ok > '$PROBE_DIR/script.txt' — then stop."

id1="$(uuidgen)"; id2="$(uuidgen)"

echo "claude   : $CLAUDE"
echo "probedir : $PROBE_DIR"
echo "session  : $SESS"

tmux new-session -d -s "$SESS"

# Window 1 — bare interactive claude with a positional prompt.
tmux new-window -t "$SESS" -n bare \
  "/bin/bash -c \"cd '$PROBE_DIR' && '$CLAUDE' --session-id $id1 $SKIP '$P_BARE'; exec bash\""

# Window 2 — same, but wrapped in script(1) exactly like launchAgentWindow.
tmux new-window -t "$SESS" -n scripted \
  "/bin/bash -c \"cd '$PROBE_DIR' && script -q /dev/null '$CLAUDE' --session-id $id2 $SKIP '$P_SCRIPT'; exec bash\""

echo
echo "waiting up to 45s for side-effect files (no keystrokes will be sent)..."
for _ in $(seq 1 45); do
  [ -f "$PROBE_DIR/bare.txt" ] && [ -f "$PROBE_DIR/script.txt" ] && break
  sleep 1
done

echo
echo "---- result ----"
if [ -f "$PROBE_DIR/bare.txt" ]; then
  echo "BARE   : PASS  — positional prompt auto-executed"
else
  echo "BARE   : FAIL  — prompt did NOT auto-run (likely pre-filled only, or blocked)"
fi
if [ -f "$PROBE_DIR/script.txt" ]; then
  echo "SCRIPT : PASS  — auto-executed under script(1)+tmux (synapse's real path)"
else
  echo "SCRIPT : FAIL  — did NOT auto-run under the script wrapper"
fi
echo
echo "If FAIL, attach and look at what's on screen (permission prompt? input just"
echo "sitting un-submitted?):  tmux attach -t $SESS    (Ctrl-b d to detach)"
echo "Clean up:  tmux kill-session -t $SESS; rm -rf '$PROBE_DIR'"
