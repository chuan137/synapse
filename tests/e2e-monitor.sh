#!/usr/bin/env bash
# Automated version of docs/phase2-manual-test.md
set -euo pipefail

SYNAPSE=./bin/synapse
PASS=0; FAIL=0

# ── helpers ──────────────────────────────────────────────────────────────────

setup() {
  DIR=$(mktemp -d)
  export SYNAPSE_DB="$DIR/synapse.db"
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

run() { "$SYNAPSE" "$@" 2>&1 || true; }

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
  run register planner planner sess-planner > /dev/null
  run register coder-1 coder   sess-coder  > /dev/null
  local out; out=$(run status)
  assert "planner registered as unknown" "$out" "planner"
  assert "coder-1 registered as unknown" "$out" "coder-1"
  assert "both status unknown"           "$out" "unknown"
}

section2() {
  echo "[2] Send TASK"
  run send coder-1 TASK "implement feature X" --from planner > /dev/null
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
  echo "[4] end_turn past debounce -> idle + delivery"
  write_transcript sess-coder end_turn 5
  run monitor --once --debounce 100
  assert "coder-1 idle"       "$(run status)"  "idle"
  assert "message delivered"  "$(run pending)" "no pending"
  assert "tmux body sent"     "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1 -l -- implement feature X"
  assert "tmux Enter sent"    "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1 Enter"
}

section5() {
  echo "[5] debounce guard - end_turn within window, no delivery"
  run send coder-1 INFO "another message" --from planner > /dev/null
  write_transcript sess-coder end_turn 0
  rm -f "$TMUX_LOG"
  run monitor --once --debounce 60000
  assert "tmux not called"    "$(cat "$TMUX_LOG" 2>/dev/null || true)" ""
  assert "message still pending" \
    "$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='another message'")" "pending"
}

section6() {
  echo "[6] Full TASK -> STATUS round trip"
  local task_id; task_id=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE type='TASK' LIMIT 1")
  run send planner STATUS "feature X done" --from coder-1 --ref-id "$task_id" > /dev/null
  write_transcript sess-planner end_turn 5
  rm -f "$TMUX_LOG"
  # coder-1 must be idle to not block; backdate its transcript too
  write_transcript sess-coder end_turn 5
  run monitor --once --debounce 100
  assert "STATUS delivered to planner" "$(cat "$TMUX_LOG")" "send-keys -t team:planner -l -- feature X done"
  local ref_id; ref_id=$(sqlite3 "$SYNAPSE_DB" "SELECT ref_id FROM messages WHERE type='STATUS'")
  assert "STATUS ref_id = TASK id"    "$ref_id" "$task_id"
}

section7() {
  echo "[7] tmux failure -> failed, no retry"
  fake_tmux_fail
  run send coder-1 INFO "test failure" --from planner > /dev/null
  write_transcript sess-coder end_turn 5
  run monitor --once --debounce 100
  local st; st=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='test failure'")
  assert "message marked failed" "$st" "failed"

  # second run — must not retry
  run monitor --once --debounce 100
  st=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE body='test failure'")
  assert "no retry after failure" "$st" "failed"
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
