/**
 * Window report: aggregate eval metrics across a time range.
 * Produces a structured markdown report across all completed tasks in the window.
 *
 * Usage:
 *   import { generateWindowReport } from './window.js';
 *   const markdown = generateWindowReport(dbPath, { since: '7d' });
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

// ── Duration parser ───────────────────────────────────────────────────────────

export function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i);
  if (!m) throw new Error(`Cannot parse duration: "${s}". Use formats like 7d, 24h, 30m, 2w.`);
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'ms': return n;
    case 's':  return n * 1_000;
    case 'm':  return n * 60_000;
    case 'h':  return n * 3_600_000;
    case 'd':  return n * 86_400_000;
    case 'w':  return n * 7 * 86_400_000;
    default:   throw new Error(`Unknown unit: ${m[2]}`);
  }
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface WindowReportOptions {
  since?: string;       // e.g. "7d", "24h"
  from?: number;        // epoch ms
  to?: number;          // epoch ms (default: now)
  role?: string;        // filter to one role
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)] ?? sorted[sorted.length - 1];
}

function median(arr: number[]): number { return pctile(arr, 0.5); }

function fmtDuration(ms: number): string {
  if (ms < 60_000)  return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtMs(ms: number): string { return `${Math.round(ms)}ms`; }

// ── Main ──────────────────────────────────────────────────────────────────────

export function generateWindowReport(dbPath: string, opts: WindowReportOptions): string {
  const db = new Database(dbPath, { readonly: true });

  const now = Date.now();
  let fromMs: number;
  let toMs: number = opts.to ?? now;
  let rangeLabel: string;

  if (opts.from !== undefined) {
    fromMs = opts.from;
    rangeLabel = `${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`;
  } else {
    const dur = parseDuration(opts.since ?? '7d');
    fromMs = toMs - dur;
    rangeLabel = `last ${opts.since ?? '7d'}`;
  }

  // ── Fetch all completed tasks in window ────────────────────────────────────

  type TaskRow = {
    id: number; agent_id: string; title: string; status: string;
    started_at: number; finished_at: number | null; commit_sha: string | null; role: string | null;
  };

  let taskQuery = `
    SELECT t.id, t.agent_id, t.title, t.status,
           t.started_at, t.finished_at, t.commit_sha,
           a.role
    FROM tasks t
    LEFT JOIN agent_status a ON a.agent_id = t.agent_id
    WHERE t.finished_at >= ? AND t.finished_at <= ?
  `;
  const taskParams: any[] = [fromMs, toMs];

  if (opts.role) {
    taskQuery += ` AND a.role = ?`;
    taskParams.push(opts.role);
  }
  taskQuery += ` ORDER BY t.finished_at ASC`;

  const tasks = db.prepare(taskQuery).all(...taskParams) as TaskRow[];

  if (tasks.length === 0) {
    db.close();
    return `# Window report: ${rangeLabel}\n\nNo completed tasks found in this window.`;
  }

  const taskIds = tasks.map(t => t.id);
  const placeholders = taskIds.map(() => '?').join(',');

  // ── Tool metrics (FK preferred, time-window fallback baked into data) ───────
  // We pull all tool_metrics rows associated with these tasks.
  // For FK-attributed rows (task_id IS NOT NULL), match directly.
  // We also pull time-window rows for tasks where FK gives 0 rows.

  // First, get FK-attributed rows
  const fkMetrics = taskIds.length > 0
    ? (db.prepare(`
        SELECT tm.*, a.role
        FROM tool_metrics tm
        LEFT JOIN agent_status a ON a.agent_id = tm.synapse_agent_id
        WHERE tm.task_id IN (${placeholders})
      `).all(...taskIds) as any[])
    : [];

  const fkTaskIds = new Set(fkMetrics.map(m => m.task_id as number));

  // Time-window fallback for tasks with no FK rows
  const twTaskIds = taskIds.filter(id => !fkTaskIds.has(id));
  const twMetrics: any[] = [];
  for (const task of tasks.filter(t => twTaskIds.includes(t.id))) {
    const rows = db.prepare(`
      SELECT tm.*, a.role
      FROM tool_metrics tm
      LEFT JOIN agent_status a ON a.agent_id = tm.synapse_agent_id
      WHERE tm.synapse_agent_id = ?
        AND tm.timestamp >= ?
        AND tm.timestamp <= COALESCE(?, 9999999999999)
    `).all(task.agent_id, task.started_at, task.finished_at) as any[];
    twMetrics.push(...rows.map(r => ({ ...r, _task_id_inferred: task.id })));
  }

  // Merge: FK rows have task_id, tw rows have _task_id_inferred
  const allMetrics = [
    ...fkMetrics.map(m => ({ ...m, resolved_task_id: m.task_id as number })),
    ...twMetrics.map(m => ({ ...m, resolved_task_id: m._task_id_inferred as number })),
  ];

  db.close();

  // ── Build per-task summary ─────────────────────────────────────────────────

  const metricsByTask = new Map<number, any[]>();
  for (const m of allMetrics) {
    if (!metricsByTask.has(m.resolved_task_id)) metricsByTask.set(m.resolved_task_id, []);
    metricsByTask.get(m.resolved_task_id)!.push(m);
  }

  // ── Summary section ────────────────────────────────────────────────────────

  const completed = tasks.filter(t => t.status === 'completed');
  const aborted   = tasks.filter(t => t.status === 'aborted');
  const commits   = tasks.filter(t => t.commit_sha).length;
  const totalWallMs = tasks.reduce((s, t) =>
    s + (t.finished_at && t.started_at ? t.finished_at - t.started_at : 0), 0);

  const roleCounts: Record<string, number> = {};
  for (const t of tasks) {
    const r = t.role ?? 'unknown';
    roleCounts[r] = (roleCounts[r] ?? 0) + 1;
  }
  const roleCountStr = Object.entries(roleCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}: ${n}`)
    .join(', ');

  // ── Per-role aggregates ────────────────────────────────────────────────────

  const byRole: Record<string, {
    tasks: TaskRow[];
    toolCallsList: number[];
    wallClockList: number[];
    errorRateList: number[];
    commitCount: number;
  }> = {};

  for (const task of tasks) {
    const role = task.role ?? 'unknown';
    if (!byRole[role]) byRole[role] = { tasks: [], toolCallsList: [], wallClockList: [], errorRateList: [], commitCount: 0 };
    const entry = byRole[role];
    entry.tasks.push(task);

    const metrics = metricsByTask.get(task.id) ?? [];
    const toolCalls = metrics.length;
    const errors = metrics.filter(m => m.status === 'error').length;
    entry.toolCallsList.push(toolCalls);
    const wc = task.finished_at && task.started_at ? task.finished_at - task.started_at : 0;
    entry.wallClockList.push(wc);
    if (toolCalls > 0) entry.errorRateList.push(errors / toolCalls);
    if (task.commit_sha) entry.commitCount++;
  }

  const perRoleRows = Object.entries(byRole)
    .sort((a, b) => b[1].tasks.length - a[1].tasks.length)
    .map(([role, e]) => {
      const avgErrRate = e.errorRateList.length > 0
        ? e.errorRateList.reduce((s, v) => s + v, 0) / e.errorRateList.length
        : 0;
      const commitPct = Math.round((e.commitCount / e.tasks.length) * 100);
      return `| ${role} | ${e.tasks.length} | ${median(e.toolCallsList)} | ${pctile(e.toolCallsList, 0.9)} | ${fmtDuration(median(e.wallClockList))} | ${fmtDuration(pctile(e.wallClockList, 0.9))} | ${(avgErrRate * 100).toFixed(1)}% | ${commitPct}% |`;
    }).join('\n');

  // ── Tool usage ─────────────────────────────────────────────────────────────

  const toolAgg: Record<string, { calls: number; agents: Set<string>; durations: number[]; errors: number }> = {};
  for (const m of allMetrics) {
    const tool: string = m.tool ?? 'unknown';
    if (!toolAgg[tool]) toolAgg[tool] = { calls: 0, agents: new Set(), durations: [], errors: 0 };
    const t = toolAgg[tool];
    t.calls++;
    t.agents.add(m.synapse_agent_id);
    if (m.duration_ms != null) t.durations.push(m.duration_ms);
    if (m.status === 'error') t.errors++;
  }

  const topTools = Object.entries(toolAgg)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 10)
    .map(([tool, t]) => {
      const avgMs = t.durations.length > 0
        ? Math.round(t.durations.reduce((s, v) => s + v, 0) / t.durations.length)
        : 0;
      const errRate = t.calls > 0 ? ((t.errors / t.calls) * 100).toFixed(1) : '0.0';
      return `| ${tool} | ${t.calls} | ${t.agents.size} | ${fmtMs(avgMs)} | ${errRate}% | |`;
    }).join('\n');

  // ── Threshold breaches ─────────────────────────────────────────────────────

  const thresholdsPath = join(dirname(fileURLToPath(import.meta.url)), 'thresholds.json');
  let thresholdsJson: any = null;
  if (existsSync(thresholdsPath)) {
    try { thresholdsJson = JSON.parse(readFileSync(thresholdsPath, 'utf8')); } catch { /* ignore */ }
  }

  const breachRows: string[] = [];
  if (thresholdsJson?.by_role) {
    for (const [role, entry] of Object.entries(byRole)) {
      const t: any = thresholdsJson.by_role[role] ?? thresholdsJson.by_role['_default'];
      if (!t) continue;
      const checkMetric = (metric: string, values: number[], threshold: number, ids: number[]) => {
        const breaches = values.map((v, i) => ({ v, id: ids[i] })).filter(x => x.v > threshold);
        if (breaches.length > 0) {
          const exampleIds = breaches.slice(0, 3).map(x => `#${x.id}`).join(', ');
          breachRows.push(`| ${role} | ${metric} | ${breaches.length} | ${exampleIds} |`);
        }
      };
      const taskIdsByRole = entry.tasks.map(t => t.id);
      if (t.tool_calls_p90) checkMetric('tool_calls', entry.toolCallsList, t.tool_calls_p90, taskIdsByRole);
      if (t.wall_clock_ms_p90) checkMetric('wall_clock_ms', entry.wallClockList, t.wall_clock_ms_p90, taskIdsByRole);
    }
  }
  const thresholdSection = breachRows.length > 0
    ? `| role | metric | breaches | example task ids |\n|---|---|---|---|\n${breachRows.join('\n')}`
    : '_No threshold breaches detected._';

  // ── Blocked events (from case files if available) ─────────────────────────
  // Load from case JSON files (they carry blocked_events arrays from the v2 extractor)
  // Window reports use the raw corpus (.synapse/cases/) for recency; fall back to tests/cases/

  const casesDir = existsSync(join(process.cwd(), '.synapse', 'cases'))
    ? join(process.cwd(), '.synapse', 'cases')
    : join(process.cwd(), 'tests', 'cases');
  const blockedCounts: Record<'CONFUSED' | 'ERROR' | 'WAITING' | 'OTHER', string[]> = {
    CONFUSED: [], ERROR: [], WAITING: [], OTHER: [],
  };
  for (const task of tasks) {
    const caseFile = join(casesDir, `task_${task.id}_good.json`);
    const altFile  = join(casesDir, `task_${task.id}_bad.json`);
    const file = existsSync(caseFile) ? caseFile : existsSync(altFile) ? altFile : null;
    if (!file) continue;
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      for (const ev of (c.blocked_events ?? [])) {
        const cat = ev.category as 'CONFUSED' | 'ERROR' | 'WAITING' | 'OTHER';
        if (blockedCounts[cat]) blockedCounts[cat].push(ev.text ?? '');
      }
    } catch { /* skip */ }
  }
  const confusedSnippets = blockedCounts.CONFUSED.slice(0, 5).map(t => `  - "${t.slice(0, 120)}"`).join('\n');
  const errorSnippets    = blockedCounts.ERROR.slice(0, 5).map(t => `  - "${t.slice(0, 120)}"`).join('\n');

  // ── Idle drift ─────────────────────────────────────────────────────────────

  const driftRows: { taskId: number; role: string; ratio: number; wallMs: number; activeMs: number }[] = [];
  for (const task of tasks) {
    const wallMs = task.finished_at && task.started_at ? task.finished_at - task.started_at : 0;
    if (wallMs === 0) continue;
    const metrics = metricsByTask.get(task.id) ?? [];
    const activeMs = metrics.reduce((s, m) => s + (m.duration_ms ?? 0), 0);
    const ratio = wallMs / Math.max(activeMs, 1);
    if (ratio > 10) {
      driftRows.push({ taskId: task.id, role: task.role ?? 'unknown', ratio, wallMs, activeMs });
    }
  }
  driftRows.sort((a, b) => b.ratio - a.ratio);
  const driftTable = driftRows.slice(0, 10)
    .map(r => `| ${r.taskId} | ${r.role} | ${r.ratio.toFixed(0)}× | ${fmtDuration(r.wallMs)} | ${fmtDuration(r.activeMs)} |`)
    .join('\n');

  // ── Recurring patterns ─────────────────────────────────────────────────────

  const patterns: string[] = [];

  // Bash errors: group by agent and error-ish text
  const bashErrors = allMetrics.filter(m => m.tool === 'Bash' && m.status === 'error');
  if (bashErrors.length >= 3) {
    patterns.push(`- Bash errors: ${bashErrors.length} total across ${new Set(bashErrors.map(m => m.synapse_agent_id)).size} agent(s)`);
  }

  // Repeated title words
  const words: Record<string, number> = {};
  for (const t of tasks) {
    for (const w of (t.title ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 4)) {
      words[w] = (words[w] ?? 0) + 1;
    }
  }
  const commonWords = Object.entries(words).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (commonWords.length > 0) {
    patterns.push(`- Frequent task title keyword(s): ${commonWords.map(([w, n]) => `"${w}" (${n}×)`).join(', ')}`);
  }

  const recurringSection = patterns.length > 0
    ? patterns.join('\n')
    : '_No recurring patterns detected._';

  // ── Assemble report ────────────────────────────────────────────────────────

  const report = `# Window report: ${rangeLabel}

_Generated at ${new Date().toISOString()}_

## Summary

- Tasks completed: ${completed.length}
- Tasks aborted: ${aborted.length}
- Total commits: ${commits}
- Wall-clock work time: ${fmtDuration(totalWallMs)}
- By role: ${roleCountStr}

## Per-role aggregates

| role | tasks | median tool_calls | p90 tool_calls | median wall_clock | p90 wall_clock | error_rate (avg) | has_commit % |
|---|---|---|---|---|---|---|---|
${perRoleRows}

## Tool usage

Top 10 tools by call volume:

| tool | calls | unique agents | avg ms | error_rate | top error pattern |
|---|---|---|---|---|---|
${topTools || '_No tool calls recorded._'}

## Threshold breaches

${thresholdSection}

## Blocked events

- Total CONFUSED: ${blockedCounts.CONFUSED.length}${blockedCounts.CONFUSED.length > 0 ? '\n' + confusedSnippets : ''}
- Total ERROR: ${blockedCounts.ERROR.length}${blockedCounts.ERROR.length > 0 ? '\n' + errorSnippets : ''}
- Total WAITING: ${blockedCounts.WAITING.length}
- Total OTHER: ${blockedCounts.OTHER.length}

## Idle drift

Tasks where wall_clock / sum_active > 10×:

${driftRows.length > 0
  ? `| task_id | role | ratio | wall_clock | active |\n|---|---|---|---|---|\n${driftTable}`
  : '_No idle-drift cases detected._'}

## Recurring patterns

${recurringSection}
`;

  return report.trimEnd() + '\n';
}
