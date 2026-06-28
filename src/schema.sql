-- Claude Team Synapse — Phase 0 schema
-- Mirrors synapse-spec.md sections 2 and 5. WAL mode is set at connection
-- time by the CLI (PRAGMA journal_mode=WAL), not stored here.

CREATE TABLE IF NOT EXISTS agents (
  window_name TEXT PRIMARY KEY,    -- tmux window name == agent address
  role        TEXT NOT NULL,       -- manager | coder | reviewer | operator | ...
  session_id  TEXT,                -- Claude Code session id, for jsonl path
  status      TEXT NOT NULL DEFAULT 'unknown',  -- idle | busy | stopped | unknown
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,       -- references agents.window_name, or 'broadcast'
  type       TEXT NOT NULL DEFAULT 'INFO',  -- TASK | STATUS | REVIEW | ACK | INFO
  ref_id     INTEGER,             -- id of the message this one replies to/closes
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | read | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  type       TEXT NOT NULL,   -- task_start | task_end | decision
  summary    TEXT NOT NULL,
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
  ended_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref_id);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
