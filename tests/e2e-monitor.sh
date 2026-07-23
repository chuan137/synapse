#!/usr/bin/env bash
# Automated version of docs/phase2-manual-test.md
set -euo pipefail

SYNAPSE=./bin/synapse
PASS=0; FAIL=0

# ── helpers ──────────────────────────────────────────────────────────────────

setup() {
  DIR=$(mktemp -d)
  export SYNAPSE_DB="$DIR/synapse.db"
  export SYNAPSE_RUN_ID=1
  export CLAUDE_PROJECTS_DIR="$DIR/projects"
  TMUX_LOG="$DIR/tmux.log"
  FAKEBIN="$DIR/fakebin"
  PROJECTS_DIR="$DIR/projects/my-project"

  mkdir -p "$FAKEBIN" "$PROJECTS_DIR"
  printf '#!/bin/sh\necho "$@" >> "%s"\nexit 0\n' "$TMUX_LOG" > "$FAKEBIN/tmux"
  chmod +x "$FAKEBIN/tmux"
  export PATH="$FAKEBIN:$PATH"
}

teardown() { rm -rf "$DIR"; }

run() { env -u SYNAPSE_AGENT "$SYNAPSE" "$@" 2>&1 || true; }

write_transcript() {
  local session=$1 stop_reason=$2 age_secs=${3:-0}
  local path="$PROJECTS_DIR/${session}.jsonl"
  printf '{"type":"assistant","message":{"role":"assistant","content":[],"stop_reason":"%s"}}\n' \
    "$stop_reason" > "$path"
  if [[ "$age_secs" -gt 0 ]]; then
    python3 -c "import os,time; os.utime('$path',(time.time()-$age_secs,)*2)"
  fi
}

fake_tmux_fail() {
  printf '#!/bin/sh\necho "no such window" >&2\nexit 1\n' > "$FAKEBIN/tmux"
  chmod +x "$FAKEBIN/tmux"
}

assert() {
  local desc=$1 actual=$2 expected=$3
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  PASS  $desc"
    (( PASS++ )) || true
  else
    echo "  FAIL  $desc"
    echo "        expected: $expected"
    echo "        got:      $actual"
    (( FAIL++ )) || true
  fi
}

# ── sections ─────────────────────────────────────────────────────────────────

section1() {
  echo "[1] Init & Register"
  run init > /dev/null
  sqlite3 "$SYNAPSE_DB" "INSERT INTO runs (id, session, goal, status) VALUES (1, 'team', 'e2e test', 'running')"
  run register manager manager sess-manager > /dev/null
  run register coder-1 coder   sess-coder  > /dev/null
  local out; out=$(run status)
  assert "manager registered as unknown" "$out" "manager"
  assert "coder-1 registered as unknown" "$out" "coder-1"
  assert "both status unknown"           "$out" "unknown"
}

section2() {
  echo "[2] Send TASK"
  run send coder-1 TASK "implement feature X" --from manager > /dev/null
  local out; out=$(run pending)
  assert "message pending"    "$out" "implement feature X"
  assert "to coder-1"         "$out" "coder-1"
  assert "type TASK"          "$out" "TASK"
}

section3() {
  echo "[3] tool_use -> busy, no delivery"
  write_transcript sess-coder tool_use
  run monitor --once --debounce 0
  assert "coder-1 busy"       "$(run status)"  "busy"
  assert "tmux not called"    "$(cat "$TMUX_LOG" 2>/dev/null || true)" ""
  assert "message still pending" "$(run pending)" "implement feature X"
}

section4() {
  echo "[4] end_turn past debounce -> idle + pending nudge"
  write_transcript sess-coder end_turn 5
  run monitor --once --debounce 100
  assert "coder-1 idle"       "$(run status)"  "idle"
  assert "message still pending before agent pull" "$(run pending)" "implement feature X"
  assert "tmux pending nudge sent" "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1 -l -- synapse pending coder-1"
  assert "tmux Enter sent"    "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1 Enter"
  SYNAPSE_AGENT=coder-1 "$SYNAPSE" pending coder-1 > /dev/null
  assert "agent pull marks read" \
    "$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='implement feature X'")" "read"
}

section5() {
  echo "[5] debounce guard - end_turn within window, no delivery"
  run send coder-1 PROGRESS "another message" --from manager > /dev/null
  write_transcript sess-coder end_turn 0
  rm -f "$TMUX_LOG"
  run monitor --once --debounce 60000
  assert "tmux not called"    "$(cat "$TMUX_LOG" 2>/dev/null || true)" ""
  assert "message still pending" \
    "$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='another message'")" "pending"
}

section6() {
  echo "[6] Full TASK -> REPLY round trip"
  local task_id; task_id=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE type='TASK' LIMIT 1")
  run send manager REPLY "feature X done" --from coder-1 --ref-id "$task_id" > /dev/null
  write_transcript sess-manager end_turn 5
  rm -f "$TMUX_LOG"
  # coder-1 must be idle to not block; backdate its transcript too
  write_transcript sess-coder end_turn 5
  run monitor --once --debounce 100
  assert "REPLY nudged to manager" "$(cat "$TMUX_LOG")" "send-keys -t team:manager -l -- synapse pending manager"
  local ref_id; ref_id=$(sqlite3 "$SYNAPSE_DB" "SELECT ref_id FROM messages WHERE type='REPLY'")
  assert "REPLY ref_id = TASK id"    "$ref_id" "$task_id"
}

section7() {
  echo "[7] tmux failure leaves message pending for retry"
  fake_tmux_fail
  run send coder-1 PROGRESS "test failure" --from manager > /dev/null
  write_transcript sess-coder end_turn 5
  run monitor --once --debounce 100
  local st; st=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='test failure'")
  assert "message remains pending" "$st" "pending"

  printf '#!/bin/sh\necho "$@" >> "%s"\nexit 0\n' "$TMUX_LOG" > "$FAKEBIN/tmux"
  chmod +x "$FAKEBIN/tmux"
  rm -f "$TMUX_LOG"
  run monitor --once --debounce 100
  st=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='test failure'")
  assert "retry still leaves pending until agent pull" "$st" "pending"
  assert "retry sends pending nudge" "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1 -l -- synapse pending coder-1"
}

# ── main ─────────────────────────────────────────────────────────────────────

setup
trap teardown EXIT

section1
section2
section3
section4
section5
section6
section7

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
