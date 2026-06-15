import { db, readSynapseSettings } from './db.js';

const COUNTED_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebFetch'];

interface AgentToolRow {
  agent_id: string;
  role: string | null;
  tool_call_count: number;
  session_id: string;
}

interface HealthMonitorDeps {
  queryAgents: (threshold: number) => AgentToolRow[];
  readSynapseSettings: typeof readSynapseSettings;
}

interface HealthMonitorOptions {
  thresholdToolCalls?: number;
  intervalMs?: number;
  deps?: Partial<HealthMonitorDeps>;
}

const QUERY_SQL = `
  SELECT a.agent_id,
         a.role,
         a.session_id,
         COUNT(tm.id) AS tool_call_count
    FROM agent_status a
    JOIN tool_metrics tm
      ON tm.synapse_agent_id = a.agent_id
     AND tm.session_id = a.session_id
     AND tm.tool IN (${COUNTED_TOOLS.map(() => '?').join(',')})
   WHERE a.ended_at IS NULL
     AND a.slot > 0
   GROUP BY a.agent_id
  HAVING COUNT(tm.id) >= ?
`;

function defaultQueryAgents(threshold: number): AgentToolRow[] {
  return db.prepare(QUERY_SQL).all(...COUNTED_TOOLS, threshold) as AgentToolRow[];
}

export class HealthMonitor {
  private readonly defaultThreshold: number;
  private readonly intervalMs: number;
  private readonly deps: HealthMonitorDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeenSession = new Map<string, string>();
  currentWarnings = new Set<string>();

  constructor(opts: HealthMonitorOptions = {}) {
    this.defaultThreshold = opts.thresholdToolCalls ?? 300;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.deps = {
      queryAgents: defaultQueryAgents,
      readSynapseSettings,
      ...opts.deps,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private _poll(): void {
    const settings = this.deps.readSynapseSettings();
    const threshold = typeof settings.toolCallRestartHint === 'number'
      ? settings.toolCallRestartHint
      : this.defaultThreshold;

    const rows = this.deps.queryAgents(threshold);

    // Session-change cleanup — remove restarted agents from warnings
    for (const row of rows) {
      if (this.lastSeenSession.get(row.agent_id) !== row.session_id) {
        this.currentWarnings.delete(row.agent_id);
        this.lastSeenSession.set(row.agent_id, row.session_id);
      }
    }

    // Rebuild currentWarnings from current query results
    const crossingIds = new Set(rows.map((r) => r.agent_id));
    for (const id of this.currentWarnings) {
      if (!crossingIds.has(id)) this.currentWarnings.delete(id);
    }
    for (const id of crossingIds) {
      this.currentWarnings.add(id);
    }
  }
}
