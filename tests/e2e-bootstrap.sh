#!/usr/bin/env bash
# Automated version of docs/test-plan-bootstrap.md
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
  DATADIR="$DIR"

  mkdir -p "$FAKEBIN" "$PROJECTS_DIR"
  printf '#!/bin/sh\necho "$@" >> "%s"\n[ "$1" = "has-session" ] && exit 1\nexit 0\n' "$TMUX_LOG" > "$FAKEBIN/tmux"
  chmod +x "$FAKEBIN/tmux"
  export PATH="$FAKEBIN:$PATH"

  TASK_NAME="my-feature-task"
  TASK_DIR="$DIR/tasks/$TASK_NAME"
  mkdir -p "$TASK_DIR"

  cat > "$TASK_DIR/task.yml" << 'EOF'
synapse_version: 0.1.0
workflow: hub-and-spoke
goal: "Build feature X end to end"
agents:
  - role: planner
  - role: coder
  - role: coder
  - role: reviewer
EOF
}

teardown() { rm -rf "$DIR"; }

run()  { "$SYNAPSE" "$@" 2>&1 || true; }
rune() { "$SYNAPSE" "$@" 2>&1; echo "exit:$?"; }

seed_session_ids() {
  echo "sess-planner"  > "$DATADIR/planner.session-id"
  echo "sess-coder1"   > "$DATADIR/coder-1.session-id"
  echo "sess-coder2"   > "$DATADIR/coder-2.session-id"
  echo "sess-reviewer" > "$DATADIR/reviewer.session-id"
}

reset_task_runtime() {
  rm -f "$SYNAPSE_DB" "$SYNAPSE_DB-shm" "$SYNAPSE_DB-wal" "$TMUX_LOG"
  rm -rf "$DIR/agents/$TASK_NAME"
}

