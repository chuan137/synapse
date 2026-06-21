/**
 * Shared action bodies for the Synapse operations that used to be dedicated MCP
 * tools (start_task, finish_task, delegate_task, spawn_agent, list_workers,
 * log_decision, request_approval, get_history, report_done).
 *
 * They moved out of mcp-server.ts and into `synapse <subcommand>` CLI calls
 * (invoked via the agent's own Bash tool) to shrink the per-turn MCP tool-schema
 * cost every agent pays on every API call — see templates/SYNAPSE.md §1 for the
 * rationale. Only read_messages / send_message / update_status remain as actual
 * MCP tools, since those are called every single turn and benefit most from a
 * structured, low-latency, in-process call.
 *
 * This module holds the actual logic, parameterized by callerAgentId instead of
 * reading the module-level AGENT_ID that mcp-server.ts derives from claimAgentSlot.
 * Both the CLI (src/index.ts) and, if ever needed again, an MCP handler can call
 * into these functions directly — no duplicated business logic.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';
import {
  sendMessage,
  createApprovalRequest,
  pollApproval,
  getAgentHistory,
  listLiveWorkers,
  reapGhostAgents,
  purgeStaleAgents,
  recordSpawnIntent,
  startTask,
  finishTask,
  logDecision,
  getAgentReady,
  setCurrentTaskId,
  clearCurrentTaskId,
  clearCurrentTaskIdForTask,
  countCompletedTasksForAgent,
  getAgentSessionStart,
  readSynapseSettings,
  DB_PATH,
} from './db.js';
import { spawnWorker } from './spawn.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export interface ActionResult {
  text: string;
  isError?: boolean;
}

const ok = (text: string): ActionResult => ({ text });
const err = (text: string): ActionResult => ({ text, isError: true });

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Resolve "who am I" for a CLI subcommand running inside an agent's own Bash
 * tool call. mcp-server.ts writes `.synapse/agent.env` with this agent's ID on
 * every boot/reconnect — reuse that instead of re-deriving via claimAgentSlot,
 * which would be wrong here (claimAgentSlot is for claiming a NEW session row,
 * not looking up the existing one for the session that's already running).
 */
export function resolveSelfAgentId(cwd: string = process.cwd()): string {
  const envPath = join(cwd, '.synapse', 'agent.env');
  if (!existsSync(envPath)) {
    throw new Error(
      `.synapse/agent.env not found — is the synapse-bus MCP server connected in this session? ` +
      `(it writes that file on connect, and these commands need it to know which agent is calling)`
    );
  }
  const raw = readFileSync(envPath, 'utf8');
  const m = raw.match(/^SYNAPSE_AGENT_ID=(.+)$/m);
  if (!m) throw new Error(`.synapse/agent.env did not contain SYNAPSE_AGENT_ID`);
  return m[1].trim();
}

export function listAvailableRolesText(): string {
  const rolesDir = join(TEMPLATES_DIR, 'roles');
  if (!existsSync(rolesDir)) return 'No roles defined yet.';
  const roles = readdirSync(rolesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(rolesDir, f), 'utf8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const block = match[1];
      const role = (block.match(/^role:\s*(.+)$/m) ?? [])[1]?.trim() ?? f.replace('.md', '');
      const description = (block.match(/^description:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
      return `- ${role}: ${description}`;
    })
    .filter(Boolean)
    .join('\n');
  return roles || 'No roles defined yet.';
}

// ── spawn_agent → `synapse worker spawn` ────────────────────────────────────

export function spawnAgentAction(
  callerAgentId: string,
  opts: { task: string; name?: string; role?: string; slot?: number },
): ActionResult {
  const { task, name: workerName, role: workerRole = 'worker', slot: forcedSlot } = opts;

  const reaped = reapGhostAgents();
  const purged = purgeStaleAgents();
  if (reaped > 0 || purged > 0) {
    process.stderr.write(`[worker spawn] ghost reap: ${reaped} marked ended, ${purged} purged\n`);
  }

  const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');
  const windowName = (workerName ?? workerRole).replace(/[^a-zA-Z0-9_-]/g, '-');

  const taskWithOrch = task + `\nYour orchestrator is ${callerAgentId}.`;
  const worker = spawnWorker({
    role: workerRole,
    name: workerName,
    slot: forcedSlot,
    task: taskWithOrch,
    projectDir: process.cwd(),
    dbPath,
  });

  if (!worker) {
    return ok(`Worker spawned in tmux window "${windowName}" but has not registered yet. Check \`synapse worker list\`.`);
  }

  recordSpawnIntent(worker.agent_id, taskWithOrch, callerAgentId);
  sendMessage(
    callerAgentId,
    worker.agent_id,
    JSON.stringify({ type: 'handshake', orchestrator_id: callerAgentId, worker_id: worker.agent_id }),
    5,
  );

  return ok(
    `Spawned agent ${worker.agent_id} (slot :${worker.slot}, role: ${workerRole}) in tmux window "${windowName}". ` +
    `Send it messages using to_id = "${worker.agent_id}". ` +
    `Worker is not ready until it has read the handshake message — check \`synapse worker list\` before delegating.`
  );
}

// ── list_workers → `synapse worker list` ────────────────────────────────────

export function listWorkersAction(opts: { role?: string; state?: 'idle' | 'working' | 'blocked' | 'error' }): ActionResult {
  const workers = listLiveWorkers(opts);
  if (workers.length === 0) return ok('No live workers match.');

  const fmtAge = (ms: number) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  };

  const rows = workers.map((w) =>
    `:${w.slot}\t${w.agent_id}\t${w.role ?? '-'}\t${w.name || '-'}\t${w.state}\t${w.current_task ?? '-'}\t${fmtAge(w.last_seen_ms_ago)}\t${w.ready_age}`
  );
  const header = 'slot\tagent_id\trole\tname\tstate\tcurrent_task\tlast_seen\tready';
  return ok(`${workers.length} live worker(s):\n\n${header}\n${rows.join('\n')}`);
}

