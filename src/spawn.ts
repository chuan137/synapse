// spec §2.3, §4.5, §4.6; CLAUDE.md hard constraint "workers spawn into their
// own process group"
//
// Two entry points:
//
// claimSubtask() — synchronous half (spec §4.4 Q1 / phase4.5-prompt).
//   Spawns the child and writes stage=assigned in one BEGIN IMMEDIATE, then
//   registers an async supervision promise in inFlightSupervisions and
//   returns immediately. The poll loop calls this so the concurrency cap is
//   correct before the next candidate is considered.
//
// spawnSubtask() — awaited wrapper for the operator's manual `synapse spawn`
//   and for tests. Calls the same internals but awaits the supervision
//   promise before returning, giving callers a final stage.
//
// Accepted cost (§4.5): a watcher that dies with workers in flight loses
// their supervision promises; those rows stay assigned until the layer-3
// pid sweep notices the pid is gone (§4.5 layer 3, now load-bearing).

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

export interface ClaimResult {
  subtaskId: number;
  pid: number;
  sessionId: string;
}

export interface SuperviseResult {
  subtaskId: number;
  exitCode: number | null;
  signalCode: string | null;
  finalStage: string;
}

const STDERR_TAIL_CHARS = 2000;

// Tracks in-flight supervisions so shutdown can drain or kill them rather
// than orphaning workers (§4.4).
export const inFlightSupervisions: Set<Promise<SuperviseResult>> = new Set();

function nowIso(): string {
  return new Date().toISOString();
}

// Dispatch write: stage unassigned -> assigned, records worker_session_id +
// worker_pid + worker_model. Not a rev-assigning write (spec §4.2).
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
  if (!row) throw new Error(`currentStage: no subtask ${subtaskId}`);
  return row.stage;
}

// Shared internals: spawn the child, write assigned, return the proc and
// supervision promise. Used by both claimSubtask and spawnSubtask so neither
// duplicates the spawn+write logic.
function spawnAndClaim(
  db: Database,
  args: SpawnArgs
): { claim: ClaimResult; supervisionPromise: Promise<SuperviseResult> } {
  const sessionId = crypto.randomUUID();

  const proc = Bun.spawn(args.command, {
    cwd: args.cwd ?? process.cwd(),
    env: { ...process.env, SYNAPSE_BIN: args.synapseBin, SUBTASK_ID: String(args.subtaskId) },
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    markAssigned(db, args.subtaskId, sessionId, proc.pid, args.workerModel ?? null);
  } catch (e) {
    // §4.5: if the write fails, kill the child so no row is ever assigned
    // with a NULL pid and no live supervision.
    proc.kill(9);
    throw e;
  }

  const stderrPromise = new Response(proc.stderr).text();

  // spec §4.5 layer 2: if the child exits and no reply landed, write
  // stage=failed. Unconditional — catches everything the stop hook misses.
  const supervisionPromise: Promise<SuperviseResult> = (async () => {
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
  })();

  return { claim: { subtaskId: args.subtaskId, pid: proc.pid, sessionId }, supervisionPromise };
}

// Non-blocking dispatch entry point. Spawns the child, writes assigned
// synchronously, registers the supervision promise in inFlightSupervisions,
// and returns. The poll loop uses this so the concurrency cap is correct
// before considering the next candidate.
export function claimSubtask(db: Database, args: SpawnArgs): ClaimResult {
  const { claim, supervisionPromise } = spawnAndClaim(db, args);
  inFlightSupervisions.add(supervisionPromise);
  supervisionPromise.finally(() => inFlightSupervisions.delete(supervisionPromise));
  return claim;
}

// Awaited wrapper — for the operator's manual `synapse spawn` and for tests
// that need the final stage. Registers in inFlightSupervisions then awaits.
export async function spawnSubtask(db: Database, args: SpawnArgs): Promise<SuperviseResult> {
  const { supervisionPromise } = spawnAndClaim(db, args);
  inFlightSupervisions.add(supervisionPromise);
  supervisionPromise.finally(() => inFlightSupervisions.delete(supervisionPromise));
  return supervisionPromise;
}
