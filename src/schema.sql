-- Claude Team Synapse — Phase 0 schema
-- Mirrors synapse-spec.md sections 2 and 5. WAL mode is set at connection
-- time by the CLI (PRAGMA journal_mode=WAL), not stored here.

CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  window_name TEXT NOT NULL,
  run_id      INTEGER NOT NULL,    -- 0 = operator sentinel; N = run id (N ≥ 1)
  role        TEXT NOT NULL,       -- manager | coder | reviewer | operator | ...
  model       TEXT,                -- claude model override, e.g. claude-opus-4-8 (null = default)
  session_id  TEXT,                -- Claude Code session id, for jsonl path
  status      TEXT NOT NULL DEFAULT 'unknown',  -- idle | busy | stopped | unknown
  last_seen_at TEXT,
  context_tokens  INTEGER,  -- last known total input context tokens, null if unknown
  sendback_nudged_at TEXT,  -- ISO timestamp of last send-back reminder; NULL = never nudged
  last_notified_at TEXT,    -- ISO timestamp of last hook-stop notification; NULL = never notified
  pending_nudged_at TEXT,   -- ISO timestamp of last pending-work nudge; NULL = never nudged
  pending_nudge_sig TEXT,   -- sorted pending-id set at last nudge; changed set bypasses cooldown
  UNIQUE(window_name, run_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER,                -- references runs.id; NULL for operator messages sent outside a run
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,       -- references agents.window_name
  type       TEXT NOT NULL DEFAULT 'REPLY',  -- TASK | QUESTION | PROGRESS | REPLY
  ref_id     INTEGER,             -- id of the message this one replies to/closes
  body       TEXT NOT NULL,
  title      TEXT,                -- optional short title for QUESTION cards
  options    TEXT,                -- JSON array of strings, nullable (used by QUESTION type)
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | read | failed; delivered is legacy
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  -- Structured subtask flags on a manager -> coder TASK, read by the
  -- `synapse done` completion gate (parsing intent from body text would be
  -- unreliable). NULL on every non-subtask message.
  review_waived INTEGER,   -- 1 = manager waived review for this subtask
  test_required INTEGER,   -- 1 = this subtask needs a tester pass before done
  is_scout      INTEGER    -- 1 = read-only scout TASK: no worktree, no changes, review auto-waived
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  type       TEXT NOT NULL,   -- task_start | task_end | decision
  summary    TEXT NOT NULL,
  run_id     INTEGER,         -- references runs.id; NULL for events logged outside a run
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- bootstrap-spec.md #10/#11: one team == one root task == one run. session
-- is the actual tmux session name (team-<run_id>), set right after insert
-- once the run id is known.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL,
  goal       TEXT,
  workdir    TEXT,              -- absolute path to the code repo being worked on; defaults to project root
  status     TEXT NOT NULL DEFAULT 'running', -- running|completed|failed|aborted
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  session_killed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref_id);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- Plan steps parsed from the ## Plan checklist of a plan artifact.
-- Populated by `synapse doc plan` / `--handoff plan:…`; ticked by `synapse step`.
CREATE TABLE IF NOT EXISTS plan_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  root_msg_id INTEGER NOT NULL,   -- ref-id used when writing the plan artifact
  step_index  INTEGER NOT NULL,   -- 1-based, positional order in the ## Plan checklist
  label       TEXT NOT NULL,      -- text of the checklist item
  completed_at TEXT,              -- ISO timestamp when ticked; NULL = not yet done
  update_text TEXT,               -- free-text from `synapse step … "<update>"`
  UNIQUE(run_id, root_msg_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_root ON plan_steps(run_id, root_msg_id);

-- First-class work items. One row per unit of work dispatched by manager to a
-- coder. Separates work identity from message routing so the completion gate
-- can track state without inferring topology from ref_id chains.
-- status: open | reviewed | merged | done
CREATE TABLE IF NOT EXISTS subtasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL,
  title         TEXT,
  task_msg_id   INTEGER NOT NULL,   -- the manager→coder TASK message that opened this
  review_waived INTEGER DEFAULT 0,
  test_required INTEGER DEFAULT 0,
  is_scout      INTEGER DEFAULT 0,  -- 1 = read-only scout TASK (see messages.is_scout)
  status        TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_subtasks_run ON subtasks(run_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_task_msg ON subtasks(task_msg_id);
