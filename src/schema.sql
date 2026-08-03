-- spec §2.1, §2.2, §2.3, §2.4
-- Four tables only (spec §7, CLAUDE.md banned list). No agents table, no roles table.

CREATE TABLE runs (
  id                   INTEGER PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'running',   -- running | done | failed
  manager_session_id   TEXT NOT NULL,
  manager_model        TEXT,
  rev_counter          INTEGER NOT NULL DEFAULT 0,
  manager_reacted_rev  INTEGER NOT NULL DEFAULT 0,
  manager_turns        INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  ended_at             TEXT
);

CREATE TABLE tasks (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER NOT NULL REFERENCES runs(id),
  text               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',   -- open | planning | running | done | cancelled
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
  rev               INTEGER,
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
  rev        INTEGER,   -- assigned iff author='operator'; NULL otherwise (spec §4.2)
  created_at TEXT NOT NULL
);

-- spec §2.2: tasks.status is a declaration, not ground truth. work_settled is
-- derived from subtasks and is false for a task with zero subtasks.
CREATE VIEW task_progress AS
SELECT t.id, t.run_id, t.status,
       COUNT(s.id)                                          AS n_subtasks,
       SUM(s.stage IN ('done','failed','cancelled'))        AS n_terminal,
       COUNT(s.id) > 0
         AND COUNT(s.id) = SUM(s.stage IN ('done','failed','cancelled'))
                                                              AS work_settled
FROM tasks t LEFT JOIN subtasks s ON s.task_id = t.id
GROUP BY t.id;

CREATE INDEX idx_tasks_run_id ON tasks(run_id);
CREATE INDEX idx_subtasks_run_id ON subtasks(run_id);
CREATE INDEX idx_subtasks_task_id ON subtasks(task_id);
CREATE INDEX idx_subtasks_stage ON subtasks(stage);
CREATE INDEX idx_messages_run_id ON messages(run_id);
CREATE INDEX idx_messages_ref_id ON messages(ref_id);
