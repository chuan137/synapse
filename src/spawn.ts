import { writeFileSync, chmodSync, realpathSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { execSync, execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { getLatestAgent, getAgentBySlot, setAgentRole, setAgentName, setAgentReady } from './db.js';

/** Derive a stable, human-readable tmux session name for this project.
 * Format: synapse-<basename>-<8 hex chars of SHA-256(realpath)>
 * Stable across restarts; unique across projects with the same basename. */
export function projectTmuxSession(projectDir: string): string {
  const real = realpathSync(projectDir);
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8);
  const slug = basename(real).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20);
  return `synapse-${slug}-${hash}`;
}

export interface SpawnWorkerOptions {
  role: string;
  name?: string;
  slot?: number;       // force a specific slot; omit to let claimAgentSlot pick
  task: string;
  projectDir: string;
  dbPath: string;
}

export interface SpawnedWorker {
  agent_id: string;
  slot: number;
}

/**
 * Launch a new worker in a fresh tmux window. Writes a temp launcher script,
 * runs `synapse run --role ... --task-file ...` inside it, then polls until
 * the worker claims its slot (max 60 s). Returns the registered agent, or
 * null if registration times out.
 */
export function spawnWorker(opts: SpawnWorkerOptions): SpawnedWorker | null {
  const { role, name, slot, task, projectDir, dbPath } = opts;
  const slotsBefore = getLatestAgent()?.slot ?? -1;
  const windowName = (name ?? role).replace(/[^a-zA-Z0-9_-]/g, '-');

  // Write task to a temp file to avoid shell quoting issues with complex prompts
  const tmpDir = mkdtempSync(join(tmpdir(), 'synapse-'));
  const taskFile = join(tmpDir, 'task.txt');
  writeFileSync(taskFile, task, 'utf8');

  // Write a launcher script — cd to project dir, run worker with task
  const launchScript = join(tmpDir, 'launch.sh');
  const slotArg = slot !== undefined ? ` --slot ${slot}` : '';
  writeFileSync(launchScript, [
    '#!/bin/sh',
    `cd ${JSON.stringify(projectDir)}`,
    `export SYNAPSE_DB_PATH=${JSON.stringify(dbPath)}`,
    `synapse run --role ${JSON.stringify(role)}${slotArg} --task-file ${JSON.stringify(taskFile)}`,
  ].join('\n') + '\n', 'utf8');
  chmodSync(launchScript, 0o755);

  execSync(`tmux new-session -d -s ${JSON.stringify(projectTmuxSession(projectDir))} 2>/dev/null || true`);
  execSync(`tmux new-window -d -t ${JSON.stringify(projectTmuxSession(projectDir))} -n ${JSON.stringify(windowName)} ${JSON.stringify(launchScript)}`);

  // Poll until the worker claims its slot (max 60s)
  let worker: SpawnedWorker | null = null;
  for (let i = 0; i < 120; i++) {
    spawnSync('sleep', ['0.5']);
    if (slot !== undefined) {
      // Forced slot: poll for the specific slot to come alive with a fresh session
      const agent = getAgentBySlot(slot);
      if (agent && agent.ended_at === null && agent.session_id !== null) {
        worker = { agent_id: agent.agent_id, slot: agent.slot };
        break;
      }
    } else {
      const latest = getLatestAgent();
      if (latest && latest.slot > slotsBefore) {
        worker = { agent_id: latest.agent_id, slot: latest.slot };
        break;
      }
    }
  }

  if (worker) {
    // claimAgentSlot doesn't know role — write it now so list_workers/pick_worker
    // can find the new agent by role.
    setAgentRole(worker.agent_id, role);
    setAgentName(worker.agent_id, role);
    setAgentReady(worker.agent_id);

    // Rename the tmux window to <Role>--<slot> now that we know the slot.
    // Disable automatic-rename so tmux doesn't overwrite with the process name.
    const tmuxPane = getAgentBySlot(worker.slot)?.tmux_pane;
    if (tmuxPane) {
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const newName = `${cap(role)}--${worker.slot}`;
      try {
        execFileSync('tmux', ['rename-window', '-t', tmuxPane, newName]);
        execFileSync('tmux', ['set-window-option', '-t', tmuxPane, 'automatic-rename', 'off']);
        // Best-effort: write slot into tmux window env for shell prompts (does not reach running processes).
        execFileSync('tmux', ['set-environment', '-t', tmuxPane, 'SYNAPSE_SLOT', String(worker.slot)]);
      } catch (e) {
        process.stderr.write(`[spawnWorker] rename failed for pane ${tmuxPane}: ${e}\n`);
      }
    }
  }

  return worker;
}
