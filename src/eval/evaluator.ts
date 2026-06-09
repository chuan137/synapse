import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { TrajectoryCase } from './extract.js';
import type { AgentTrajectory, ThresholdsFile, TrajectoryV2 } from './schema-v2.js';

export interface AgentFailure {
  agent_id: string;
  role: string;
  metric: string;
  value: number | boolean | null;
  threshold: number | boolean;
}

export interface EvalResult {
  id: number;
  label: 'good' | 'bad';
  title: string;
  pass: boolean;
  failures: AgentFailure[];
  soft_failures: string[];
  role: string | null;     // primary agent role
  metrics: TrajectoryCase['metrics'];
}

const THRESHOLDS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'thresholds.json');

const FALLBACK_THRESHOLDS: ThresholdsFile = {
  calibrated_at: 'hardcoded-defaults',
  sample_size: {},
  by_role: {
    orchestrator:    { tool_calls_p90: 30,  duration_ms_p90: 600_000, error_rate_max: 0.1 },
    developer:       { tool_calls_p90: 80,  duration_ms_p90: 600_000, error_rate_max: 0.1, has_commit: true },
    'code-reviewer': { tool_calls_p90: 50,  duration_ms_p90: 300_000, error_rate_max: 0.1 },
    'doc-writer':    { tool_calls_p90: 30,  duration_ms_p90: 300_000, error_rate_max: 0.1, has_commit: true },
    'test-runner':   { tool_calls_p90: 40,  duration_ms_p90: 600_000, error_rate_max: 0.1 },
    _default:        { tool_calls_p90: 80,  duration_ms_p90: 600_000, error_rate_max: 0.1 },
  },
  task_level: { traceability_score_max: 1 },
};

function loadThresholds(): ThresholdsFile {
  // Prefer src/eval/thresholds.json (canonical location for calibrated thresholds)
  const candidates = [THRESHOLDS_PATH];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        // Validate it's a v2 thresholds file (has by_role, not roles)
        if (parsed.by_role) return parsed as ThresholdsFile;
      } catch { /* fall through */ }
    }
  }
  return FALLBACK_THRESHOLDS;
}

function getThresholds(role: string, file: ThresholdsFile) {
  return file.by_role[role] ?? file.by_role['_default'] ?? FALLBACK_THRESHOLDS.by_role['_default'];
}

function softSignals(agents: Record<string, AgentTrajectory> | undefined, totalDurationMs: number | null): string[] {
  if (!agents) return [];
  const signals: string[] = [];

  for (const [key, agent] of Object.entries(agents)) {
    for (const [tool, stats] of Object.entries(agent.tools)) {
      if (stats.error_rate > 0.1) {
        signals.push(`error_rate_per_tool[${key}:${tool}]=${(stats.error_rate * 100).toFixed(0)}%`);
      }
    }

    // redundant reads: tool stats don't carry file paths, so flag by call count
    const reads = agent.tools['Read'];
    if (reads && reads.calls > 3) {
      signals.push(`redundant_reads[${key}]=${reads.calls}`);
    }

    const confused = agent.blocked_events.filter(e => e.category === 'CONFUSED').length;
    if (confused > 0) signals.push(`confused_count[${key}]=${confused}`);

    if (agent.role === 'orchestrator') {
      const hasDelegation = 'mcp__synapse-bus__delegate_task' in agent.tools || 'mcp__synapse-bus__spawn_agent' in agent.tools;
      if (!hasDelegation && agent.messages_out > 0) {
        signals.push(`over_delegation[${key}]: no delegation calls`);
      }
      const codeTools = ['Edit', 'Write'];
      for (const ct of codeTools) {
        if (agent.tools[ct]?.calls > 0) {
          signals.push(`under_delegation[${key}]: used ${ct} ${agent.tools[ct].calls}x on src/`);
        }
      }
    }
  }

  // Task-level: wall-clock vs active-tool ratio (idle_drift)
  // Flags workers stuck idle — long wall-clock but very little tool activity.
  if (totalDurationMs !== null && totalDurationMs > 0) {
    const totalActive = Object.values(agents).reduce((sum, a) => sum + a.active_duration_ms, 0);
    const ratio = totalDurationMs / Math.max(totalActive, 1);
    if (ratio > 10) {
      signals.push(`idle_drift: wall_clock=${Math.round(totalDurationMs / 1000)}s active=${Math.round(totalActive / 1000)}s ratio=${ratio.toFixed(1)}`);
    }
  }

  return signals;
}

