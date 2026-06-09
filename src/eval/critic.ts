import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { TrajectoryCase } from './extract.js';
import type { AgentTrajectory } from './schema-v2.js';
import { buildPatchFrontmatter, roleToTemplateFile } from './patch.js';

function summarizeAgent(key: string, agent: AgentTrajectory): string {
  const toolSummary = Object.entries(agent.tools)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 5)
    .map(([t, s]) => `${t}: ${s.calls} calls${s.errors > 0 ? ` (${s.errors} errors)` : ''}`)
    .join(', ');
  return `  ${key} (${agent.agent_id}): active_duration=${Math.round(agent.active_duration_ms / 1000)}s, messages_in=${agent.messages_in}, messages_out=${agent.messages_out}, tools=[${toolSummary}]`;
}

export async function runCritic(
  caseFile: string,
  rulesFile: string,
  outDir: string
): Promise<string> {
  const traj: TrajectoryCase & any = JSON.parse(readFileSync(caseFile, 'utf8'));
  const rules = readFileSync(rulesFile, 'utf8');
  const task = traj.task as any;

  // Determine primary failing agent and failure details from v2 EvalResult-compatible fields.
  // The case file has v2 fields (agents, blocked_events, soft_signals) if extracted post-6888b92.
  const agents: Record<string, AgentTrajectory> = traj.agents ?? {};
  const softSignals: Record<string, any> = traj.soft_signals ?? {};
  const blockedEvents: any[] = traj.blocked_events ?? [];

  // Build agent summaries
  const agentSummaries = Object.entries(agents).map(([k, a]) => summarizeAgent(k, a as AgentTrajectory)).join('\n') || '  (no per-agent data — v1 case)';

  // Last 5 messages (from raw for context)
  const recentMessages = (traj.messages ?? traj.raw?.messages ?? [])
    .slice(-5)
    .map((m: any) => `  [${m.from_id} → ${m.to_id}] ${String(m.content).slice(0, 200)}`)
    .join('\n') || '  (no messages)';

  // Failure summary from metrics (v1 fallback) or agents
  const metrics = traj.raw?.metrics ?? traj.metrics;
  const failureBullets = [
    metrics.traceability_score > 1 && `traceability: score=${metrics.traceability_score}/3 (missing ${['source_msg_id','trigger_msg_id','result_msg_id'].filter(f => !task[f]).join(', ')})`,
    !metrics.has_commit && `has_commit: false (no commit recorded for this task)`,
  ].filter(Boolean).join('\n- ');

  // Per-agent failures from agents map if available
  const agentFailures = Object.entries(agents).map(([key, agent]) => {
    const a = agent as AgentTrajectory;
    const lines: string[] = [];
    const totalCalls = Object.values(a.tools).reduce((s, t) => s + t.calls, 0);
    lines.push(`  ${key}: tool_calls=${totalCalls}, active_duration=${Math.round(a.active_duration_ms / 1000)}s`);
    return lines.join('\n');
  }).join('\n') || '  (no per-agent breakdown)';

  // Determine target role: the role with the most tool activity or the task-level role
  const primaryRole = Object.values(agents).sort((a: any, b: any) => (b as AgentTrajectory).active_duration_ms - (a as AgentTrajectory).active_duration_ms)[0]?.role
    ?? (task.agent_id?.endsWith(':0') ? 'orchestrator' : null);

  const targetFile = roleToTemplateFile(primaryRole);
  const isWorkerPatch = primaryRole && primaryRole !== 'orchestrator';

  const softSignalList = Object.entries(softSignals)
    .filter(([, v]) => Array.isArray(v) ? v.length > 0 : v > 0)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ') || 'none';

  const prompt = `You are a critic reviewing a failed AI agent trajectory in the Synapse multi-agent system.

## Failed Trajectory

Task #${traj.id}: "${task.title}"
Status: ${task.status}
Primary agent: ${task.agent_id}${primaryRole ? ` (role: ${primaryRole})` : ''}
Wall-clock: ${Math.round((traj.total_duration_ms ?? traj.metrics?.duration_ms ?? 0) / 1000)}s

## Failures
- ${failureBullets || 'see per-agent data below'}

## Per-agent breakdown
${agentFailures}

## Agent activity
${agentSummaries}

## Soft signals
${softSignalList}

## Blocked events
${blockedEvents.map((e: any) => `  [${e.category}] ${e.text}`).join('\n') || '  none'}

## Last 5 messages
${recentMessages}

## Current ${isWorkerPatch ? 'worker' : 'orchestrator'} rules (${targetFile})
${rules.slice(0, 2000)}

## Your task

Identify the most likely reason this trajectory failed.

Then propose a SPECIFIC 1-2 sentence addition to \`${targetFile}\` that would prevent this failure.
Target role: **${primaryRole ?? 'cross-role'}**

Output format:
1. **Root cause** (2-3 sentences max)
2. **Proposed rule change** (exact text to add to ${targetFile}, formatted as a clearly marked addition)
3. **Expected impact** (which metric improves)

Rules:
- Be concrete. No "be more careful" rules.
- The patch must reference a specific observable behavior, not intentions.
- If the failure is task-level traceability (not per-agent), target the orchestrator rules.`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const patchBody = (response.content[0] as any).text as string;

  const meta = {
    target_file: targetFile,
    target_role: primaryRole ?? null,
    failure_metric: metrics.traceability_score > 1 ? 'traceability_score'
      : !metrics.has_commit ? 'has_commit'
      : Object.values(agents).length > 0 ? 'tool_calls'
      : 'unknown',
  };

  const fullPatch = `${buildPatchFrontmatter(meta)}# Critic patch for Task #${traj.id}\n\n${patchBody}\n`;

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `task_${traj.id}_patch.md`);
  writeFileSync(outFile, fullPatch);
  return fullPatch;
}
