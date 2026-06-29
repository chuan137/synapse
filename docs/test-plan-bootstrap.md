# Phase 3 Manual Test Plan

Tests `synapse start`, `synapse stop`, `synapse attach`, multi-agent team bootstrap,
and the full TASK→STATUS→REVIEW→STATUS ref_id chain.

## Setup

```bash
make build
export SYNAPSE_DB=/tmp/synapse-p3.db
rm -f $SYNAPSE_DB

# Fake tmux — records calls, always succeeds
mkdir -p /tmp/synapse-fakebin
cat > /tmp/synapse-fakebin/tmux << 'EOF'
#!/bin/sh
echo "$@" >> /tmp/synapse-tmux.log
exit 0
EOF
chmod +x /tmp/synapse-fakebin/tmux
export PATH="/tmp/synapse-fakebin:$PATH"

# Fake transcript directory
mkdir -p /tmp/synapse-projects/my-project
export CLAUDE_PROJECTS_DIR=/tmp/synapse-projects
```

Helper to write a transcript with an optional backdated mtime:

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

## 1. YAML Parsing Errors

### 1a. File not found

```bash
./bin/synapse start /nonexistent/team.yaml --no-monitor
```

**Expected:** exit 1, stderr contains `team config not found`.

### 1b. Missing session field

```bash
cat > /tmp/nosession.yaml << 'EOF'
agents:
  - name: manager
    role: manager
    cwd: .
EOF
./bin/synapse start /tmp/nosession.yaml --no-monitor
```

**Expected:** exit 1, stderr contains `missing 'session'`.

### 1c. No agents

```bash
cat > /tmp/empty.yaml << 'EOF'
session: team
agents:
EOF
./bin/synapse start /tmp/empty.yaml --no-monitor
```

**Expected:** exit 1, stderr contains `no agents defined`.

---

## 2. start — DB initialisation and operator registration

```bash
cat > /tmp/team.yaml << 'EOF'
session: team
agents:
  - name: manager
    role: manager
    cwd: /tmp
  - name: coder-1
    role: coder
    cwd: /tmp
  - name: coder-2
    role: coder
    cwd: /tmp
  - name: reviewer
    role: reviewer
    cwd: /tmp
EOF

./bin/synapse start /tmp/team.yaml --no-monitor
```

The fake tmux will time out waiting for session-id files (30 s each), so seed them first:

```bash
# Seed session-id files so start doesn't wait
mkdir -p "$(dirname $SYNAPSE_DB)"
echo "sess-manager" > "$(dirname $SYNAPSE_DB)/manager.session-id"
echo "sess-coder1"  > "$(dirname $SYNAPSE_DB)/coder-1.session-id"
echo "sess-coder2"  > "$(dirname $SYNAPSE_DB)/coder-2.session-id"
echo "sess-reviewer" > "$(dirname $SYNAPSE_DB)/reviewer.session-id"

./bin/synapse start /tmp/team.yaml --no-monitor
./bin/synapse status
```

**Expected:**
- stdout confirms `team 'team' started with 4 agent(s)`
- `synapse status` lists 5 rows: `operator` (role=operator) + the 4 agents
- `operator` status is `idle`
- manager/coder-1/coder-2/reviewer each have their session ids

---

## 3. start — initial goal queued as TASK to manager

```bash
./bin/synapse start /tmp/team.yaml --no-monitor --goal "Build feature X end to end"
./bin/synapse pending manager
```

**Expected:** one `pending` TASK from `operator` to `manager` with body `Build feature X end to end`.

---

## 4. start — monitor window receives the monitor command

Run without `--no-monitor` (fake tmux records the send-keys call):

```bash
rm -f /tmp/synapse-tmux.log
./bin/synapse start /tmp/team.yaml --goal "Build something"
grep 'monitor' /tmp/synapse-tmux.log
```

**Expected:** tmux log contains a `send-keys` entry targeting `team:monitor` with `synapse monitor`.

---

## 5. stop — marks agent stopped and kills window

```bash
./bin/synapse stop coder-2 --session team
sqlite3 $SYNAPSE_DB "SELECT status FROM agents WHERE window_name='coder-2'"
grep 'kill-window' /tmp/synapse-tmux.log
```