export function evaluateCases(casesDir: string): EvalResult[] {
  const thresholds = loadThresholds();
  const files = readdirSync(casesDir).filter(f => f.endsWith('.json'));

  return files.map(f => {
    const c: TrajectoryCase & Partial<TrajectoryV2> = JSON.parse(readFileSync(join(casesDir, f), 'utf8'));
    const metrics = c.metrics;
    const failures: AgentFailure[] = [];

    // Task-level check
    if (metrics.traceability_score > thresholds.task_level.traceability_score_max) {
      failures.push({
        agent_id: (c.task as any).agent_id ?? '',
        role: 'task',
        metric: 'traceability_score',
        value: metrics.traceability_score,
        threshold: thresholds.task_level.traceability_score_max,
      });
    }

    // Per-agent checks (v2 path)
    if (c.agents) {
      for (const [key, agent] of Object.entries(c.agents)) {
        const t = getThresholds(agent.role, thresholds);
        const totalCalls = Object.values(agent.tools).reduce((s, ts) => s + ts.calls, 0);

        if (t.tool_calls_p90 !== undefined && totalCalls > t.tool_calls_p90) {
          failures.push({ agent_id: agent.agent_id, role: agent.role, metric: 'tool_calls', value: totalCalls, threshold: t.tool_calls_p90 });
        }
        if (t.duration_ms_p90 !== undefined && agent.active_duration_ms > t.duration_ms_p90) {
          failures.push({ agent_id: agent.agent_id, role: agent.role, metric: 'active_duration_ms', value: agent.active_duration_ms, threshold: t.duration_ms_p90 });
        }
        if (t.has_commit === true && !metrics.has_commit) {
          failures.push({ agent_id: agent.agent_id, role: agent.role, metric: 'has_commit', value: false, threshold: true });
        }
      }
    } else {
      // v1 fallback: apply _default thresholds to overall metrics
      const t = getThresholds('_default', thresholds);
      const agentId = (c.task as any).agent_id ?? '';
      if (t.tool_calls_p90 !== undefined && metrics.tool_calls > t.tool_calls_p90) {
        failures.push({ agent_id: agentId, role: 'unknown', metric: 'tool_calls', value: metrics.tool_calls, threshold: t.tool_calls_p90 });
      }
      if (t.duration_ms_p90 !== undefined && (metrics.duration_ms ?? 0) > t.duration_ms_p90) {
        failures.push({ agent_id: agentId, role: 'unknown', metric: 'duration_ms', value: metrics.duration_ms, threshold: t.duration_ms_p90 });
      }
      if (t.has_commit === true && !metrics.has_commit) {
        failures.push({ agent_id: agentId, role: 'unknown', metric: 'has_commit', value: false, threshold: true });
      }
    }

    // Primary role from task's agent
    let primaryRole: string | null = null;
    if (c.agents) {
      const primaryId = (c.task as any).agent_id;
      const entry = primaryId ? Object.values(c.agents).find(a => a.agent_id === primaryId) : null;
      primaryRole = entry?.role ?? Object.values(c.agents)[0]?.role ?? null;
    }

    const pass = failures.length === 0;

    return {
      id: c.id,
      label: (pass ? 'good' : 'bad') as 'good' | 'bad',
      title: (c.task as any).title ?? '',
      pass,
      failures,
      soft_failures: softSignals(c.agents, (c as any).total_duration_ms ?? null),
      role: primaryRole,
      metrics,
    };
  }).sort((a, b) => a.id - b.id);
}