write_transcript() {
  local session=$1 stop_reason=$2 age_secs=${3:-0}
  local path="$PROJECTS_DIR/${session}.jsonl"
  printf '{"type":"assistant","message":{"role":"assistant","content":[],"stop_reason":"%s"}}\n' \
    "$stop_reason" > "$path"
  if [[ "$age_secs" -gt 0 ]]; then
    python3 -c "import os,time; os.utime('$path',(time.time()-$age_secs,)*2)"
  fi
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

assert_exit() {
  local desc=$1 out=$2
  if [[ "$out" == *"exit:1"* ]]; then
    echo "  PASS  $desc"
    (( PASS++ )) || true
  else
    echo "  FAIL  $desc (expected exit 1)"
    echo "        got: $out"
    (( FAIL++ )) || true
  fi
}

# ── sections ─────────────────────────────────────────────────────────────────

section1() {
  echo "[1] YAML Parsing Errors"

  local out
  out=$("$SYNAPSE" start /nonexistent/task.yml --no-monitor 2>&1; echo "exit:$?")
  assert_exit "1a exit 1 on missing file" "$out"
  assert      "1a stderr: task config not found" "$out" "task config not found"

  mkdir -p "$DIR/tasks/no-workflow"
  cat > "$DIR/tasks/no-workflow/task.yml" << 'EOF'
synapse_version: 0.1.0
agents:
  - role: planner
EOF
  out=$("$SYNAPSE" start "$DIR/tasks/no-workflow/task.yml" --no-monitor 2>&1; echo "exit:$?")
  assert_exit "1b exit 1 on missing workflow" "$out"
  assert      "1b stderr: missing 'workflow'" "$out" "missing 'workflow'"

  mkdir -p "$DIR/tasks/empty"
  cat > "$DIR/tasks/empty/task.yml" << 'EOF'
synapse_version: 0.1.0
workflow: hub-and-spoke
agents:
EOF
  out=$("$SYNAPSE" start "$DIR/tasks/empty/task.yml" --no-monitor 2>&1; echo "exit:$?")
  assert_exit "1c exit 1 on no agents" "$out"
  assert      "1c stderr: no agents defined" "$out" "no agents defined"
}

section2() {
  echo "[2] start — DB init and operator registration"
  reset_task_runtime
  seed_session_ids

  local start_out; start_out=$(run start "$TASK_DIR/task.yml" --no-monitor)
  assert "started message"           "$start_out" "team '$TASK_NAME' (run #1) started with 4 agent(s)"

  local out; out=$(run status)
  assert "operator registered"       "$out" "operator"
  assert "operator role"             "$out" "operator"
  assert "operator idle"             "$out" "idle"
  assert "planner registered"        "$out" "planner"
  assert "coder-1 registered"        "$out" "coder-1"
  assert "coder-2 registered"        "$out" "coder-2"
  assert "reviewer registered"       "$out" "reviewer"
}

section3() {
  echo "[3] start — initial goal queued as TASK to planner"
  reset_task_runtime
  seed_session_ids

  run start "$TASK_DIR/task.yml" --no-monitor --goal "Build feature X end to end" > /dev/null

  local out; out=$(run pending planner)
  assert "one pending TASK"    "$out" "TASK"
  assert "from operator"       "$out" "operator"
  assert "to planner"          "$out" "planner"
  assert "goal body"           "$out" "Build feature X end to end"
}

section4() {
  echo "[4] start — monitor window receives monitor command"
  reset_task_runtime
  seed_session_ids

  run start "$TASK_DIR/task.yml" --goal "Build something" > /dev/null

  assert "tmux send-keys to monitor" "$(cat "$TMUX_LOG")" "send-keys -t $TASK_NAME:monitor"
  assert "monitor command"           "$(cat "$TMUX_LOG")" "synapse monitor"
}

section5() {
  echo "[5] stop — marks agent stopped and kills window"

  # 5a: stop coder-2
  rm -f "$TMUX_LOG"
  run stop coder-2 --session "$TASK_NAME" > /dev/null
  local db_status; db_status=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM agents WHERE window_name='coder-2'")
  assert "5a DB status stopped"       "$db_status"          "stopped"
  assert "5a tmux kill-window"        "$(cat "$TMUX_LOG")"  "kill-window -t $TASK_NAME:coder-2"

  # 5b: stop unknown agent
  local out; out=$("$SYNAPSE" stop ghost --session "$TASK_NAME" 2>&1; echo "exit:$?")
  assert_exit "5b exit 1 on unknown agent"    "$out"
  assert      "5b stderr: no registered agent" "$out" "no registered agent"

  # 5c: stopped agent ignored by monitor
  write_transcript sess-coder2 end_turn 5
  run send coder-2 INFO "message to stopped agent" --from planner > /dev/null
  rm -f "$TMUX_LOG"
  run monitor --once --debounce 100 > /dev/null
  local msg_status; msg_status=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE to_agent='coder-2' AND body='message to stopped agent'")
  assert "5c message stays pending"   "$msg_status" "pending"
  assert "5c tmux not called"         "$(cat "$TMUX_LOG" 2>/dev/null || true)" ""
}

section6() {
  echo "[6] Full TASK→STATUS→REVIEW→STATUS ref_id chain"
  rm -f "$SYNAPSE_DB"
  run init > /dev/null
  run register operator  operator  ""            > /dev/null
  run register planner   planner   sess-planner  > /dev/null
  run register coder-1   coder     sess-coder1   > /dev/null
  run register reviewer  reviewer  sess-reviewer > /dev/null

  run send planner  TASK   "Build feature X"      --from operator > /dev/null
  ROOT_ID=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE from_agent='operator' LIMIT 1")

  run send coder-1  TASK   "Implement X"           --from planner  --ref-id "$ROOT_ID" > /dev/null
  SUB_ID=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE to_agent='coder-1' LIMIT 1")

  run send reviewer REVIEW "Please review PR #42"  --from coder-1  --ref-id "$SUB_ID"  > /dev/null
  REV_ID=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE type='REVIEW' LIMIT 1")

  run send coder-1  STATUS "LGTM"                  --from reviewer --ref-id "$REV_ID"  > /dev/null
  run send planner  STATUS "Feature X done"         --from coder-1  --ref-id "$SUB_ID"  > /dev/null

  local rows; rows=$(sqlite3 "$SYNAPSE_DB" "SELECT id||'|'||from_agent||'|'||to_agent||'|'||type||'|'||coalesce(ref_id,'NULL') FROM messages ORDER BY id")
  assert "msg1 operator->planner TASK no ref"   "$rows" "1|operator|planner|TASK|NULL"
  assert "msg2 planner->coder-1 TASK ref=1"     "$rows" "2|planner|coder-1|TASK|1"
  assert "msg3 coder-1->reviewer REVIEW ref=2"  "$rows" "3|coder-1|reviewer|REVIEW|2"
  assert "msg4 reviewer->coder-1 STATUS ref=3"  "$rows" "4|reviewer|coder-1|STATUS|3"
  assert "msg5 coder-1->planner STATUS ref=2"   "$rows" "5|coder-1|planner|STATUS|2"

  # 6b: deliver via monitor
  write_transcript sess-planner  end_turn 5
  write_transcript sess-coder1   end_turn 5
  write_transcript sess-reviewer end_turn 5
  rm -f "$TMUX_LOG"

  run monitor --once --debounce 100 > /dev/null

  local statuses; statuses=$(sqlite3 "$SYNAPSE_DB" "SELECT id||':'||status FROM messages ORDER BY id")
  assert "msg1 delivered" "$statuses" "1:delivered"
  assert "msg2 delivered" "$statuses" "2:delivered"
  assert "msg3 delivered" "$statuses" "3:delivered"
  assert "tmux send-keys planner"  "$(cat "$TMUX_LOG")" "send-keys -t team:planner"
  assert "tmux send-keys coder-1"  "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1"
  assert "tmux send-keys reviewer" "$(cat "$TMUX_LOG")" "send-keys -t team:reviewer"
}

section7() {
  echo "[7] Re-start rejects existing scratch"
  reset_task_runtime
  seed_session_ids
  run start "$TASK_DIR/task.yml" --no-monitor > /dev/null

  local out; out=$(run start "$TASK_DIR/task.yml" --no-monitor)
  assert "7 scratch exists message" "$out" "agent scratch already exists"
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
