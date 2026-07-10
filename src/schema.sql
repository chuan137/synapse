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
  next_retry_at TEXT
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
