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
export const SCHEMA_VERSION = 8;

export function dbPath(): string {
  return resolve(process.env.SYNAPSE_DB ?? "./.synapse/synapse.db");
}

// Synapse-managed per-agent scratch directory for a task:
// .synapse/agents/<task-name>/<agent-name>, sibling to the shared DB.
export function defaultAgentDir(taskName: string, name: string): string {
  return join(dirname(dbPath()), "agents", taskName, name);
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
      const db = connect(true);
      db.exec(`ALTER TABLE messages ADD COLUMN run_id INTEGER;`);
      db.exec(`PRAGMA user_version=3;`);
      db.close();
      currentVersion = 3;
      console.log(`synapse: migrated ${path} from schema v2 to v3`);
      // Fall through: if target is v4, the version<SCHEMA_VERSION branch below fires next.
    }
    if (hasTables && currentVersion === 4) {
      // Migrate v4 → v5: add retry_count and next_retry_at columns to messages (non-destructive).
      const db = connect(true);
      db.exec(`ALTER TABLE messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;`);
      db.exec(`ALTER TABLE messages ADD COLUMN next_retry_at TEXT;`);
      db.exec(`PRAGMA user_version=5;`);
      db.close();
      currentVersion = 5;
      console.log(`synapse: migrated ${path} from schema v4 to v5`);
    }
    if (hasTables && currentVersion === 5) {
      // Migrate v5 → v6: add options column to messages (non-destructive).
      const db = connect(true);
      db.exec(`ALTER TABLE messages ADD COLUMN options TEXT;`);
      db.exec(`PRAGMA user_version=6;`);
      db.close();
      currentVersion = 6;
      console.log(`synapse: migrated ${path} from schema v5 to v6`);
    }
    if (hasTables && currentVersion === 6) {
      // Migrate v6 → v8: remember whether a terminal run's tmux session was killed.
      const db = connect(true);
      db.exec(`ALTER TABLE runs ADD COLUMN session_killed_at TEXT;`);
      db.exec(`PRAGMA user_version=8;`);
      db.close();
      currentVersion = 8;
      console.log(`synapse: migrated ${path} from schema v6 to v8`);
    }
    if (hasTables && currentVersion === 7) {
      // Migrate v7 → v8: replace the intermediate column with explicit session state.
      const db = connect(true);
      db.exec(`ALTER TABLE runs RENAME COLUMN acknowledged_at TO session_killed_at;`);
      db.exec(`PRAGMA user_version=8;`);
      db.close();
      currentVersion = 8;
      console.log(`synapse: migrated ${path} from schema v7 to v8`);
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