**Expected:**
- DB status = `stopped`
- tmux log contains `kill-window -t team:coder-2`

### 5b. stop on unknown agent

```bash
./bin/synapse stop ghost --session team
```

**Expected:** exit 1, stderr contains `no registered agent`.

### 5c. Stopped agent ignored by monitor

```bash
write_transcript sess-coder2 end_turn 5
./bin/synapse send coder-2 INFO "message to stopped agent" --from manager
./bin/synapse monitor --once --debounce 100
sqlite3 $SYNAPSE_DB "SELECT status FROM messages WHERE to_agent='coder-2'"
```

**Expected:** message status stays `pending` — monitor skips stopped agents.

---

## 6. Full TASK→STATUS→REVIEW→STATUS ref_id chain

This exercises the hub-and-spoke topology from spec section 6.3/6.4.

```bash
# Re-init with a clean DB
rm -f $SYNAPSE_DB
./bin/synapse init
./bin/synapse register operator  operator  ""
./bin/synapse register manager   manager   sess-manager
./bin/synapse register coder-1   coder     sess-coder1
./bin/synapse register reviewer  reviewer  sess-reviewer

# operator → manager: root TASK
./bin/synapse send manager TASK "Build feature X" --from operator
ROOT_ID=$(sqlite3 $SYNAPSE_DB "SELECT id FROM messages WHERE from_agent='operator' LIMIT 1")

# manager → coder-1: subtask (ref_id = root TASK)
./bin/synapse send coder-1 TASK "Implement X" --from manager --ref-id $ROOT_ID
SUB_ID=$(sqlite3 $SYNAPSE_DB "SELECT id FROM messages WHERE to_agent='coder-1' LIMIT 1")

# coder-1 → reviewer: REVIEW (ref_id = subtask)
./bin/synapse send reviewer REVIEW "Please review PR #42" --from coder-1 --ref-id $SUB_ID
REV_ID=$(sqlite3 $SYNAPSE_DB "SELECT id FROM messages WHERE type='REVIEW' LIMIT 1")

# reviewer → coder-1: STATUS on review (ref_id = REVIEW)
./bin/synapse send coder-1 STATUS "LGTM" --from reviewer --ref-id $REV_ID

# coder-1 → manager: final STATUS (ref_id = subtask)
./bin/synapse send manager STATUS "Feature X done" --from coder-1 --ref-id $SUB_ID

# Inspect chain
sqlite3 $SYNAPSE_DB "SELECT id, from_agent, to_agent, type, ref_id, status FROM messages ORDER BY id"
```

**Expected:**

| id | from      | to       | type   | ref_id |
|----|-----------|----------|--------|--------|
| 1  | operator  | manager  | TASK   | NULL   |
| 2  | manager   | coder-1  | TASK   | 1      |
| 3  | coder-1   | reviewer | REVIEW | 2      |
| 4  | reviewer  | coder-1  | STATUS | 3      |
| 5  | coder-1   | manager  | STATUS | 2      |

### 6b. Deliver the chain via monitor

```bash
write_transcript sess-manager  end_turn 5
write_transcript sess-coder1   end_turn 5
write_transcript sess-reviewer end_turn 5
rm -f /tmp/synapse-tmux.log

./bin/synapse monitor --once --debounce 100

sqlite3 $SYNAPSE_DB "SELECT id, to_agent, status FROM messages ORDER BY id"
grep 'send-keys' /tmp/synapse-tmux.log
```

**Expected:** all 5 messages `delivered`; tmux log has one `send-keys` per recipient window.

---

## 7. Idempotent re-start (session already exists)

```bash
./bin/synapse start /tmp/team.yaml --no-monitor
```

Run twice against the same fake tmux (which always returns exit 0 for `has-session`).

**Expected:** second run prints `tmux session 'team' already exists — reusing` and completes without error.

---

## Teardown

```bash
rm -f $SYNAPSE_DB /tmp/synapse-tmux.log /tmp/team.yaml /tmp/nosession.yaml /tmp/empty.yaml
rm -rf /tmp/synapse-fakebin /tmp/synapse-projects "$(dirname $SYNAPSE_DB)"
```
