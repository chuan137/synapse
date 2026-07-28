import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "fs";
import { dirname, join, resolve } from "path";
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

// Stored in PRAGMA user_version so detection works before any table exists.
// v2 added the `runs` table (bootstrap-spec.md #10/#11).
// v3 added `run_id` column to `messages`.
// v4 rebuilt agents table: run_id NOT NULL, sentinel 0 for operator, UNIQUE(window_name, run_id).
// v5 added retry_count and next_retry_at columns to messages.
// v6 added options column to messages (JSON array for QUESTION type).
// v7 added session_killed_at to runs so UI teardown state survives refresh/SSE updates.
// v8 renamed an intermediate session-completion column to session_killed_at.
// v9 added title column to messages (optional short title for QUESTION cards).
// v11 added model column to agents.
// v12 added context_tokens column to agents.
// v13 added sendback_nudged_at column to agents.
// v14 added review_waived and test_required columns to messages (structured
//     subtask flags for the `synapse done` completion gate).
// v15 added plan_steps table and last_notified_at column to agents.
// v16 added workdir column to runs (absolute path to code repo, separate from synapse project root).
// v17 added pending_nudged_at and pending_nudge_sig columns to agents (DB-backed pending-nudge cooldown).
// v18 added subtasks table: first-class work items keyed by subtask id, separate from message ids.
// v19 added is_scout column to messages and subtasks (structural flag for a
//     read-only scout TASK, replacing the "SCOUT" body-text convention).
// v20 added agent column to plan_steps, so hook-stop can surface newly
//     completed steps in the same push notification it already builds from
//     `messages` — `synapse step` alone never reached the operator.
export const SCHEMA_VERSION = 20;

export function dbPath(): string {
  return resolve(process.env.SYNAPSE_DB ?? "./.synapse/synapse.db");
}

// Synapse-managed per-agent scratch directory for a task:
// .synapse/workdirs/<run-folder>/<agent-name>, sibling to the shared DB.
export function defaultAgentDir(runFolder: string, name: string): string {
  return join(dirname(dbPath()), "workdirs", runFolder, name);
}

export function connect(createParent = false): Database {
  const path = dbPath();
  if (createParent) {
    mkdirSync(dirname(path), { recursive: true });
  } else if (!existsSync(path)) {
    console.error(
      `synapse: no DB at ${path} — run \`synapse init\` first (or set SYNAPSE_DB).`,
    );
    process.exit(1);
  }
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  // Wait on a held lock instead of failing immediately — under WAL the monitor,
  // CLI, and UI may touch the DB concurrently. Avoids spurious SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

// Returns schema version (0 = never set) and whether tables exist.
function probeSchema(db: Database): { version: number; hasTables: boolean } {
  const version = (db.query("PRAGMA user_version").get() as any)
    .user_version as number;
  const hasTables = !!db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'")
    .get();
  return { version, hasTables };
}

function failInit(msg: string): never {
  console.error(`synapse: ${msg}`);
  process.exit(1);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as any[]).some(
    (c) => c.name === column,
  );
}

// Adds a column only if it is missing, so a migration that half-applied (columns
// added but user_version never stamped) can be re-run instead of dying on
// "duplicate column name".
function addColumn(db: Database, table: string, column: string, decl: string) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  }
}

