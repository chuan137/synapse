#!/usr/bin/env bash
# PostToolUse hook — nudges Claude if there are unread Synapse messages.
# Exits 0 always; non-empty stdout is injected into Claude's context.

SYNAPSE_DIR="$(pwd)/.synapse"
ENV_FILE="$SYNAPSE_DIR/agent.env"
DB="$SYNAPSE_DIR/synapse.db"

[ -f "$ENV_FILE" ] || exit 0
[ -f "$DB" ]       || exit 0

source "$ENV_FILE"
[ -n "$SYNAPSE_AGENT_ID" ] || exit 0

COUNT=$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM messages WHERE to_id='$SYNAPSE_AGENT_ID' AND read_at IS NULL;" \
  2>/dev/null)

if [ "${COUNT:-0}" -gt 0 ]; then
  echo "[Synapse] You have $COUNT unread message(s). Call read_messages now."
fi
