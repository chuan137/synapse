import { db, readSynapseSettings, sendMessage } from './db.js';

const COUNTED_TOOLS = [
  'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task',
];

interface AgentToolRow {
  agent_id: string;
  role: string | null;
  tool_call_count: number;
  session_id: string;
}

interface HealthMonitorDeps {
  queryAgents:          (threshold: number) => AgentToolRow[];
  queryOrch:            (threshold: number) => AgentToolRow[];
  queryOrchIdleBlocked: (minBlockedMs: number, now: number) => { agent_id: string }[];
  readSynapseSettings:  typeof readSynapseSettings;
  sendMessage:          typeof sendMessage;
}

interface HealthMonitorOptions {
  thresholdToolCalls?:     number;   // workers, default 200
  orchThresholdToolCalls?: number;   // orch, default 250
  idleBlockedThresholdMs?: number;   // default 60_000
  intervalMs?:             number;   // default 15_000
  deps?: Partial<HealthMonitorDeps>;
}

// Worker query: slot > 0, counts named tools OR mcp__ wildcard
const QUERY_SQL = `
  SELECT a.agent_id,
         a.role,
         a.session_id,
         COUNT(tm.id) AS tool_call_count
    FROM agent_status a
    JOIN tool_metrics tm
      ON tm.synapse_agent_id = a.agent_id
     AND tm.session_id = a.session_id
     AND (tm.tool IN (${COUNTED_TOOLS.map(() => '?').join(',')}) OR tm.tool LIKE 'mcp__%')
   WHERE a.ended_at IS NULL
     AND a.slot > 0
   GROUP BY a.agent_id
  HAVING COUNT(tm.id) >= ?
`;

// Orchestrator query: slot = 0
const ORCH_QUERY_SQL = `
  SELECT a.agent_id,
         a.role,
         a.session_id,
         COUNT(tm.id) AS tool_call_count
    FROM agent_status a
    JOIN tool_metrics tm
      ON tm.synapse_agent_id = a.agent_id
     AND tm.session_id = a.session_id
     AND (tm.tool IN (${COUNTED_TOOLS.map(() => '?').join(',')}) OR tm.tool LIKE 'mcp__%')
   WHERE a.ended_at IS NULL
     AND a.slot = 0
   GROUP BY a.agent_id
  HAVING COUNT(tm.id) >= ?
`;

const ORCH_IDLE_BLOCKED_SQL = `
  SELECT o.agent_id
    FROM agent_status o
   WHERE o.slot = 0
     AND o.ended_at IS NULL
     AND o.state = 'idle'
     AND EXISTS (
       SELECT 1 FROM agent_status w
        WHERE w.slot > 0
          AND w.ended_at IS NULL
          AND w.state = 'blocked'
          AND (? - w.updated_at) >= ?
     )
`;

function defaultQueryAgents(threshold: number): AgentToolRow[] {
  return db.prepare(QUERY_SQL).all(...COUNTED_TOOLS, threshold) as AgentToolRow[];
}

function defaultQueryOrch(threshold: number): AgentToolRow[] {
  return db.prepare(ORCH_QUERY_SQL).all(...COUNTED_TOOLS, threshold) as AgentToolRow[];
}

function defaultQueryOrchIdleBlocked(minBlockedMs: number, now: number): { agent_id: string }[] {
  return db.prepare(ORCH_IDLE_BLOCKED_SQL).all(now, minBlockedMs) as { agent_id: string }[];
}

export class HealthMonitor {
  private readonly defaultThreshold:      number;
  private readonly orchDefaultThreshold:  number;
  private readonly idleBlockedThresholdMs: number;
  private readonly intervalMs:            number;
  private readonly deps:                  HealthMonitorDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastSeenSession     = new Map<string, string>();
  private lastSeenOrchSession = new Map<string, string>();

  // One-shot warning keys — cleared on monitor start
  private warnedOrch         = new Set<string>();
  private warnedIdleBlocked  = new Set<string>();

  currentWarnings = new Set<string>();  // worker tool-call threshold
  orchWarnings    = new Set<string>();  // orch tool-call threshold
  orchIdleBlocked = new Set<string>(); // orch idle while workers blocked

