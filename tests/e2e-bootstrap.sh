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
  export HOME="$DIR/home"

  mkdir -p "$FAKEBIN" "$PROJECTS_DIR" "$HOME"
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
  - role: manager
  - role: coder
  - role: coder
  - role: reviewer
EOF
}

teardown() { rm -rf "$DIR"; }

run()  { "$SYNAPSE" "$@" 2>&1 || true; }
rune() { "$SYNAPSE" "$@" 2>&1; echo "exit:$?"; }

seed_session_ids() {
  echo "sess-manager"  > "$DATADIR/manager.session-id"
  echo "sess-coder1"   > "$DATADIR/coder-1.session-id"
  echo "sess-coder2"   > "$DATADIR/coder-2.session-id"
  echo "sess-reviewer" > "$DATADIR/reviewer.session-id"
}

reset_task_runtime() {
  rm -f "$SYNAPSE_DB" "$SYNAPSE_DB-shm" "$SYNAPSE_DB-wal" "$TMUX_LOG"
  rm -rf "$DIR/agents" "$DIR/runs"
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
  - role: manager
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
  assert "started message"           "$start_out" "team 'run-1' (run #1) started with 4 agent(s)"
  assert "run task copy"             "$(cat "$DIR/runs/run-1/task.yml")" "run_id: 1"
  assert "run task agents_dir"       "$(cat "$DIR/runs/run-1/task.yml")" "agents_dir: $DIR/agents/run-1"

  local out; out=$(run status)
  assert "operator registered"       "$out" "operator"
  assert "operator role"             "$out" "operator"
  assert "operator idle"             "$out" "idle"
  assert "manager registered"        "$out" "manager"
  assert "coder-1 registered"        "$out" "coder-1"
  assert "coder-2 registered"        "$out" "coder-2"
  assert "reviewer registered"       "$out" "reviewer"
}

section3() {
  echo "[3] start — initial goal queued as TASK to manager"
  reset_task_runtime
  seed_session_ids

  run start "$TASK_DIR/task.yml" --no-monitor --goal "Build feature X end to end" > /dev/null

  local out; out=$(run pending manager)
  assert "one pending TASK"    "$out" "TASK"
  assert "from operator"       "$out" "operator"
  assert "to manager"          "$out" "manager"
  assert "goal body"           "$out" "Build feature X end to end"
}

section4() {
  echo "[4] start — monitor window receives monitor command"
  reset_task_runtime
  seed_session_ids

  run start "$TASK_DIR/task.yml" --goal "Build something" > /dev/null

  assert "tmux send-keys to monitor" "$(cat "$TMUX_LOG")" "send-keys -t run-1:monitor"
  assert "monitor command"           "$(cat "$TMUX_LOG")" "synapse monitor"
}

section5() {
  echo "[5] stop — marks agent stopped and kills window"

  # 5a: stop coder-2
  rm -f "$TMUX_LOG"
  run stop coder-2 --session run-1 > /dev/null
  local db_status; db_status=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM agents WHERE window_name='coder-2'")
  assert "5a DB status stopped"       "$db_status"          "stopped"
  assert "5a tmux kill-window"        "$(cat "$TMUX_LOG")"  "kill-window -t run-1:coder-2"

  # 5b: stop unknown agent
  local out; out=$("$SYNAPSE" stop ghost --session run-1 2>&1; echo "exit:$?")
  assert_exit "5b exit 1 on unknown agent"    "$out"
  assert      "5b stderr: no registered agent" "$out" "no registered agent"

  # 5c: stopped agent ignored by monitor
  write_transcript sess-coder2 end_turn 5
  run send coder-2 PROGRESS "message to stopped agent" --from manager > /dev/null
  rm -f "$TMUX_LOG"
  run monitor --once --debounce 100 > /dev/null
  local msg_status; msg_status=$(sqlite3 "$SYNAPSE_DB" "SELECT status FROM messages WHERE to_agent='coder-2' AND body='message to stopped agent'")
  assert "5c message stays pending"   "$msg_status" "pending"
  assert "5c tmux not called"         "$(cat "$TMUX_LOG" 2>/dev/null || true)" ""
}

