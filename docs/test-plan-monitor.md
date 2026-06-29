# Phase 2 E2E Test Plan

## Setup

```bash
make build
export SYNAPSE_DB=/tmp/synapse-test.db
rm -f $SYNAPSE_DB

# Fake tmux
mkdir -p /tmp/synapse-fakebin
cat > /tmp/synapse-fakebin/tmux << 'EOF'
#!/bin/sh
echo "$@" >> /tmp/synapse-tmux.log
exit 0
EOF
chmod +x /tmp/synapse-fakebin/tmux
export PATH="/tmp/synapse-fakebin:$PATH"

# Fake transcript directory (mirrors ~/.claude/projects/<slug>/<session>.jsonl)
mkdir -p /tmp/synapse-projects/my-project
export CLAUDE_PROJECTS_DIR=/tmp/synapse-projects
```

Helper to write a transcript with a backdated mtime (simulates debounce elapsed):

```bash
write_transcript() {
  local session=$1 stop_reason=$2 age_secs=${3:-0}
  local path="/tmp/synapse-projects/my-project/${session}.jsonl"
  echo "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stop_reason\":\"${stop_reason}\"}}" > "$path"
  if [ "$age_secs" -gt 0 ]; then
    python3 -c "import os,time; os.utime('$path',(time.time()-$age_secs,)*2)"
  fi
}
```

---

## 1. Init & Register

```bash
./bin/synapse init
./bin/synapse register manager manager sess-manager
./bin/synapse register coder-1 coder   sess-coder
./bin/synapse status
```

**Expected:** two agents, both status `unknown`.

---

## 2. Send a TASK

```bash
./bin/synapse send coder-1 TASK "implement feature X" --from manager
./bin/synapse pending
```

**Expected:** one message, status `pending`, to_agent `coder-1`.

---

## 3. Idle Detection — tool_use → busy, no delivery

```bash
write_transcript sess-coder tool_use
./bin/synapse monitor --once --debounce 0
./bin/synapse status
cat /tmp/synapse-tmux.log   # should be empty
```

**Expected:** coder-1 → `busy`; tmux log empty; message still `pending`.

---

## 4. Idle Detection — end_turn past debounce → idle + delivery

```bash
write_transcript sess-coder end_turn 5
./bin/synapse monitor --once --debounce 100
./bin/synapse status
./bin/synapse pending
cat /tmp/synapse-tmux.log
```

**Expected:**
- coder-1 → `idle`
- message → `delivered`
- tmux log contains `send-keys -t team:coder-1 -l -- implement feature X` and `send-keys -t team:coder-1 Enter`

---

## 5. Debounce Guard — end_turn within window → no delivery

```bash
./bin/synapse send coder-1 INFO "another message" --from manager
write_transcript sess-coder end_turn 0   # timestamp = now
rm -f /tmp/synapse-tmux.log
./bin/synapse monitor --once --debounce 60000
cat /tmp/synapse-tmux.log   # should be empty
```

**Expected:** tmux log empty; message still `pending`.

---

## 6. Full TASK → STATUS Round Trip

```bash
TASK_ID=$(sqlite3 $SYNAPSE_DB "SELECT id FROM messages WHERE type='TASK' LIMIT 1")
./bin/synapse send manager STATUS "feature X done" --from coder-1 --ref-id $TASK_ID

write_transcript sess-manager end_turn 5
./bin/synapse monitor --once --debounce 100
cat /tmp/synapse-tmux.log
sqlite3 $SYNAPSE_DB "SELECT type,status,ref_id FROM messages"
```

**Expected:**
- tmux log contains `send-keys -t team:manager -l -- feature X done`
- STATUS row has `ref_id` = TASK id

---

## 7. tmux Failure → message marked failed, no retry

```bash
cat > /tmp/synapse-fakebin/tmux << 'EOF'
#!/bin/sh
echo "no such window" >&2
exit 1
EOF
chmod +x /tmp/synapse-fakebin/tmux

write_transcript sess-coder end_turn 5
./bin/synapse monitor --once --debounce 100
sqlite3 $SYNAPSE_DB "SELECT body,status FROM messages WHERE to_agent='coder-1' ORDER BY id DESC LIMIT 1"

# Run again — should stay failed, not retried
./bin/synapse monitor --once --debounce 100
sqlite3 $SYNAPSE_DB "SELECT body,status FROM messages WHERE to_agent='coder-1' ORDER BY id DESC LIMIT 1"
```

**Expected:** status `failed` after first run; unchanged after second run.

---

## Teardown

```bash
rm -f /tmp/synapse-test.db /tmp/synapse-tmux.log
rm -rf /tmp/synapse-fakebin /tmp/synapse-projects
```
