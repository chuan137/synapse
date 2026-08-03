#!/bin/sh
# spec §4.6, plan Phase 2: calls synapse reply twice — the second call must be
# rejected (row already terminal) and must not overwrite the first reply.
set -e
"$SYNAPSE_BIN" reply "$SUBTASK_ID" "liar.sh: first reply"
"$SYNAPSE_BIN" reply "$SUBTASK_ID" "liar.sh: second reply" || true
