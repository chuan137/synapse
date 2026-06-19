import { readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { db, DB_PATH, sendMessage, getAgentState } from '../db.js';

// ── reflect-gate ────────────────────────────────────────────────────────────
// Per-task execution-reflection trigger.
//
// This is deliberately NOT the `/retro` mechanism. `/retro` is a periodic,
// multi-task, orchestrator-self-review of routing quality (see
// skills/retro/SKILL.md) — operator-invoked, long-cycle, different value.
// `reflect-gate` is the automatic, per-task, execution-focused counterpart:
// it looks at exactly one just-finished task and decides whether something
// about *how the work happened* (not the routing, not the product) is worth
// a structured look via the `/reflect-task` skill.
//
// All three trigger conditions live in this one file/process by design — one
// process, spawned detached from `finish_task` (src/mcp-server.ts), so every
// gate decision happens in the same place instead of being split across the
// dashboard daemon, a cron-ish poller, etc.
//
//   Gate 1 — tool_volume:  this task's tool-call count breached the
//                           calibrated per-role threshold (src/eval/thresholds.json).
//   Gate 2 — file_churn:   the same file was read repeatedly or an edit/write
//                           was retried after a prior error within this task.
//   Gate 3 — idle_drift:   neither of the above fired, and the orchestrator
//                           is *still* idle some minutes after this task
//                           closed — a soft signal nobody picked up the next
//                           thread. The probability of firing is biased upward
//                           by soft signals from gates 1 and 2.
//                           This gate sleeps inside this same process; that's
//                           the whole point of spawning it standalone.
//
// On any trip, sends a single mandatory (P0) bus message to the live
// orchestrator instructing it to run `/reflect-task <task_id>` — mandatory
// per the rule added to templates/SYNAPSE-orchestrator.md, not just a nudge
// it can ignore.

const EVAL_DIR = join(dirname(DB_PATH), 'evaluations');
const THRESHOLDS_PATH = join(dirname(DB_PATH), '..', 'src', 'eval', 'thresholds.json');
const CASE_POLL_INTERVAL_MS = 500;
const CASE_POLL_TIMEOUT_MS = 15_000;
const IDLE_GATE_DELAY_MS = parseInt(process.env.SYNAPSE_REFLECT_IDLE_MS ?? '', 10) || 3 * 60 * 1000;
const REPEAT_READ_THRESHOLD = 3; // same file read >= 3x within the task counts as churn

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function findCaseFile(taskId: number): string | null {
  if (!existsSync(EVAL_DIR)) return null;
  const match = readdirSync(EVAL_DIR).find(f => f.startsWith(`task_${taskId}_`) && f.endsWith('.json'));
  return match ? join(EVAL_DIR, match) : null;
}

/** The case file is written by the eval child spawned alongside this process
 *  (or by the aborted-task extract path) — poll briefly rather than racing it. */
async function waitForCaseFile(taskId: number): Promise<string | null> {
  const deadline = Date.now() + CASE_POLL_TIMEOUT_MS;
  for (;;) {
    const f = findCaseFile(taskId);
    if (f) return f;
    if (Date.now() >= deadline) return null;
    await sleep(CASE_POLL_INTERVAL_MS);
  }
}

export interface GateTrip {
  gate: 'tool_volume' | 'file_churn' | 'idle_drift';
  reason: string;
}

interface ReflectThresholds {
  by_role: Record<string, { tool_calls_p90?: number }>;
}

interface ReflectGateConfig {
  p_base: number;
  p_max: number;
  softFloor: number;
  aggregation: string;
}

function loadReflectThresholds(): ReflectThresholds {
  try {
    return JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as ReflectThresholds;
  } catch {
    return { by_role: { _default: { tool_calls_p90: 80 } } };
  }
}

function loadReflectGateConfig(): ReflectGateConfig {
  try {
    const raw = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8'));
    const cfg = raw?.reflect_gate?.idle_drift;
    if (cfg) return cfg as ReflectGateConfig;
  } catch {
    // fall through to defaults
  }
  return { p_base: 0.1, p_max: 0.6, softFloor: 0.5, aggregation: 'max' };
}

/** Gate 1 — unusual tool-call volume vs. the calibrated per-role threshold. */
export function checkToolVolumeGate(caseFilePath: string): GateTrip | null {
  const raw: any = JSON.parse(readFileSync(caseFilePath, 'utf8'));
  const thresholds = loadReflectThresholds();

  // v2 path: per-agent tool_calls from agents map
  const agents: Record<string, any> = raw?.agents ?? {};
  for (const [, agent] of Object.entries(agents)) {
    const t = thresholds.by_role[agent.role] ?? thresholds.by_role['_default'];
    const totalCalls = Object.values(agent.tools as Record<string, any>)
      .reduce((s: number, ts: any) => s + ts.calls, 0);
    if (t?.tool_calls_p90 !== undefined && totalCalls > t.tool_calls_p90) {
      return {
        gate: 'tool_volume',
        reason: `tool_calls=${totalCalls} exceeds ${agent.role} threshold ${t.tool_calls_p90} (agent ${agent.agent_id})`,
      };
    }
  }

  // v1 fallback: use raw metrics.tool_calls with _default threshold
  const totalCalls = raw?.metrics?.tool_calls;
  if (totalCalls !== undefined) {
    const t = thresholds.by_role['_default'];
    if (t?.tool_calls_p90 !== undefined && totalCalls > t.tool_calls_p90) {
      return {
        gate: 'tool_volume',
        reason: `tool_calls=${totalCalls} exceeds _default threshold ${t.tool_calls_p90}`,
      };
    }
  }

  return null;
}

/** Gate 2 — repeated read/write churn on the same file within the task. */
export function checkFileChurnGate(caseFilePath: string): GateTrip | null {
  const raw: any = JSON.parse(readFileSync(caseFilePath, 'utf8'));
  const anti = raw?.tool_metrics?.summary?.anti_patterns;
  if (!anti) return null;

  const heavyReads = Object.entries(anti.repeat_reads ?? {}) as [string, number][];
  const churned = heavyReads.filter(([, c]) => c >= REPEAT_READ_THRESHOLD);
  const retries = Object.entries(anti.edit_retries ?? {}) as [string, number][];

  if (churned.length === 0 && retries.length === 0) return null;

  const parts: string[] = [];
  if (churned.length > 0) parts.push(`repeat_reads: ${churned.map(([p, c]) => `${p}×${c}`).join(', ')}`);
  if (retries.length > 0) parts.push(`edit_retries: ${retries.map(([p, c]) => `${p}×${c}`).join(', ')}`);

  return { gate: 'file_churn', reason: parts.join('; ') };
}

/** Gate 3 — probabilistic idle-drift, biased by soft signals from gates 1 and 2. */
export async function checkIdleGate(
  caseFile: string,
  orchAgentId: string,
  rng: () => number = Math.random,
  delayMs: number = IDLE_GATE_DELAY_MS,
): Promise<GateTrip | null> {
  const cfg = loadReflectGateConfig();
  const { p_base, p_max, softFloor } = cfg;
  const thresholds = loadReflectThresholds();

  const raw: any = JSON.parse(readFileSync(caseFile, 'utf8'));

  // Gate-1 softness: per-agent tool_calls proximity to threshold
  let soft1 = 0;
  for (const [, agent] of Object.entries(raw?.agents ?? {}) as [string, any][]) {
    const t = thresholds.by_role[agent.role] ?? thresholds.by_role['_default'];
    const calls = Object.values(agent.tools as Record<string, any>)
      .reduce((s: number, ts: any) => s + ts.calls, 0);
    if (t?.tool_calls_p90) {
      const s = clamp((calls / t.tool_calls_p90) - softFloor, 0, 1) / (1 - softFloor);
      soft1 = Math.max(soft1, s);
    }
  }

  // Gate-2 softness: max repeat-read count normalised to hard-trip point
  const anti = raw?.tool_metrics?.summary?.anti_patterns;
  const maxRepeats = Math.max(0, ...Object.values(anti?.repeat_reads ?? {}) as number[]);
  const soft2 = clamp((maxRepeats / REPEAT_READ_THRESHOLD) - softFloor, 0, 1) / (1 - softFloor);

  const f = Math.max(soft1, soft2);
  const p = p_base + (p_max - p_base) * f;
  const rolled = rng();
  const fires = rolled < p;

  console.log(
    `[reflect-gate] idle-drift: soft1=${soft1.toFixed(2)} soft2=${soft2.toFixed(2)} f=${f.toFixed(2)} p=${p.toFixed(2)} rolled=${rolled.toFixed(3)} fires=${fires}`
  );

  if (!fires) return null;

  await sleep(delayMs);
  const state = getAgentState(orchAgentId);
  if (state !== 'idle') return null;

  console.log(`[reflect-gate] idle-drift: orchestrator still idle after ${Math.round(delayMs / 60_000)}min — nudging`);

  return {
    gate: 'idle_drift',
    reason: `probabilistic idle-drift fired (p=${p.toFixed(2)}, f=${f.toFixed(2)}) — orchestrator still idle ${Math.round(delayMs / 60_000)}min after task closed`,
  };
}

function findOrchestrator(): string | null {
  const row = db.prepare<[], { agent_id: string }>(
    `SELECT agent_id FROM agent_status WHERE slot = 0 AND ended_at IS NULL LIMIT 1`
  ).get();
  return row?.agent_id ?? null;
}

function nudgeOrchestrator(taskId: number, orchAgentId: string, trip: GateTrip): void {
  sendMessage(
    'system',
    orchAgentId,
    `[system] mandatory: task ${taskId} tripped reflect-gate (${trip.gate}: ${trip.reason}) — ` +
      `run /reflect-task ${taskId} before starting new work.`,
    0, // P0 — protocol-mandatory, see templates/SYNAPSE-orchestrator.md
  );
}

export async function runReflectGate(taskId: number): Promise<void> {
  const orchAgentId = findOrchestrator();
  if (!orchAgentId) return; // no live orchestrator to nudge

  const caseFile = await waitForCaseFile(taskId);
  if (!caseFile) return; // Fix #2: no case file → skip all gates including idle_drift

  const volumeTrip = checkToolVolumeGate(caseFile);
  if (volumeTrip) { nudgeOrchestrator(taskId, orchAgentId, volumeTrip); return; }

  const churnTrip = checkFileChurnGate(caseFile);
  if (churnTrip) { nudgeOrchestrator(taskId, orchAgentId, churnTrip); return; }

  // Gate 3 — probabilistic idle-drift, biased by soft signals from gates 1 and 2.
  const idleTrip = await checkIdleGate(caseFile, orchAgentId);
  if (idleTrip) nudgeOrchestrator(taskId, orchAgentId, idleTrip);
}

// ── Standalone entrypoint — spawned detached from finish_task ──────────────────
if (process.argv[1]?.endsWith('reflect-gate.js') || process.argv[1]?.endsWith('reflect-gate.ts')) {
  const taskId = parseInt(process.argv[2] ?? '', 10);
  if (Number.isNaN(taskId)) {
    console.error('[reflect-gate] usage: reflect-gate.js <task_id>');
    process.exit(1);
  }
  runReflectGate(taskId)
    .catch(err => console.warn(`[reflect-gate] failed for task ${taskId}:`, err?.message ?? err))
    .finally(() => process.exit(0));
}
