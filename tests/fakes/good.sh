#!/bin/sh
# spec §4.5, plan Phase 2: replies then exits 0. Baseline "worker did its job" case.
set -e
"$SYNAPSE_BIN" reply "$SUBTASK_ID" "good.sh: did the work"