// Runs one migration step and stamps user_version in a single transaction, so
// the schema and its version stamp can never diverge.
function migrate(path: string, from: number, to: number, apply: (db: Database) => void) {
  const db = connect(true);
  try {
    db.exec("BEGIN");
    apply(db);
    db.exec(`PRAGMA user_version=${to};`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    failInit(`migration v${from} → v${to} failed on ${path}: ${err}`);
  }
  db.close();
  console.log(`synapse: migrated ${path} from schema v${from} to v${to}`);
}

export function initDb() {
  const path = dbPath();
  const dataDir = dirname(path);

  if (existsSync(path)) {
    const probe = new Database(path);
    const { version, hasTables } = probeSchema(probe);
    probe.close();
    let currentVersion = version;

    if (version > SCHEMA_VERSION) {
      failInit(
        `DB at ${path} is schema v${version}, newer than this binary supports (v${SCHEMA_VERSION}). Upgrade synapse before running init.`,
      );
    }
    if (hasTables && version === 2) {
      // Migrate v2 → v3: add run_id column to messages (non-destructive).
      // v3 → v4 cannot use ALTER TABLE (agents PRIMARY KEY changed) — falls through
      // to the backup+rebuild path below.
      migrate(path, 2, 3, (db) => addColumn(db, "messages", "run_id", "INTEGER"));
      currentVersion = 3;
      // Fall through: if target is v4, the version<SCHEMA_VERSION branch below fires next.
    }
    if (hasTables && currentVersion === 4) {
      // Migrate v4 → v5: add retry_count and next_retry_at columns to messages (non-destructive).
      migrate(path, 4, 5, (db) => {
        addColumn(db, "messages", "retry_count", "INTEGER NOT NULL DEFAULT 0");
        addColumn(db, "messages", "next_retry_at", "TEXT");
      });
      currentVersion = 5;
    }
    if (hasTables && currentVersion === 5) {
      // Migrate v5 → v6: add options column to messages (non-destructive).
      migrate(path, 5, 6, (db) => addColumn(db, "messages", "options", "TEXT"));
      currentVersion = 6;
    }
    if (hasTables && currentVersion === 6) {
      // Migrate v6 → v8: remember whether a terminal run's tmux session was killed.
      migrate(path, 6, 8, (db) => addColumn(db, "runs", "session_killed_at", "TEXT"));
      currentVersion = 8;
    }
    if (hasTables && currentVersion === 7) {
      // Migrate v7 → v8: replace the intermediate column with explicit session state.
      migrate(path, 7, 8, (db) => {
        if (!hasColumn(db, "runs", "session_killed_at")) {
          db.exec(`ALTER TABLE runs RENAME COLUMN acknowledged_at TO session_killed_at;`);
        }
      });
      currentVersion = 8;
    }
    if (hasTables && currentVersion === 8) {
      // Migrate v8 → v9: add title column to messages (non-destructive).
      migrate(path, 8, 9, (db) => addColumn(db, "messages", "title", "TEXT"));
      currentVersion = 9;
    }
    if (hasTables && currentVersion === 9) {
      // Migrate v9 → v10: add run_id to events for manager activity visibility.
      migrate(path, 9, 10, (db) => {
        addColumn(db, "events", "run_id", "INTEGER");
        db.exec(`CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);`);
      });
      currentVersion = 10;
    }
    if (hasTables && currentVersion === 10) {
      // Migrate v10 → v11: add model column to agents (non-destructive).
      migrate(path, 10, 11, (db) => addColumn(db, "agents", "model", "TEXT"));
      currentVersion = 11;
    }
    if (hasTables && currentVersion === 11) {
      // Migrate v11 → v12: add context_tokens column to agents (non-destructive).
      migrate(path, 11, 12, (db) => addColumn(db, "agents", "context_tokens", "INTEGER"));
      currentVersion = 12;
    }
    if (hasTables && currentVersion === 12) {
      // Migrate v12 → v13: add sendback_nudged_at column to agents (non-destructive).
      migrate(path, 12, 13, (db) => addColumn(db, "agents", "sendback_nudged_at", "TEXT"));
      currentVersion = 13;
    }
    if (hasTables && currentVersion === 13) {
      // Migrate v13 → v14: add review_waived and test_required columns to
      // messages (non-destructive) for the done completion gate.
      migrate(path, 13, 14, (db) => {
        addColumn(db, "messages", "review_waived", "INTEGER");
        addColumn(db, "messages", "test_required", "INTEGER");
      });
      currentVersion = 14;
    }
    if (hasTables && currentVersion === 14) {
      // Migrate v14 → v15: add plan_steps table and last_notified_at to agents.
      migrate(path, 14, 15, (db) => {
        addColumn(db, "agents", "last_notified_at", "TEXT");
        db.exec(`
          CREATE TABLE IF NOT EXISTS plan_steps (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id      INTEGER NOT NULL,
            root_msg_id INTEGER NOT NULL,
            step_index  INTEGER NOT NULL,
            label       TEXT NOT NULL,
            completed_at TEXT,
            update_text TEXT,
            UNIQUE(run_id, root_msg_id, step_index)
          );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_steps_root ON plan_steps(run_id, root_msg_id);`);
      });
      currentVersion = 15;
    }
    if (hasTables && currentVersion === 15) {
      // Migrate v15 → v16: add workdir column to runs (non-destructive).
      migrate(path, 15, 16, (db) => addColumn(db, "runs", "workdir", "TEXT"));
      currentVersion = 16;
    }
    if (hasTables && currentVersion === 16) {
      // Migrate v16 → v17: add pending_nudged_at and pending_nudge_sig to agents
      // (DB-backed pending-nudge cooldown shared across monitor, hook, and send).
      migrate(path, 16, 17, (db) => {
        addColumn(db, "agents", "pending_nudged_at", "TEXT");
        addColumn(db, "agents", "pending_nudge_sig", "TEXT");
      });
      currentVersion = 17;
    }
    if (hasTables && currentVersion === 17) {
      // Migrate v17 → v18: add subtasks table (first-class work items, separate
      // from message ids, so the done gate doesn't infer topology from ref_id).
      migrate(path, 17, 18, (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS subtasks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id        INTEGER NOT NULL,
            title         TEXT,
            task_msg_id   INTEGER NOT NULL,
            review_waived INTEGER DEFAULT 0,
            test_required INTEGER DEFAULT 0,
            status        TEXT NOT NULL DEFAULT 'open'
          );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_run ON subtasks(run_id);`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_task_msg ON subtasks(task_msg_id);`);
      });
      currentVersion = 18;
    }
    if (hasTables && currentVersion === 18) {
      // Migrate v18 → v19: add is_scout column to messages and subtasks
      // (non-destructive) — structural flag for a read-only scout TASK.
      migrate(path, 18, 19, (db) => {
        addColumn(db, "messages", "is_scout", "INTEGER");
        addColumn(db, "subtasks", "is_scout", "INTEGER DEFAULT 0");
      });
      currentVersion = 19;
    }
    if (hasTables && currentVersion === 19) {
      // Migrate v19 → v20: add agent column to plan_steps (non-destructive) —
      // lets hook-stop attribute a completed step to the agent whose turn
      // just ended, so it can fold newly-ticked steps into that agent's
      // push notification alongside its messages.
      migrate(path, 19, 20, (db) => addColumn(db, "plan_steps", "agent", "TEXT"));
      currentVersion = 20;
    }
    if (hasTables && currentVersion < SCHEMA_VERSION) {
      // Move the whole data directory aside — it may also hold audit logs that
      // belong with the old DB, not mixed into the fresh one.
      const backupDir = `${dataDir}.v${currentVersion}.bak-${Date.now()}`;
      renameSync(dataDir, backupDir);
      console.log(
        `synapse: found pre-v${SCHEMA_VERSION} data (schema v${currentVersion}) at ${dataDir} — moved entire folder to ${backupDir}`,
      );
    }
    // hasTables===false or already current version: fall through, schema creation is idempotent.
  }

  const db = connect(true);
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
  console.log(`synapse: initialized ${path} (schema v${SCHEMA_VERSION})`);
}