// ── request_approval → `synapse approve` ────────────────────────────────────

export async function requestApprovalAction(
  callerAgentId: string,
  opts: { question: string; context?: string },
): Promise<ActionResult> {
  const { question, context } = opts;
  const id = createApprovalRequest(callerAgentId, question, context ?? null);
  sendMessage(callerAgentId, 'human', `[Approval needed] ${question}${context ? `\n\nContext: ${context}` : ''}`, 0);

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    spawnSync('sleep', ['3']);
    const req = pollApproval(id);
    if (req && req.status !== 'pending') {
      const approved = req.status === 'approved';
      return ok(`${approved ? '✓ Approved' : '✗ Rejected'}${req.comment ? `: ${req.comment}` : ''}`);
    }
  }
  return ok('Approval request timed out after 10 minutes. Treat as rejected.');
}

// ── get_history → `synapse history` ─────────────────────────────────────────

export function getHistoryAction(callerAgentId: string, opts: { limit?: number }): ActionResult {
  const clampedLimit = Math.min(Math.max(1, opts.limit ?? 10), 50);
  const msgs = getAgentHistory(callerAgentId, clampedLimit);
  if (msgs.length === 0) return ok('No message history found.');

  const formatted = msgs
    .map((m) => {
      const ts = new Date(m.created_at).toISOString();
      const direction = m.from_id === callerAgentId ? `→ ${m.to_id}` : `← ${m.from_id}`;
      const label = m.priority === 0 ? '[P0]' : '[P5]';
      const readMark = m.read_at ? '' : ' [unread]';
      return `${label} ${direction} at ${ts}${readMark}\n${m.content}`;
    })
    .join('\n\n---\n\n');

  return ok(`${msgs.length} message(s):\n\n${formatted}`);
}

// ── start_task → `synapse task start` ───────────────────────────────────────

export function startTaskAction(
  callerAgentId: string,
  opts: { title: string; triggerMsgId?: number | null; sourceMsgId?: number | null; agentId?: string },
): ActionResult {
  const taskId = startTask(opts.agentId ?? callerAgentId, opts.title, opts.triggerMsgId ?? null, opts.sourceMsgId ?? null);
  return ok(`Task started (id: ${taskId}).`);
}

// ── finish_task → `synapse task finish` ─────────────────────────────────────

