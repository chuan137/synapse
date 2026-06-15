import { db, sendMessage, readSynapseSettings } from './db.js';

const COUNTED_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebFetch'];

interface AgentToolRow {
  agent_id: string;
  orchestrator_id: string | null;
  role: string | null;
  tool_call_count: number;
  session_id: string;
}

interface HealthMonitorDeps {
  queryAgents: (threshold: number) => AgentToolRow[];
  sendMessage: typeof sendMessage;
  readSynapseSettings: typeof readSynapseSettings;
}

interface HealthMonitorOptions {
  thresholdToolCalls?: number;
  intervalMs?: number;
  deps?: Partial<HealthMonitorDeps>;
}

const QUERY_SQL = `
  SELECT a.agent_id,
         a.orchestrator_id,
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
  private warnedAgents = new Set<string>();
  private lastSeenSession = new Map<string, string>();

  constructor(opts: HealthMonitorOptions = {}) {
    this.defaultThreshold = opts.thresholdToolCalls ?? 300;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.deps = {
      queryAgents: defaultQueryAgents,
      sendMessage,
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

    for (const row of rows) {
      const { agent_id, orchestrator_id, role, tool_call_count, session_id } = row;

      // Reset de-dupe state if agent was restarted (new session)
      if (this.lastSeenSession.get(agent_id) !== session_id) {
        this.warnedAgents.delete(agent_id);
        this.lastSeenSession.set(agent_id, session_id);
      }

      if (!orchestrator_id) continue;
      if (this.warnedAgents.has(agent_id)) continue;

      const content = `[health] worker ${agent_id} (${role ?? 'unknown'}) has made ${tool_call_count} tool calls this session (threshold: ${threshold}); consider restart`;
      this.deps.sendMessage('system', orchestrator_id, content, 5);
      this.warnedAgents.add(agent_id);
    }
  }
}
