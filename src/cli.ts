// spec §5 (Tier 1 + `status`/`done`, Tier 2 `watch`/`start`), §4.1, §4.4, §4.6
//
// Verb dispatch; only DB-touching verbs. Phase 3 adds watch/start
// (process-side verbs Phase 1 deliberately left out). No real manager turn
// function exists before Phase 4/5 — no real model calls before Phase 4
// (CLAUDE.md) — so cmdWatch's runManagerTurn is a placeholder that throws;
// tests exercise watchLoop directly with the scripted policy-manager
// instead of through this CLI verb.

import { Database } from "bun:sqlite";
import { openDb, initSchema } from "./db";
import {
  initRun,
  createSubtask,
  replySubtask,
  closeRun,
  resolveWorktreePath,
  SubtaskTerminalError,
} from "./subtasks";
import { statusView, runIsDone } from "./queries";
import { watchLoop, type ManagerTurnFn } from "./watcher";
import { spawnSubtask } from "./spawn";
import { isRole, allowedToolsFor, defaultModelFor, builtInPromptFor, loadPromptFile } from "./roles";
// Bun inlines text-imported files into `bun build --compile` binaries;
// a runtime path read (import.meta.url + fs.readFileSync) resolves
// against $bunfs and fails once compiled, so the schema must be a
// build-time string import instead (D1: the binary is what workers and
// hooks invoke).
import schemaSql from "./schema.sql" with { type: "text" };

const DB_PATH = ".synapse/synapse.db";