export async function finishTaskAction(opts: {
  taskId: number;
  status: 'completed' | 'aborted';
  resultMsgId?: number | null;
  commitSha?: string;
}): Promise<ActionResult> {
  const { taskId, status, resultMsgId, commitSha } = opts;
  const succeeded = finishTask(taskId, status, resultMsgId ?? null, commitSha ?? null);
  clearCurrentTaskIdForTask(taskId);

  const thisFileDir = dirname(fileURLToPath(import.meta.url));

  if (succeeded && status === 'completed') {
    const indexJs = join(thisFileDir, 'index.js');
    const child = spawn(process.execPath, [indexJs, 'eval', '--task-id', String(taskId)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  } else {
    setImmediate(async () => {
      try {
        const { extractCases } = await import('./eval/extract.js');
        const evalDir = join(dirname(DB_PATH), 'evaluations');
        extractCases(DB_PATH, evalDir, 1, taskId);
      } catch (e: any) {
        process.stderr.write(`[task finish] auto-extract failed for task ${taskId}: ${e?.message ?? e}\n`);
      }
    });
  }

  if (succeeded) {
    const reflectGateJs = join(thisFileDir, 'eval', 'reflect-gate.js');
    const reflectChild = spawn(process.execPath, [reflectGateJs, String(taskId)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    reflectChild.unref();
  }

  return ok(succeeded ? `Task ${taskId} marked ${status}.` : `Task ${taskId} not found or already finished.`);
}

/**
 * Auto-restart check, split out of finish_task's old body so callers can run it
 * for the agent that just finished a task (needs the agentId, which CLI callers
 * already resolve separately from task_id).
 */
export async function maybeAutoRestart(agentId: string, status: 'completed' | 'aborted'): Promise<void> {
  if (status !== 'completed') return;
  const settings = readSynapseSettings();
  const AUTO_RESTART_AFTER_TASKS = typeof settings.autoRestartTasks === 'number' ? settings.autoRestartTasks : 5;
  if (AUTO_RESTART_AFTER_TASKS <= 0) return;
  const sessionStart = getAgentSessionStart(agentId);
  if (!sessionStart) return;
  const completedCount = countCompletedTasksForAgent(agentId, sessionStart);
  if (completedCount < AUTO_RESTART_AFTER_TASKS) return;
  const deckPort = process.env.SYNAPSE_DECK_PORT ?? '3001';
  const http = await import('http');
  const req = http.request(`http://127.0.0.1:${deckPort}/api/agents/${encodeURIComponent(agentId)}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  req.on('error', () => {}); // best-effort
  req.end();
}

// ── log_decision → `synapse decision log` ───────────────────────────────────

export function logDecisionAction(
  callerAgentId: string,
  opts: { kind: string; value: string; why?: string; relatedTaskId?: number; relatedMsgId?: number },
): ActionResult {
  const id = logDecision(callerAgentId, opts.kind, opts.value, opts.why ?? null, opts.relatedTaskId ?? null, opts.relatedMsgId ?? null);
  return ok(`Decision logged (id: ${id}).`);
}

// ── delegate_task → `synapse task delegate` ─────────────────────────────────

export function delegateTaskAction(
  callerAgentId: string,
  opts: { toId: string; title: string; content: string; priority?: number; taskFile?: boolean; taskId?: number },
): ActionResult {
  const { toId, content, priority = 5, taskFile = false, taskId } = opts;

  if (getAgentReady(toId) === null) {
    return err(`Worker ${toId} has not acknowledged yet — check \`synapse worker list\` and retry once it shows ready.`);
  }

  let outboundContent = content;
  if (taskFile) {
    const fileId = taskId ?? Date.now();
    const tasksDir = join(process.cwd(), '.synapse', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, `${fileId}.md`), content, 'utf8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 3).join('\n');
    outboundContent = `Task brief at .synapse/tasks/${fileId}.md\n\n${preview}${lines.length > 3 ? '\n…' : ''}`;
  }

  const messageId = sendMessage(callerAgentId, toId, outboundContent, priority, false, undefined, taskId ?? null);
  if (taskId !== undefined) setCurrentTaskId(toId, taskId);

  return ok(`Delegated to ${toId}: message_id=${messageId}`);
}

// ── report_done → `synapse done` ────────────────────────────────────────────

export function reportDoneAction(
  callerAgentId: string,
  opts: { orchestratorId: string; content: string; milestone?: string; reportFile?: boolean },
): ActionResult {
  const { orchestratorId, content, milestone, reportFile = false } = opts;

  const orchMsgId = sendMessage(callerAgentId, orchestratorId, content, 5);
  clearCurrentTaskId(callerAgentId);

  let humanMsg: string;
  if (reportFile) {
    const reportsDir = join(process.cwd(), '.synapse', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const slug = content.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const filename = `${Date.now()}-${slug}.md`;
    writeFileSync(join(reportsDir, filename), content, 'utf8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 5).join('\n');
    humanMsg = milestone ?? `DONE — ${preview}${lines.length > 5 ? '\n…' : ''}\n\n[Full report: .synapse/reports/${filename}]`;
  } else {
    humanMsg = milestone ?? (content.length > 200
      ? `DONE — ${content.slice(0, 200).split('\n')[0]}`
      : `DONE — ${content.split('\n')[0]}`);
  }
  sendMessage(callerAgentId, 'human', humanMsg, 5);

  return ok(`Reported done. orch_msg=${orchMsgId}`);
}
