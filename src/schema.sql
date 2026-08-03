-- spec §2.1, §2.2, §2.3, §2.4
-- Four tables only (spec §7, CLAUDE.md banned list). No agents table, no roles table.

CREATE TABLE runs (
  id                   INTEGER PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'running',   -- running | done | failed
  manager_session_id   TEXT NOT NULL,
  manager_model        TEXT,
  manager_turns        INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  ended_at             TEXT
);

CREATE TABLE tasks (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER NOT NULL REFERENCES runs(id),
  text               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',   -- open | cancelled only (spec §2.2)
  source_message_id  INTEGER REFERENCES messages(id),
  created_at         TEXT NOT NULL,
  done_at            TEXT
);

CREATE TABLE subtasks (
  id                INTEGER PRIMARY KEY,
  run_id            INTEGER NOT NULL REFERENCES runs(id),
  task_id           INTEGER NOT NULL REFERENCES tasks(id),
  title             TEXT NOT NULL,
  assignee_role     TEXT NOT NULL,
  depends_on        TEXT NOT NULL DEFAULT '[]',   -- JSON array; first element is the subject (spec §2.3.1)
  worker_session_id TEXT,
  worker_model      TEXT,
  worker_pid        INTEGER,
  worktree_path     TEXT,
  stage             TEXT NOT NULL DEFAULT 'unassigned',  -- unassigned | assigned | done | failed | cancelled
  result_summary    TEXT,
  artifact_path     TEXT,
  verdict           TEXT,
  cancel_reason     TEXT,
  cancelled_at      TEXT,
  delivered         INTEGER NOT NULL DEFAULT 0,   -- 0/1; written ONLY by the watcher after a completed turn (spec §4.2)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  author     TEXT NOT NULL,   -- operator | manager
  type       TEXT NOT NULL,   -- REQUEST | QUESTION | ANSWER | NOTE
  ref_id     INTEGER REFERENCES messages(id),
  body       TEXT NOT NULL,
  title      TEXT,
  options    TEXT,   -- JSON array; required on a QUESTION
  delivered  INTEGER NOT NULL DEFAULT 0,   -- 0/1; meaningful iff author='operator' (spec §4.2)
  created_at TEXT NOT NULL
);

-- spec §2.2: tasks.status holds only 'open' and 'cancelled' (rev 5).
-- Completion is computed, never declared. work_settled is false for a
-- zero-subtask task. work_closed adds the delivered condition (§4.2):
-- every subtask must be terminal AND delivered before the task can close,
-- ensuring the manager has been shown the results in a completed turn.
CREATE VIEW task_progress AS
SELECT t.id, t.run_id, t.status,
       COUNT(s.id)                                          AS n_subtasks,
       SUM(s.stage IN ('done','failed','cancelled'))        AS n_terminal,
       COUNT(s.id) > 0
         AND COUNT(s.id) = SUM(s.stage IN ('done','failed','cancelled'))
                                                            AS work_settled,
       COUNT(s.id) > 0
         AND COUNT(s.id) = SUM(s.stage IN ('done','failed','cancelled'))
         AND COUNT(s.id) = SUM(s.delivered = 1)
                                                            AS work_closed
FROM tasks t LEFT JOIN subtasks s ON s.task_id = t.id
GROUP BY t.id;

CREATE INDEX idx_tasks_run_id ON tasks(run_id);
CREATE INDEX idx_subtasks_run_id ON subtasks(run_id);
CREATE INDEX idx_subtasks_task_id ON subtasks(task_id);
CREATE INDEX idx_subtasks_stage ON subtasks(stage);
CREATE INDEX idx_messages_run_id ON messages(run_id);
CREATE INDEX idx_messages_ref_id ON messages(ref_id);