  constructor(opts: HealthMonitorOptions = {}) {
    this.defaultThreshold       = opts.thresholdToolCalls     ?? 200;
    this.orchDefaultThreshold   = opts.orchThresholdToolCalls ?? 250;
    this.idleBlockedThresholdMs = opts.idleBlockedThresholdMs ?? 60_000;
    this.intervalMs             = opts.intervalMs ?? 15_000;
    this.deps = {
      queryAgents:          defaultQueryAgents,
      queryOrch:            defaultQueryOrch,
      queryOrchIdleBlocked: defaultQueryOrchIdleBlocked,
      readSynapseSettings,
      sendMessage,
      ...opts.deps,
    };
  }

  start(): void {
    if (this.timer) return;
    this.warnedOrch.clear();
    this.warnedIdleBlocked.clear();
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  _poll(): void {
    const settings = this.deps.readSynapseSettings();

    // ── Worker tool-call threshold ────────────────────────────────────────────
    const threshold = typeof settings.toolCallRestartHint === 'number'
      ? settings.toolCallRestartHint
      : this.defaultThreshold;

    const rows = this.deps.queryAgents(threshold);

    for (const row of rows) {
      if (this.lastSeenSession.get(row.agent_id) !== row.session_id) {
        this.currentWarnings.delete(row.agent_id);
        this.lastSeenSession.set(row.agent_id, row.session_id);
      }
    }

    const crossingIds = new Set(rows.map((r) => r.agent_id));
    for (const id of this.currentWarnings) {
      if (!crossingIds.has(id)) this.currentWarnings.delete(id);
    }
    for (const id of crossingIds) {
      this.currentWarnings.add(id);
    }

    // ── Orchestrator tool-call threshold ──────────────────────────────────────
    const orchThreshold = typeof settings.orchToolCallHint === 'number'
      ? settings.orchToolCallHint
      : this.orchDefaultThreshold;

    const orchRows = this.deps.queryOrch(orchThreshold);

    for (const row of orchRows) {
      if (this.lastSeenOrchSession.get(row.agent_id) !== row.session_id) {
        this.orchWarnings.delete(row.agent_id);
        this.lastSeenOrchSession.set(row.agent_id, row.session_id);
      }
    }

    const orchCrossingIds = new Set(orchRows.map((r) => r.agent_id));
    for (const id of this.orchWarnings) {
      if (!orchCrossingIds.has(id)) this.orchWarnings.delete(id);
    }
    for (const id of orchCrossingIds) {
      this.orchWarnings.add(id);
      const sessionKey = `${id}:${this.lastSeenOrchSession.get(id) ?? ''}`;
      if (!this.warnedOrch.has(sessionKey)) {
        this.warnedOrch.add(sessionKey);
        const row = orchRows.find((r) => r.agent_id === id);
        const count = row?.tool_call_count ?? orchThreshold;
        this.deps.sendMessage(
          'system',
          'human',
          `[health] orchestrator at ${count} tool calls (threshold ${orchThreshold}) — consider /clear or restart`,
          5,
        );
      }
    }

    // ── Orch idle-while-workers-blocked ───────────────────────────────────────
    const idleBlockedMs = typeof settings.idleBlockedThresholdMs === 'number'
      ? settings.idleBlockedThresholdMs
      : this.idleBlockedThresholdMs;

    const idleBlockedRows = this.deps.queryOrchIdleBlocked(idleBlockedMs, Date.now());

    const newIdleBlocked = new Set(idleBlockedRows.map((r) => r.agent_id));
    for (const id of this.orchIdleBlocked) {
      if (!newIdleBlocked.has(id)) this.orchIdleBlocked.delete(id);
    }
    for (const id of newIdleBlocked) {
      const wasAlreadySet = this.orchIdleBlocked.has(id);
      this.orchIdleBlocked.add(id);
      if (!wasAlreadySet && !this.warnedIdleBlocked.has(id)) {
        this.warnedIdleBlocked.add(id);
        const blockedWorkers = this._getBlockedWorkerIds();
        const list = blockedWorkers.length > 0 ? blockedWorkers.join(', ') : 'unknown';
        this.deps.sendMessage(
          'system',
          'human',
          `[health] orch idle while workers blocked: ${list} blocked for ≥${idleBlockedMs / 1000}s`,
          5,
        );
      }
    }
  }

  private _getBlockedWorkerIds(): string[] {
    try {
      const rows = db.prepare(
        `SELECT agent_id FROM agent_status WHERE slot > 0 AND ended_at IS NULL AND state = 'blocked'`
      ).all() as { agent_id: string }[];
      return rows.map((r) => r.agent_id);
    } catch {
      return [];
    }
  }
}
