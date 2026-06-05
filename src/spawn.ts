import { writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { getLatestAgent, getAgentBySlot, setAgentRole } from './db.js';

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

  execSync(`tmux new-window -d -n ${JSON.stringify(windowName)} ${JSON.stringify(launchScript)}`);

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
  }

  return worker;
}
