import { execFileSync } from 'child_process';
import { db, getTmuxPane, readSynapseSettings, sendMessage } from './db.js';

const COUNTED_TOOLS = [
  'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task',
];

interface AgentToolRow {
  agent_id: string;
  role: string | null;
  tool_call_count: number;
  session_id: string;
  state: string;  // 'idle' | 'working' | 'blocked' | 'error'
}

interface AgentSessionRow {
  agent_id: string;
  session_id: string;
}

interface HealthMonitorDeps {
  queryAgents:          (threshold: number) => AgentToolRow[];
  queryOrch:            (threshold: number) => AgentToolRow[];
  queryOrchSessions:    () => AgentSessionRow[];
  queryOrchIdleBlocked: (minBlockedMs: number, now: number) => { agent_id: string }[];
  queryBlockedWorkers:  () => { agent_id: string }[];
  getTmuxPane:          (agentId: string) => string | null;
  execFileSync:         typeof execFileSync;
  readSynapseSettings:  typeof readSynapseSettings;
  sendMessage:          typeof sendMessage;
  pingAgent:            (agentId: string) => boolean;
}

interface HealthMonitorOptions {
  thresholdToolCalls?:     number;   // workers, default 200
  orchThresholdToolCalls?: number;   // orch, default 250
  idleBlockedThresholdMs?: number;   // default 60_000
  autoCompactWorkers?:     boolean;  // default true
  intervalMs?:             number;   // default 15_000
  deps?: Partial<HealthMonitorDeps>;
}

// Worker query: slot > 0, counts named tools OR mcp__ wildcard
const QUERY_SQL = `
  SELECT a.agent_id,
         a.role,
         a.session_id,
         a.state,
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

// Orchestrator query: slot = 0, only agents above threshold
const ORCH_QUERY_SQL = `
  SELECT a.agent_id,
         a.role,
         a.session_id,
         a.state,
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

// Unconditional orch session query — used to keep lastSeenOrchSession current
// even when the orch is below threshold (fixes stale session key after restart)
const ORCH_SESSIONS_SQL = `
  SELECT agent_id, session_id
    FROM agent_status
   WHERE slot = 0 AND ended_at IS NULL
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

const BLOCKED_WORKERS_SQL = `
  SELECT agent_id FROM agent_status
   WHERE slot > 0 AND ended_at IS NULL AND state = 'blocked'