export function getDb(path: string = DB_PATH): Database {
  const db = openDb(path);
  const hasRuns = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
    .get();
  if (!hasRuns) {
    initSchema(db, schemaSql);
  }
  return db;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      flags[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function cmdInit(db: Database, args: string[]): void {
  const { flags } = parseFlags(args);
  const goal = flags["goal"];
  if (!goal) throw new Error("init: --goal is required");
  const result = initRun(db, goal);
  console.log(JSON.stringify({ runId: result.runId, taskId: result.taskId }));
}

export function cmdTask(db: Database, args: string[]): void {
  const { positional, flags } = parseFlags(args);
  const [role, title] = positional;
  if (!role || !title) throw new Error("task: usage: task <role> \"<title>\" --task-id T [--depends-on 7,9]");
  const taskId = Number(flags["task-id"]);
  if (!taskId) throw new Error("task: --task-id is required");
  const runId = Number(flags["run"]);
  if (!runId) throw new Error("task: --run is required");
  const dependsOn = flags["depends-on"]
    ? flags["depends-on"].split(",").map((s) => Number(s.trim()))
    : [];
  const subtaskId = createSubtask(db, { runId, taskId, title, assigneeRole: role, dependsOn });
  console.log(JSON.stringify({ subtaskId }));
}

// spec §5 `synapse spawn`, §3, §4.5+D7 (tool scope), D5 (model default),
// §4.7 (worktree resolution). Launches a real one-shot `claude -p` worker
// (headless, --session-id — spec §4.8: workers never --resume) and wraps
// it with spawnSubtask's guaranteed terminal write (spec §4.5 layer 2).
export async function cmdSpawn(db: Database, args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const [role, subtaskIdStr] = positional;
  if (!role || !subtaskIdStr) {
    throw new Error("spawn: usage: spawn <role> <subtask-id> [--model M] [--prompt-file F]");
  }
  if (!isRole(role)) {
    throw new Error(`spawn: unknown role "${role}" (one of: coder, reviewer, tester, doc-writer)`);
  }
  const subtaskId = Number(subtaskIdStr);
  const row = db.query("SELECT run_id FROM subtasks WHERE id = ?").get(subtaskId) as
    | { run_id: number }
    | null;
  if (!row) throw new Error(`spawn: no subtask ${subtaskId}`);

  const repoRoot = process.cwd();
  const worktreePath = resolveWorktreePath(db, subtaskId, repoRoot);

  const model = flags["model"] ?? defaultModelFor(role);
  // process.execPath correctly self-references the compiled `synapse`
  // binary under `bun build --compile` (confirmed empirically: Bun's
  // compiled output reports its own path here). Under `bun run` in dev,
  // this would instead resolve to the bun binary itself — cmdSpawn is only
  // meant to be exercised through the compiled CLI (D1: "the binary is
  // what workers and hooks invoke"), same as schema.sql's text-import fix.
  const synapseBinPath = process.execPath;

  // spec §9 #24/#25: substitute literal values into the prompt rather than
  // relying on the worker to shell-expand $SYNAPSE_BIN/$SUBTASK_ID/$RUN_ID —
  // Claude Code's Bash(pattern *) allowlist denies variable expansion
  // outright ("Contains simple_expansion"), found by a real reviewer trial.
  const rawPrompt = flags["prompt-file"] ? loadPromptFile(flags["prompt-file"]) : builtInPromptFor(role);
  const promptText = rawPrompt
    .replaceAll("{{SYNAPSE_BIN}}", synapseBinPath)
    .replaceAll("{{SUBTASK_ID}}", String(subtaskId))
    .replaceAll("{{RUN_ID}}", String(row.run_id));

  const allowedTools = allowedToolsFor(role, synapseBinPath).join(",");
  const sessionId = crypto.randomUUID();

  // spec S0.1 finding: --flag=value -- "prompt" is the only reliable shape;
  // space-separated multi-value flags silently swallow the next arg.
  const command = [
    "claude",
    "-p",
    "--session-id",
    sessionId,
    "--output-format",
    "json",
    `--allowedTools=${allowedTools}`,
    `--model=${model}`,
    "--",
    promptText,
  ];

  const result = await spawnSubtask(db, {
    subtaskId,
    command,
    synapseBin: synapseBinPath,
    cwd: worktreePath,
    workerModel: model,
  });
  console.log(JSON.stringify(result));
}

export function cmdReply(db: Database, args: string[]): void {
  const { positional, flags } = parseFlags(args);
  const [subtaskIdStr, result] = positional;
  if (!subtaskIdStr || !result) throw new Error('reply: usage: reply <subtask-id> "<result>" [--handoff kind:file]');
  const subtaskId = Number(subtaskIdStr);
  const handoff = flags["handoff"] ?? null;
  const artifactPath = handoff ? handoff.split(":").slice(1).join(":") || null : null;
  try {
    const rev = replySubtask(db, subtaskId, result, artifactPath);
    console.log(JSON.stringify({ subtaskId, rev }));
  } catch (e) {
    if (e instanceof SubtaskTerminalError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

// spec §4.5 layer 1 (Stop hook). Reads the Stop-hook JSON payload (S0.3
// contract: session_id, stop_hook_active, ...) from stdin and prints the
// hook's stdout contract: {"decision":"block","reason":"..."} if this
// session's subtask has no reply recorded yet, or {} to allow the stop.
// Kept as a thin CLI verb — the actual hook script (hooks/stop.ts) just
// pipes stdin through this and relays stdout, so all the DB logic lives
// here where it's tested, not duplicated in the hook script (D1: the
// binary is what hooks invoke; keep the hook itself under ~20ms).
export function cmdHookCheck(db: Database, payload: { session_id: string; stop_hook_active: boolean }): {
  decision?: "block";
  reason?: string;
} {
  // spec §4.5 (rev-3 addition): the hook must not loop forever — Claude
  // Code itself caps forced stops at ~10, but stop_hook_active=true means
  // this is already a forced re-invocation; blocking again is legal (the
  // outer cap protects against infinite loop from our side too), so this
  // check exists for symmetry with the documented field, not because
  // skipping it would hang anything: once past the outer cap the CLI stops
  // invoking us at all.
  const row = db
    .query("SELECT id, stage FROM subtasks WHERE worker_session_id = ? ORDER BY id DESC LIMIT 1")
    .get(payload.session_id) as { id: number; stage: string } | null;

  if (!row) return {}; // not a Synapse worker session — allow the stop
  if (row.stage !== "assigned") return {}; // already terminal — a reply landed

  return { decision: "block", reason: `you have not called synapse reply for subtask ${row.id}` };
}

export function cmdStatus(db: Database, args: string[]): void {
  const { flags } = parseFlags(args);
  const runId = Number(flags["run"]);
  if (!runId) throw new Error("status: --run is required");
  const view = statusView(db, runId);
  if (flags["json"]) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(`run ${view.run.id} [${view.run.status}]`);
  for (const t of view.tasks) {
    console.log(`  task ${t.task.id} [${t.task.status}] ${t.task.text}`);
    for (const s of t.subtasks) {
      console.log(`    subtask ${s.id} [${s.stage}]${s.ready ? " READY" : ""} ${s.title}`);
    }
  }
}

export function cmdDone(db: Database, args: string[]): void {
  const { flags } = parseFlags(args);
  const runId = Number(flags["run"]);
  if (!runId) throw new Error("done: --run is required");
  if (!runIsDone(db, runId)) {
    console.error(`run ${runId} is not done: not every task is terminal`);
    process.exit(1);
  }
  closeRun(db, runId);
  console.log(JSON.stringify({ runId, status: "done" }));
}

// spec §4.4, §4.9: real manager turns (`claude -p --session-id` /
// `--resume`) are Phase 4/5 work — CLAUDE.md bars real model calls before
// Phase 4. This placeholder keeps `synapse watch`/`start` present as CLI
// verbs (plan Phase 3) without faking a real turn; watchLoop itself is
// fully exercised by tests via the scripted policy-manager.
const notYetImplementedManagerTurn: ManagerTurnFn = async () => {
  throw new Error(
    "no real manager turn function is wired up yet (Phase 4/5); " +
      "use watchLoop/pollOnce directly with an injected ManagerTurnFn until then"
  );
};

export async function cmdWatch(db: Database, args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const runId = Number(flags["run"]);
  if (!runId) throw new Error("watch: --run is required");
  await watchLoop(db, runId, notYetImplementedManagerTurn);
}

export async function cmdStart(db: Database, args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const goal = flags["goal"];
  if (!goal) throw new Error("start: --goal is required");
  const result = initRun(db, goal);
  console.log(JSON.stringify({ runId: result.runId, taskId: result.taskId }));
  await watchLoop(db, result.runId, notYetImplementedManagerTurn);
}

async function cmdHookCheckStdin(db: Database): Promise<void> {
  const stdinText = await new Response(Bun.stdin.stream()).text();
  const payload = JSON.parse(stdinText);
  const result = cmdHookCheck(db, payload);
  console.log(JSON.stringify(result));
}

export function dispatch(db: Database, argv: string[]): void | Promise<void> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "init":
      return cmdInit(db, rest);
    case "task":
      return cmdTask(db, rest);
    case "spawn":
      return cmdSpawn(db, rest);
    case "hook-check":
      return cmdHookCheckStdin(db);
    case "reply":
      return cmdReply(db, rest);
    case "status":
      return cmdStatus(db, rest);
    case "done":
      return cmdDone(db, rest);
    case "watch":
      return cmdWatch(db, rest);
    case "start":
      return cmdStart(db, rest);
    default:
      throw new Error(`unknown verb: ${verb}`);
  }
}

if (import.meta.main) {
  const db = getDb();
  await dispatch(db, process.argv.slice(2));
}
