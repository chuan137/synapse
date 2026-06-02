import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Project root is one level up from dist/ (where this file compiles to)
export const SYNAPSE_INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function openDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id     TEXT    NOT NULL,
      to_id       TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      priority    INTEGER NOT NULL DEFAULT 5,
      created_at  INTEGER NOT NULL,
      read_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_status (
      agent_id    TEXT    PRIMARY KEY,
      slot        INTEGER UNIQUE,
      name        TEXT,
      session_id  TEXT,
      state       TEXT    NOT NULL CHECK(state IN ('idle', 'working', 'blocked', 'error')),
      current_task TEXT,
      updated_at  INTEGER NOT NULL
    );
  `);

  // Migrate existing tables — ignore errors if columns already exist
  for (const sql of [
    `ALTER TABLE agent_status ADD COLUMN name TEXT`,
    `ALTER TABLE agent_status ADD COLUMN session_id TEXT`,
    `ALTER TABLE agent_status ADD COLUMN slot INTEGER`,
  ]) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  return database;
}

// Default instance: $SYNAPSE_DB_PATH or <cwd>/.synapse/synapse.db
const DB_PATH = process.env.SYNAPSE_DB_PATH
  ?? join(process.cwd(), '.synapse', 'synapse.db');

export const db = openDb(DB_PATH);

export interface Message {
  id: number;
  from_id: string;
  to_id: string;
  content: string;
  priority: number;
  created_at: number;
  read_at: number | null;
}

export interface AgentStatus {
  agent_id: string;
  slot: number;
  name: string | null;
  session_id: string | null;
  state: 'idle' | 'working' | 'blocked' | 'error';
  current_task: string | null;
  updated_at: number;
}

// ── Queries ────────────────────────────────────────────────────────────────

const stmts = {
  getUnread: db.prepare<[string], Message>(`
    SELECT * FROM messages
    WHERE to_id = ? AND read_at IS NULL
    ORDER BY priority ASC, created_at ASC
  `),

  markRead: db.prepare<[number, string]>(`
    UPDATE messages SET read_at = ? WHERE to_id = ? AND read_at IS NULL
  `),

  insertMessage: db.prepare<[string, string, string, number, number]>(`
    INSERT INTO messages (from_id, to_id, content, priority, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  insertAgent: db.prepare<[string, number, number], void>(`
    INSERT INTO agent_status (agent_id, slot, state, updated_at)
    VALUES (?, ?, 'idle', ?)
  `),

  upsertStatus: db.prepare<[string, string | null, string | null, string, string | null, number]>(`
    INSERT INTO agent_status (agent_id, slot, name, session_id, state, current_task, updated_at)
    VALUES (?, (SELECT COALESCE(MAX(slot) + 1, 0) FROM agent_status), ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name         = COALESCE(excluded.name, name),
      session_id   = COALESCE(excluded.session_id, session_id),
      state        = excluded.state,
      current_task = excluded.current_task,
      updated_at   = excluded.updated_at
  `),

  allStatuses: db.prepare<[], AgentStatus>(`
    SELECT * FROM agent_status ORDER BY slot ASC
  `),

  recentMessages: db.prepare<[number], Message>(`
    SELECT * FROM messages ORDER BY created_at DESC LIMIT ?
  `),
};

// Atomically claim the next slot and insert a placeholder row.
// Returns [agentId, slot] where agentId = `${projectId}:${slot}`.
export function claimAgentSlot(projectId: string): { agentId: string; slot: number } {
  return db.transaction(() => {
    const next = (db.prepare<[], { n: number }>(
      `SELECT COALESCE(MAX(slot) + 1, 0) AS n FROM agent_status`
    ).get()!).n;
    const agentId = `${projectId}:${next}`;
    stmts.insertAgent.run(agentId, next, Date.now());
    return { agentId, slot: next };
  })();
}

export function readMessages(agentId: string): Message[] {
  const msgs = stmts.getUnread.all(agentId);
  if (msgs.length > 0) stmts.markRead.run(Date.now(), agentId);
  return msgs;
}

export function sendMessage(
  fromId: string,
  toId: string,
  content: string,
  priority: number = 5
): void {
  stmts.insertMessage.run(fromId, toId, content, priority, Date.now());
}

export function updateStatus(
  agentId: string,
  state: AgentStatus['state'],
  currentTask: string | null = null,
  name: string | null = null,
  sessionId: string | null = null,
): void {
  stmts.upsertStatus.run(agentId, name, sessionId, state, currentTask, Date.now());
}

export function getAllStatuses(): AgentStatus[] {
  return stmts.allStatuses.all();
}

export function getRecentMessages(limit = 100): Message[] {
  return stmts.recentMessages.all(limit);
}
