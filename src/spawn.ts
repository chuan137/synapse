// spec §2.3, §4.5, §4.6; CLAUDE.md hard constraint "workers spawn into their
// own process group"
//
// The spawn wrapper: dispatch (stage -> assigned, no rev — a controller
// write, not one the manager owes a reaction to) plus the guaranteed
// terminal-write layer 2 of §4.5's three-layer exit signal. Unconditional:
// if the child exits and no reply landed, this wrapper writes stage=failed
// and assigns a rev, regardless of exit code.

import { Database } from "bun:sqlite";
import { tx } from "./db";
import { failSubtask, SubtaskTerminalError } from "./subtasks";

export interface SpawnArgs {
  subtaskId: number;
  command: string[];
  synapseBin: string;
  cwd?: string;
  workerModel?: string;
}

export interface SpawnResult {
  subtaskId: number;
  exitCode: number | null;
  signalCode: string | null;
  finalStage: string;
}

const STDERR_TAIL_CHARS = 2000;

function nowIso(): string {
  return new Date().toISOString();
}

// Dispatch write: stage unassigned -> assigned, records worker_session_id +
// worker_pid + worker_model. Not a rev-assigning write (spec §4.2: dispatch
// is a manager/controller act, not one the manager owes itself a reaction
// to).
function markAssigned(
  db: Database,
  subtaskId: number,
  sessionId: string,
  pid: number,
  workerModel: string | null
): void {
  tx(db, () => {
    const row = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string }
      | null;
    if (!row) throw new Error(`spawnSubtask: no subtask ${subtaskId}`);
    if (row.stage !== "unassigned") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is not unassigned (stage=${row.stage}); cannot dispatch`
      );
    }
    db.query(
      `UPDATE subtasks
       SET stage = 'assigned', worker_session_id = ?, worker_pid = ?, worker_model = ?, updated_at = ?
       WHERE id = ?`
    ).run(sessionId, pid, workerModel, nowIso(), subtaskId);
  });
}

function currentStage(db: Database, subtaskId: number): string {
  const row = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as
    | { stage: string }
    | null;
  if (!row) throw new Error(`spawnSubtask: no subtask ${subtaskId}`);
  return row.stage;
}

// spec §4.5 layer 2. Spawns the worker command in its own process group
// (CLAUDE.md: "workers spawn into their own process group" — cancellation
// kills the group, not just worker_pid), waits for exit, and guarantees a
// terminal write: if the child exited and the row is still non-terminal
// (no synapse reply landed), writes stage=failed with the exit code and a
// stderr tail, assigning a rev. If a reply already landed, the wrapper
// does nothing further — the worker's own write stands.
export async function spawnSubtask(db: Database, args: SpawnArgs): Promise<SpawnResult> {
  const sessionId = crypto.randomUUID();

  const proc = Bun.spawn(args.command, {
    cwd: args.cwd ?? process.cwd(),
    env: { ...process.env, SYNAPSE_BIN: args.synapseBin, SUBTASK_ID: String(args.subtaskId) },
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });

  markAssigned(db, args.subtaskId, sessionId, proc.pid, args.workerModel ?? null);

  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const stderrText = await stderrPromise;

  const stage = currentStage(db, args.subtaskId);
  if (stage === "assigned") {
    const signalPart = proc.signalCode ? ` (signal ${proc.signalCode})` : "";
    const tail = stderrText.trim().slice(-STDERR_TAIL_CHARS);
    const summary = `exit ${exitCode}${signalPart}; ${tail}`;
    failSubtask(db, args.subtaskId, summary);
  }

  return {
    subtaskId: args.subtaskId,
    exitCode,
    signalCode: proc.signalCode ?? null,
    finalStage: currentStage(db, args.subtaskId),
  };
}