`;

function defaultQueryAgents(threshold: number): AgentToolRow[] {
  return db.prepare(QUERY_SQL).all(...COUNTED_TOOLS, threshold) as AgentToolRow[];
}

function defaultQueryOrch(threshold: number): AgentToolRow[] {
  return db.prepare(ORCH_QUERY_SQL).all(...COUNTED_TOOLS, threshold) as AgentToolRow[];
}

function defaultQueryOrchSessions(): AgentSessionRow[] {
  return db.prepare(ORCH_SESSIONS_SQL).all() as AgentSessionRow[];
}

function defaultQueryOrchIdleBlocked(minBlockedMs: number, now: number): { agent_id: string }[] {
  return db.prepare(ORCH_IDLE_BLOCKED_SQL).all(now, minBlockedMs) as { agent_id: string }[];
}

function defaultQueryBlockedWorkers(): { agent_id: string }[] {
  return db.prepare(BLOCKED_WORKERS_SQL).all() as { agent_id: string }[];
}

export class HealthMonitor {
  private readonly defaultThreshold:       number;
  private readonly orchDefaultThreshold:   number;
  private readonly idleBlockedThresholdMs: number;
  private readonly autoCompactWorkers:     boolean;
  private readonly intervalMs:             number;
  private readonly deps:                   HealthMonitorDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastSeenSession     = new Map<string, string>();
  private lastSeenOrchSession = new Map<string, string>();

  // One-shot warning keys — cleared on monitor start
  private warnedOrch        = new Set<string>();
  private warnedIdleBlocked = new Set<string>();
  private compactedAgents   = new Set<string>(); // key: `${agent_id}:${session_id}`

  currentWarnings = new Set<string>();  // worker tool-call threshold
  orchWarnings    = new Set<string>();  // orch tool-call threshold
  orchIdleBlocked = new Set<string>(); // orch idle while workers blocked

  constructor(opts: HealthMonitorOptions = {}) {
    this.defaultThreshold       = opts.thresholdToolCalls     ?? 200;
    this.orchDefaultThreshold   = opts.orchThresholdToolCalls ?? 250;
    this.idleBlockedThresholdMs = opts.idleBlockedThresholdMs ?? 60_000;
    this.autoCompactWorkers     = opts.autoCompactWorkers ?? true;
    this.intervalMs             = opts.intervalMs ?? 15_000;
    this.deps = {
      queryAgents:          defaultQueryAgents,
      queryOrch:            defaultQueryOrch,
      queryOrchSessions:    defaultQueryOrchSessions,
      queryOrchIdleBlocked: defaultQueryOrchIdleBlocked,
      queryBlockedWorkers:  defaultQueryBlockedWorkers,
      getTmuxPane,
      execFileSync,
      readSynapseSettings,
      sendMessage,
      pingAgent:            () => false,
      ...opts.deps,
    };
  }

  start(): void {
    if (this.timer) return;
    this.warnedOrch.clear();
    this.warnedIdleBlocked.clear();
    this.compactedAgents.clear();
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

    // ── Auto-compact workers at half-threshold ────────────────────────────────
    // `compactHint` is re-read from settings each poll (mirrors toolCallRestartHint pattern).
    // When not explicitly set, it auto-tracks the current worker threshold so the
    // compact trigger stays proportional even if the operator changes toolCallRestartHint.
    // Orchestrator (slot 0) is excluded — QUERY_SQL already filters slot > 0.
    if (this.autoCompactWorkers) {
      const compactHint = typeof settings.compactHint === 'number'
        ? settings.compactHint
        : Math.floor(threshold / 2);

      const compactRows = this.deps.queryAgents(compactHint);
      for (const row of compactRows) {
        const sessionKey = `${row.agent_id}:${row.session_id}`;
        if (this.compactedAgents.has(sessionKey)) continue;
        // Only compact when idle — send-keys into a mid-tool-call agent corrupts input.
        if (row.state !== 'idle') continue;
        this.compactedAgents.add(sessionKey);
        const pane = this.deps.getTmuxPane(row.agent_id);
        if (!pane) {
          process.stderr.write(`[health-monitor] auto-compact: no tmux pane for ${row.agent_id}, skipping\n`);
          continue;
        }
        this.deps.execFileSync('tmux', ['send-keys', '-t', pane, '/compact', 'Enter']);
        // Nudge after compact so agent picks up its next pending message once PostCompact finishes.
        this.deps.pingAgent(row.agent_id);
      }
    }

    // ── Orchestrator session tracking (unconditional — fixes stale key bug) ───
    // Update lastSeenOrchSession regardless of threshold crossing so that when
    // the orch restarts and later climbs above threshold, the session key is fresh
    // and a new warning message is sent.
    for (const row of this.deps.queryOrchSessions()) {
      if (this.lastSeenOrchSession.get(row.agent_id) !== row.session_id) {
        this.orchWarnings.delete(row.agent_id);
        this.lastSeenOrchSession.set(row.agent_id, row.session_id);
      }
    }

    // ── Orchestrator tool-call threshold ──────────────────────────────────────
    const orchThreshold = typeof settings.orchToolCallHint === 'number'
      ? settings.orchToolCallHint
      : this.orchDefaultThreshold;

    const orchRows = this.deps.queryOrch(orchThreshold);

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
      this.orchIdleBlocked.add(id);
      // Use session-scoped key so a restarted orch fires a fresh warning
      const sessionKey = `${id}:${this.lastSeenOrchSession.get(id) ?? ''}`;
      if (!this.warnedIdleBlocked.has(sessionKey)) {
        this.warnedIdleBlocked.add(sessionKey);
        const blockedWorkers = this.deps.queryBlockedWorkers().map((r) => r.agent_id);
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
}