section6() {
  echo "[6] Full TASK→REPLY→TASK(review)→REPLY ref_id chain"
  rm -f "$SYNAPSE_DB"
  run init > /dev/null
  run register operator  operator  ""            > /dev/null
  run register manager   manager   sess-manager  > /dev/null
  run register coder-1   coder     sess-coder1   > /dev/null
  run register reviewer  reviewer  sess-reviewer > /dev/null

  run send manager  TASK   "Build feature X"      --from operator > /dev/null
  ROOT_ID=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE from_agent='operator' LIMIT 1")

  run send coder-1  TASK   "Implement X"           --from manager  --ref-id "$ROOT_ID" > /dev/null
  SUB_ID=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE to_agent='coder-1' LIMIT 1")

  run send reviewer TASK   "Please review PR #42"  --from coder-1  --ref-id "$SUB_ID"  > /dev/null
  REV_ID=$(sqlite3 "$SYNAPSE_DB" "SELECT id FROM messages WHERE type='TASK' AND to_agent='reviewer' LIMIT 1")

  run send coder-1  REPLY "LGTM"                  --from reviewer --ref-id "$REV_ID"  > /dev/null
  run send manager  REPLY "Feature X done"         --from coder-1  --ref-id "$SUB_ID"  > /dev/null

  local rows; rows=$(sqlite3 "$SYNAPSE_DB" "SELECT id||'|'||from_agent||'|'||to_agent||'|'||type||'|'||coalesce(ref_id,'NULL') FROM messages ORDER BY id")
  assert "msg1 operator->manager TASK no ref"   "$rows" "1|operator|manager|TASK|NULL"
  assert "msg2 manager->coder-1 TASK ref=1"     "$rows" "2|manager|coder-1|TASK|1"
  assert "msg3 coder-1->reviewer TASK ref=2"    "$rows" "3|coder-1|reviewer|TASK|2"
  assert "msg4 reviewer->coder-1 REPLY ref=3"   "$rows" "4|reviewer|coder-1|REPLY|3"
  assert "msg5 coder-1->manager REPLY ref=2"    "$rows" "5|coder-1|manager|REPLY|2"

  # 6b: deliver via monitor
  write_transcript sess-manager  end_turn 5
  write_transcript sess-coder1   end_turn 5
  write_transcript sess-reviewer end_turn 5
  rm -f "$TMUX_LOG"

  run monitor --once --debounce 100 > /dev/null

  local statuses; statuses=$(sqlite3 "$SYNAPSE_DB" "SELECT id||':'||status FROM messages ORDER BY id")
  assert "msg1 delivered" "$statuses" "1:delivered"
  assert "msg2 delivered" "$statuses" "2:delivered"
  assert "msg3 delivered" "$statuses" "3:delivered"
  assert "tmux send-keys manager"  "$(cat "$TMUX_LOG")" "send-keys -t team:manager"
  assert "tmux send-keys coder-1"  "$(cat "$TMUX_LOG")" "send-keys -t team:coder-1"
  assert "tmux send-keys reviewer" "$(cat "$TMUX_LOG")" "send-keys -t team:reviewer"
}

section7() {
  echo "[7] Re-start allocates a fresh run"
  reset_task_runtime
  seed_session_ids
  run start "$TASK_DIR/task.yml" --no-monitor > /dev/null

  local out; out=$(run start "$TASK_DIR/task.yml" --no-monitor)
  assert "7 second run started" "$out" "team 'run-2' (run #2) started with 4 agent(s)"
  assert "7 run-1 scratch exists" "$(find "$DIR/agents" -maxdepth 2 -type d | sort)" "$DIR/agents/run-1"
  assert "7 run-2 scratch exists" "$(find "$DIR/agents" -maxdepth 2 -type d | sort)" "$DIR/agents/run-2"
  assert "7 run-2 task metadata" "$(cat "$DIR/runs/run-2/task.yml")" "run_id: 2"
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
