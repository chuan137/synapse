/**
 * Synapse Guard Hook (PreToolUse) — `synapse hook guard` — DESIGN.md §3.4
 *
 * The enforcement counterpart to the voluntary `request_approval` MCP tool.
 * Intercepts guarded tool calls BEFORE they run and routes them to the human
 * operator on S-Deck. The agent's turn blocks (block-and-poll) until the
 * operator approves/rejects on the dashboard, or it times out.
 *
 *   approved  → permissionDecision: "allow"  (tool proceeds)
 *   rejected  → permissionDecision: "deny"   (with operator's comment)
 *   timeout   → permissionDecision: "deny"   (fail-safe)
 *
 * Workers-only: slot :0 (the agent the operator drives) defers to the normal
 * permission flow, so the operator's own turn is never frozen.
 */

import { resolveSessionToAgent, createApprovalRequest, pollApproval, sendMessage } from '../db.js';

const POLL_MS    = 3000;
const TIMEOUT_MS = 10 * 60 * 1000; // mirror request_approval's 10-minute deadline

// Destructive / outward-facing Bash patterns (DESIGN §3.4).
const BASH_GUARDS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, // rm -rf / -fr (any flag order)
  /\bgit\s+push\b/i,
  /--force\b|\s-f\b.*\bpush|\bpush\b.*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(dropdb|drop\s+database|drop\s+table|truncate\s+table)\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bnpm\s+publish\b|\byarn\s+publish\b|\bnpm\s+unpublish\b/i,
  /\bdocker\s+(push|system\s+prune)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bchmod\s+-R\b|\bchown\s+-R\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
];

// Sensitive paths for Write/Edit/MultiEdit/NotebookEdit.
const PATH_GUARDS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)(id_rsa|id_ed25519|\.pem|\.key)$/i,
  /\/etc\//i,
  /(^|\/)package\.json$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.claude\/settings/i, // don't let an agent rewrite its own hooks unprompted
];

export async function runGuardHook(): Promise<void> {
  const raw = await readStdin();
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return allow(); }
  try { await guard(payload); } catch { allow(); } // never hard-fail the agent on guard error
}

async function guard(payload: any): Promise<void> {
  const tool      = payload.tool_name ?? '';
  const input     = payload.tool_input ?? {};
  const sessionId = payload.session_id ?? null;

  const reason = guardReason(tool, input);
  if (!reason) return allow();

  // Only guard known Synapse swarm agents; unknown sessions fall through to the
  // normal permission flow (defer).
  const agent = sessionId ? resolveSessionToAgent(sessionId) : null;
  if (!agent) return defer();

  // Workers-only: never freeze the operator's own agent.
  if (agent.slot === 0) return defer();
  const agentId = agent.agentId;

  const question = `[Guard] ${agentId} wants to run a guarded ${tool}: ${reason}`;
  const context  = summarize(tool, input);
  const id = createApprovalRequest(agentId, question, context);
  sendMessage(agentId, 'human', `[Guard — approval needed] ${question}\n\n${context}`, 0);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const req = pollApproval(id);
    if (req && req.status !== 'pending') {
      if (req.status === 'approved') {
        return allow(req.comment ? `Approved by operator: ${req.comment}` : 'Approved by operator');
      }
      return deny(req.comment ? `Rejected by operator: ${req.comment}` : 'Rejected by operator');
    }
  }
  return deny('No operator response within 10 minutes — blocked by Synapse guard (fail-safe).');
}

function guardReason(tool: string, input: any): string | null {
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    const hit = BASH_GUARDS.find((re) => re.test(cmd));
    return hit ? `matched ${hit}` : null;
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const path = String(input.file_path ?? input.notebook_path ?? '');
    const hit = PATH_GUARDS.find((re) => re.test(path));
    return hit ? `sensitive path ${path}` : null;
  }
  return null;
}

function summarize(tool: string, input: any): string {
  if (tool === 'Bash') return `$ ${String(input.command ?? '').slice(0, 400)}`;
  const path = input.file_path ?? input.notebook_path ?? '?';
  return `${tool} → ${path}`;
}

// ── PreToolUse decision emitters ─────────────────────────────────────────────

function emit(decision: 'allow' | 'deny', reason?: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  }));
  process.exit(0);
}
const allow = (reason?: string) => emit('allow', reason);
const deny  = (reason?: string) => emit('deny', reason);
const defer = () => process.exit(0); // no JSON → default permission flow

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
  });
}
