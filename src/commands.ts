import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import SHARED_MD from "../templates/shared.md" with { type: "text" };
import ROLE_MANAGER_MD from "../templates/role-manager.md" with { type: "text" };
import ROLE_CODER_MD from "../templates/role-coder.md" with { type: "text" };
import ROLE_REVIEWER_MD from "../templates/role-reviewer.md" with {
  type: "text",
};
import ROLE_TESTER_MD from "../templates/role-tester.md" with {
  type: "text",
};
import { connect, dbPath, defaultAgentDir, initDb } from "./db";
import { SKILLS } from "./skills.generated";

const ROLE_TEMPLATES: Record<string, string> = {
  manager: ROLE_MANAGER_MD,
  coder: ROLE_CODER_MD,
  reviewer: ROLE_REVIEWER_MD,
  tester: ROLE_TESTER_MD,
};

// Writes (overwrites) <targetDir>/.claude/skills/<name>/SKILL.md for every
// packaged skill. Called for the project root (so the operator's own Claude
// Code session, if rooted there, can see them) and for each spawned agent's
// scratch cwd (see writeAgentClaudeMd) — Claude Code only discovers
// project-scoped skills under the cwd it was launched in, not a parent
// project's .claude/, so each agent needs its own copy. Regenerated on every
// call, same "always in sync with the installed synapse version, don't hand-edit"
// convention as the generated CLAUDE.md files.
function installSkills(targetDir: string): void {
  for (const [name, content] of Object.entries(SKILLS)) {
    const dir = join(targetDir, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
  }
}

export const MESSAGE_TYPES = new Set(["TASK", "QUESTION", "PROGRESS", "REPLY"]);

export const DEFAULT_TMUX_SESSION = "team";
export const DEFAULT_TASK_TEMPLATE = "templates/task.example.yml";
export const DEFAULT_MANAGER_MODEL = "opus";

export function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

export function fail(msg: string): never {
  console.error(`synapse: ${msg}`);
  process.exit(1);
}

export const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

export function colorType(t: string): string {
  const color =
    t === "TASK"     ? c.blue   :
    t === "QUESTION" ? c.yellow :
    t === "PROGRESS" ? c.dim    :
    t === "REPLY"    ? c.green  :
    c.cyan;
  return `${color}${t}${c.reset}`;
}

export function cmdInit() {
  initDb();
  // Project root: two levels up from the DB file (./.synapse/synapse.db ->
  // project root), same derivation cmdStart uses for direnv/claude launch.
  const projectRoot = dirname(dirname(dbPath()));
  installSkills(projectRoot);
  console.log(`synapse: installed skills to ${join(projectRoot, ".claude", "skills")}`);
}

export function cmdRegister(
  name: string,
  role: string,
  sessionId: string | null,
  runId?: number | null,
  model?: string | null,
) {
  const db = connect();
  const resolvedRunId = runId ?? null;
  db.run(
    `INSERT INTO agents (window_name, run_id, role, model, session_id, status, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'unknown', ?)
     ON CONFLICT(window_name, run_id) DO UPDATE SET
       role=excluded.role,
       model=excluded.model,
       session_id=excluded.session_id,
       status='unknown',
       last_seen_at=excluded.last_seen_at`,
    [name, resolvedRunId, role, model ?? null, sessionId, nowIso()],
  );
  console.log(
    `synapse: registered '${name}' (role=${role}${model ? ", model=" + model : ""}, session_id=${sessionId ?? "-"})`,
  );
}

export function resolveFrom(from: string | null): string {
  const frm = from ?? process.env.SYNAPSE_AGENT;
  if (!frm) fail("missing sender — pass --from NAME or set SYNAPSE_AGENT");
  return frm;
}

// Matches `(1)`, `(2)`, ... and circled-digit markers `①②③...` up to 20.
// Two or more hits with no literal newline in the body means someone wrote
// a numbered list as one run-on sentence instead of using line breaks/bullets.
const NUMBERED_MARKER_RE = /\(\d{1,2}\)|[①-⑳]/g;

// A non-manager agent (coder/reviewer/tester) may PROGRESS directly to
// operator, but only as a lifecycle marker — start/done/blocked/step — never as
// process narration. See docs/progress-direct-signal-spec.md.
const DIRECT_PROGRESS_PREFIX_RE = /^\[(start|done|blocked|step)\]/;

export function hasUnbrokenNumberedList(body: string): boolean {
  const matches = body.match(NUMBERED_MARKER_RE);
  if (!matches || matches.length < 2) return false;
  return !body.includes("\n");
}

export function cmdSend(
  to: string,
  type: string,
  body: string,
  from: string | null,
  refId: number | null,
  runId?: number | null,
  options?: string[] | null,
  title?: string | null,
) {
  if (!MESSAGE_TYPES.has(type)) {
    fail(`type must be one of ${[...MESSAGE_TYPES].sort()}, got '${type}'`);
  }
  if (hasUnbrokenNumberedList(body)) {
    fail(
      "body reads like a numbered list ((1)/(2)/①② markers) crammed into one " +
        "sentence with no line breaks. Use '- ' bullets or literal newlines " +
        "between points instead, e.g. \"Done.\\n- src/x.ts: <change>\\n- src/y.ts: <change>\".",
    );
  }
  if (type === "QUESTION" && to === "operator" && (!options || options.length === 0)) {
    fail(
      "QUESTION to operator requires --options a,b,c — the S-Deck card has no " +
        "generic fallback, so the operator would see no clickable choices at all. " +
        "Pass 2-4 short, specific option labels that reflect this question's real answers " +
        "(not literal 'Yes,No,OK'), plus --title for a short header.",
    );
  }
  if (to === "broadcast") {
    fail("broadcast messages are no longer supported; send to a specific agent");
  }
  const frm = resolveFrom(from);
  if (type === "PROGRESS" && to === "operator" && frm !== "manager") {
    if (!DIRECT_PROGRESS_PREFIX_RE.test(body)) {
      fail(
        "direct PROGRESS to operator from a non-manager agent must lead with " +
          "[start], [done], [blocked], or [step] — this path is for lifecycle markers only " +
          "(one per TASK you accept, one before the REPLY that closes it). Process " +
          "narration (\"trying X\", \"still working on Y\") goes to your supervisor " +
          "via PROGRESS/REPLY, not to operator. See docs/progress-direct-signal-spec.md.",
      );
    }
  }
  const db = connect();
  // Resolve run_id: explicit arg -> SYNAPSE_RUN_ID env -> null
  const resolvedRunId = runId !== undefined && runId !== null
    ? runId
    : (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  const known = resolvedRunId !== null
    ? db.query("SELECT 1 FROM agents WHERE window_name=? AND (run_id=? OR run_id=0)").get(to, resolvedRunId)
    : db.query("SELECT 1 FROM agents WHERE window_name=?").get(to);
  if (!known) {
    console.error(
      `synapse: warning — '${to}' not in agents registry yet (sending anyway)`,
    );
  }
  const optionsJson = options && options.length > 0 ? JSON.stringify(options) : null;
  const result = db.run(
    `INSERT INTO messages (run_id, from_agent, to_agent, type, ref_id, body, options, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [resolvedRunId, frm, to, type, refId, body, optionsJson, title ?? null],
  );
  console.log(
    `synapse: message ${result.lastInsertRowid} queued (${frm} -> ${to}, ${type}${
      refId ? ", ref=" + refId : ""
    }${resolvedRunId ? ", run=" + resolvedRunId : ""})`,
  );
}

export function cmdStatus() {
  const db = connect();

  const activeRun = (() => {
    const envRunId = process.env.SYNAPSE_RUN_ID
      ? parseInt(process.env.SYNAPSE_RUN_ID, 10)
      : null;
    if (envRunId) {
      return db.query(
        "SELECT id, session, status, goal FROM runs WHERE id=?",
      ).get(envRunId) as any;
    }
    return (db.query(
      "SELECT id, session, status, goal FROM runs WHERE status='running' ORDER BY id DESC LIMIT 1",
    ).get() as any) ?? (db.query(
      "SELECT id, session, status, goal FROM runs ORDER BY id DESC LIMIT 1",
    ).get() as any);
  })();

  const agents = activeRun
    ? db.query("SELECT * FROM agents WHERE (run_id=? OR run_id=0) ORDER BY role, window_name").all(activeRun.id) as any[]
    : db.query("SELECT * FROM agents ORDER BY role, window_name").all() as any[];

  if (agents.length === 0) {
    console.log("synapse: no agents registered");
    return;
  }
  const pendingStmt = activeRun
    ? db.query(
        `SELECT COUNT(*) AS n FROM messages WHERE status='pending'
         AND to_agent=?
         AND run_id=?`,
      )
    : db.query(
        `SELECT COUNT(*) AS n FROM messages WHERE status='pending'
         AND to_agent=?`,
      );

  if (activeRun) {
    const goal = (activeRun.goal ?? "").replace(/\n.*/s, "").slice(0, 72);
    console.log(`run #${activeRun.id}  ${activeRun.session}  [${activeRun.status}]${goal ? "  " + goal : ""}`);
    console.log("");
  }

  const headers = ["WINDOW", "ROLE", "MODEL", "STATE", "LAST_SEEN", "PENDING"];
  const rows = agents.map((a) => {
    const pending = activeRun
      ? (pendingStmt.get(a.window_name, activeRun.id) as any).n
      : (pendingStmt.get(a.window_name) as any).n;
    return [
      a.window_name,
      a.role,
      a.model ?? "-",
      a.status,
      a.last_seen_at ?? "-",
      String(pending),
    ];
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((col, i) => col.padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  for (const row of rows) console.log(fmt(row));
}

export function cmdRuns() {
  const db = connect();
  const runs = db
    .query("SELECT id, session, status, started_at, ended_at, goal FROM runs ORDER BY id DESC")
    .all() as any[];
  if (!runs.length) {
    console.log("synapse: no runs recorded");
    return;
  }
  const headers = ["ID", "SESSION", "STATE", "STARTED", "ENDED", "GOAL"];
  const rows = runs.map((r) => [
    String(r.id),
    r.session,
    r.status,
    r.started_at ?? "-",
    r.ended_at ?? "-",
    (r.goal ?? "-").replace(/\n[\s\S]*/m, "").slice(0, 60),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((col, i) => col.padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  for (const row of rows) console.log(fmt(row));
}

// Checkpoint (docs/progress-direct-signal-spec.md, decision 3): every time
// manager pulls pending, flag ref_id chains it received a message on but
// never sent a matching-ref_id message back to operator for. Best-effort
// nudge, not a formal completeness proof — templates anchor ref_id on
// different ids for different chains (subtask TASK id for coder/reviewer,
// root TASK id for tester), so this can miss or over-flag at the margins.
// It replaces "manager remembers to relay" with "manager gets reminded on
// every wake-up", which is the actual gap being closed.
function printUnrelayedCheckpoint(db: ReturnType<typeof connect>, runId: number | null) {
  const rows = (runId !== null
    ? db.query(
        `SELECT DISTINCT ref_id FROM messages
         WHERE to_agent = 'manager' AND ref_id IS NOT NULL AND run_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM messages m2
             WHERE m2.from_agent = 'manager' AND m2.to_agent = 'operator'
               AND m2.ref_id = messages.ref_id
           )`,
      ).all(runId)
    : db.query(
        `SELECT DISTINCT ref_id FROM messages
         WHERE to_agent = 'manager' AND ref_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM messages m2
             WHERE m2.from_agent = 'manager' AND m2.to_agent = 'operator'
               AND m2.ref_id = messages.ref_id
           )`,
      ).all()) as any[];
  if (rows.length === 0) return;
  const ids = rows.map((r: any) => `#${r.ref_id}`).join(", ");
  console.log(
    `${c.yellow}synapse: checkpoint — ref_id ${ids} has a reply/progress addressed to ` +
      `you with no manager -> operator message on the same ref_id yet. If that's a real ` +
      `subtask milestone, relay it before you move on.${c.reset}`,
  );
  console.log();
}

export function cmdPending(agent: string | null, all?: boolean) {
  const db = connect();
  const envAgent = process.env.SYNAPSE_AGENT ?? null;
  const targetAgent = agent ?? envAgent;
  const shouldConsume = !!targetAgent && envAgent === targetAgent;

  let activeRun: any = null;
  if (!all) {
    const envRunId = process.env.SYNAPSE_RUN_ID
      ? parseInt(process.env.SYNAPSE_RUN_ID, 10)
      : null;
    if (envRunId) {
      activeRun = db.query("SELECT id FROM runs WHERE id=?").get(envRunId) as any;
      if (!activeRun) fail(`no run with id=${envRunId}`);
    } else {
      activeRun = db.query(
        "SELECT id FROM runs WHERE status='running' ORDER BY id DESC LIMIT 1",
      ).get() as any;
      if (!activeRun) fail(
        "cannot resolve run — set SYNAPSE_RUN_ID, or pass --all to see every run",
      );
    }
  }

  if (targetAgent === "manager") {
    printUnrelayedCheckpoint(db, activeRun ? activeRun.id : null);
  }

  const rows = targetAgent
    ? (activeRun
        ? db.query(
            `SELECT * FROM messages WHERE status='pending'
             AND to_agent=? AND run_id=? ORDER BY created_at`,
          ).all(targetAgent, activeRun.id)
        : db.query(
            `SELECT * FROM messages WHERE status='pending'
             AND to_agent=? ORDER BY created_at`,
          ).all(targetAgent)
      ) as any[]
    : (activeRun
        ? db.query(
            "SELECT * FROM messages WHERE status='pending' AND run_id=? ORDER BY created_at",
          ).all(activeRun.id)
        : db.query(
            "SELECT * FROM messages WHERE status='pending' ORDER BY created_at",
          ).all()
      ) as any[];
  if (rows.length === 0) {
    console.log("synapse: no pending messages");
    return;
  }

  if (shouldConsume) {
    const ids = rows.map((r: any) => r.id);
    const placeholders = ids.map(() => "?").join(", ");
    db.run(
      `UPDATE messages SET status='read', delivered_at=? WHERE id IN (${placeholders}) AND status='pending'`,
      [nowIso(), ...ids],
    );
  }

  const agentW = Math.max(
    ...rows.flatMap((r) => [r.from_agent.length, r.to_agent.length]),
  );
  const typeW = Math.max(...rows.map((r) => r.type.length));
  const refW = Math.max(
    ...rows.map((r) => (r.ref_id ? `ref:#${r.ref_id}`.length : 0)),
  );
  for (const r of rows) {
    const route = `${r.from_agent.padEnd(agentW)} → ${r.to_agent.padEnd(agentW)}`;
    const type = colorType(r.type) + " ".repeat(typeW - r.type.length);
    const refRaw = r.ref_id ? `ref:#${r.ref_id}` : "";
    const ref = refRaw
      ? `${c.dim}${refRaw}${c.reset}` + " ".repeat(refW - refRaw.length)
      : " ".repeat(refW);
    const ts = `${c.dim}${r.created_at.slice(0, 16)}${c.reset}`;
    const id = `${c.dim}#${String(r.id).padStart(2)}${c.reset}`;
    console.log(`${id}  ${route}  ${type}  ${ref}  ${ts}`);
    console.log(`      ${r.body}`);
    console.log();
  }
}

export function cmdDeliver(id: number) {
  const db = connect();
  const result = db.run(
    "UPDATE messages SET status='read', delivered_at=? WHERE id=? AND status IN ('pending', 'delivered')",
    [nowIso(), id],
  );
  if (result.changes === 0) fail(`no pending or delivered message with id=${id}`);
  console.log(`synapse: message ${id} marked read`);
}

// ---------- task.yml / bootstrap ----------

interface AgentConfig {
  name: string;
  role: string;
  // Instance block: free text distinguishing this specific agent from other
  // agents of the same role (e.g. coder-1 vs coder-2).
  focus?: string;
  // Optional model override, e.g. "claude-opus-4-8" or alias "opus".
  model?: string;
}

// ---------- CLAUDE.md assembly (bootstrap-spec.md dimension A + #5) ----------

// Three-segment assembly: shared block (all agents) + role block (per role,
// reused across instances of that role) + instance block (per agent, from
// task.yml's `focus` field). Written once into the synapse-managed scratch
// tree for a fresh task; task names are unique, so existing scratch is never
// overwritten.
function assembleClaudeMd(agent: AgentConfig): string {
  const sections: string[] = [SHARED_MD.trimEnd()];

  const roleBlock = ROLE_TEMPLATES[agent.role];
  if (roleBlock) {
    sections.push(roleBlock.trimEnd());
  } else {
    console.error(
      `synapse: warning — no role template for role '${agent.role}' (agent '${agent.name}'); CLAUDE.md will have the shared block only`,
    );
  }

  if (agent.focus && agent.focus.trim()) {
    sections.push(
      `## Your focus (${agent.name})\n\n${agent.focus.trim()}`,
    );
  }

  sections.push(
    `---\n\n_Generated by \`synapse start\` for agent \`${agent.name}\` (role: ${agent.role}). ` +
      `Regenerated and overwritten on every \`synapse start\` — edits made directly to this file do not persist._`,
  );

  return sections.join("\n\n") + "\n";
}

// Writes (overwrites) <absCwd>/CLAUDE.md, creating the directory if needed,
// and installs the packaged skills into <absCwd>/.claude/skills/ — this
// agent's cwd is its own Claude Code project root, so it needs its own copy
// (see installSkills) rather than inheriting the main project's.
function writeAgentClaudeMd(absCwd: string, agent: AgentConfig): void {
  mkdirSync(absCwd, { recursive: true });
  writeFileSync(join(absCwd, "CLAUDE.md"), assembleClaudeMd(agent));
  installSkills(absCwd);
}

// ---------- unattended preflight (bootstrap-spec.md #7) ----------

// Workspace trust ("trust this folder") blocks unattended launch and isn't
// cleared by --dangerously-skip-permissions or git init. Claude Code records
// acceptance in ~/.claude.json under .projects[<canonical abs cwd>], keyed by
// the *symlink-resolved* path (macOS /var -> /private/var) — using
// path.resolve() instead of realpathSync here would silently fail to match.
function presetClaudeTrust(absCwd: string): void {
  const canonicalCwd = realpathSync(absCwd);
  const configPath = join(homedir(), ".claude.json");

  let config: any = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      console.error(
        `synapse: warning — ${configPath} is not valid JSON; leaving it untouched and skipping trust preseed`,
      );
      return;
    }
  }

  config.hasCompletedOnboarding = true;
  config.projects ??= {};
  config.projects[canonicalCwd] ??= {};
  config.projects[canonicalCwd].hasTrustDialogAccepted = true;

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err: any) {
    console.error(
      `synapse: warning — could not write ${configPath}; skipping trust preseed (${err?.message ?? err})`,
    );
  }
}

// Spawn tmux without the TMUX env var so nested invocations (e.g. from a UI
// server running inside a tmux pane) don't confuse tmux into targeting the
// current session instead of the named destination session.
function spawnTmux(args: string[]): ReturnType<typeof Bun.spawnSync> {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return Bun.spawnSync({ cmd: ["tmux", ...args], env });
}

// Launches one agent window in the tmux session.
//
// tmux windows are real TTYs; claude runs directly without any pty wrapper.
// We pass --session-id explicitly so we know the session ID before launch — no need
// to poll ~/.claude/projects/ for a new transcript file (that approach, plus
// the "hi" nudge to coax a first jsonl write, has been removed: it was the
// fragile timing hack bootstrap-spec.md problem 2 set out to replace).
//
// The first-kick (bootstrap-spec.md #6/#7) is the bare minimum: `synapse
// pending <name>`, passed as claude's initial prompt so it runs the instant
// the session loads — no external actor has to guess when claude is ready.
// `--dangerously-skip-permissions` clears the per-tool-call approval prompt
// (the other unattended-launch gate, bootstrap-spec.md #7); presetClaudeTrust
// clears the one-time workspace-trust dialog before that.
function launchAgentWindow(
  tmuxSession: string,
  taskName: string,
  agent: AgentConfig,
  synapseDb: string,
  claudePath: string,
  sessionId: string,
  runId: number,
  projectRoot: string,
): void {
  const absCwd = resolve(defaultAgentDir(taskName, agent.name));
  presetClaudeTrust(absCwd);

  // Use direnv exec to load the project root's .envrc (if any), giving each
  // agent the env that matches the project directory rather than inheriting
  // whatever the launching shell had (e.g. a ~/ccloud direnv that sets
  // ANTHROPIC_BASE_URL to an enterprise proxy).
  const direnvPath = Bun.spawnSync(["which", "direnv"]).stdout.toString().trim() || "direnv";
  const initialPrompt = `synapse pending ${agent.name}`;
  const modelFlag = agent.model ? `--model ${agent.model} ` : "";
  const shellCmd = `
    cd '${absCwd}' || exit 1
    SYNAPSE_DB='${synapseDb}' SYNAPSE_AGENT='${agent.name}' SYNAPSE_RUN_ID='${runId}' '${direnvPath}' exec '${projectRoot}' '${claudePath}' --session-id '${sessionId}' --dangerously-skip-permissions --disallowedTools AskUserQuestion,EnterPlanMode ${modelFlag}'${initialPrompt}'
  `;

  if (process.env.SYNAPSE_DEBUG) {
    console.error(`[debug] window '${agent.name}' shellCmd:\n${shellCmd}`);
  }
  const result = spawnTmux([
    "new-window",
    "-a",
    "-t",
    tmuxSession,
    "-n",
    agent.name,
    "/bin/bash",
    "-c",
    shellCmd,
  ]);
  if (result.exitCode !== 0) {
    fail(
      `failed to create tmux window '${agent.name}': ${result.stderr.toString().trim()}`,
    );
  }
}

export function cmdStart(flags: Record<string, string>) {
  const goal = flags["goal"];
  if (!goal) fail("--goal is required");
  const noMonitor = flags["no-monitor"] === "true";
  const managerModel = flags["manager-model"] ?? DEFAULT_MANAGER_MODEL;

  const dbFile = dbPath();
  const dataDir = dirname(dbFile);
  mkdirSync(dataDir, { recursive: true });

  cmdInit();
  const db = connect();

  const projectRoot = dirname(dirname(dbFile));
  const projectSlug = basename(projectRoot).slice(0, 3).toLowerCase().replace(/[^a-z0-9]/g, "x");

  const runResult = db.run(
    `INSERT INTO runs (session, goal, status) VALUES ('', ?, 'pending')`,
    [goal],
  );
  const runId = Number(runResult.lastInsertRowid);
  const pathHash = Bun.hash(projectRoot).toString(16).slice(0, 4);
  const taskName = `${projectSlug}-${pathHash}-${runId}`;
  const runFolderName = `run-${runId}`;

  const abort = (msg: string): never => {
    db.run(`DELETE FROM runs WHERE id=?`, [runId]);
    fail(msg);
  };

  const artifactsFolder = join(dataDir, "artifacts", runFolderName);
  const agentsDir = join(dataDir, "workdirs", runFolderName);
  mkdirSync(artifactsFolder, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  console.log(`synapse: created run folder ${artifactsFolder}`);

  db.run(
    `INSERT INTO agents (window_name, run_id, role, session_id, status, last_seen_at)
     VALUES ('operator', 0, 'operator', NULL, 'idle', ?)
     ON CONFLICT(window_name, run_id) DO UPDATE SET status='idle', last_seen_at=excluded.last_seen_at`,
    [nowIso()],
  );

  const tmuxSession = taskName;

  const sessionExists = spawnTmux(["has-session", "-t", `=${tmuxSession}`]);
  if (sessionExists.exitCode === 0) {
    abort(
      `tmux session '${tmuxSession}' already exists — check for a stuck session (tmux kill-session -t ${tmuxSession}) and retry`,
    );
  }
  const colsResult = Bun.spawnSync(["tput", "cols"]);
  const linesResult = Bun.spawnSync(["tput", "lines"]);
  const termCols = colsResult.exitCode === 0 ? colsResult.stdout.toString().trim() : "220";
  const termLines = linesResult.exitCode === 0 ? linesResult.stdout.toString().trim() : "50";

  const newSession = spawnTmux([
    "new-session", "-d", "-s", tmuxSession,
    "-x", termCols,
    "-y", termLines,
  ]);
  if (newSession.exitCode !== 0) {
    abort(
      `failed to create tmux session '${tmuxSession}': ${newSession.stderr.toString().trim()}`,
    );
  }
  spawnTmux(["rename-window", "-t", tmuxSession, "monitor"]);
  spawnTmux(["set-option", "-t", `=${tmuxSession}`, "window-size", "largest"]);

  const synapseCliPath = resolve(
    process.execPath === process.argv[0]
      ? process.argv[1]
      : process.execPath,
  );

  const claudeWhich = Bun.spawnSync(["which", "claude"]);
  const claudePath =
    claudeWhich.exitCode === 0
      ? claudeWhich.stdout.toString().trim()
      : "claude";

  // Launch manager only — manager spawns workers dynamically as needed.
  const sessionId = crypto.randomUUID();
  const manager: AgentConfig = { role: "manager", name: "manager", model: managerModel };
  const absCwd = resolve(defaultAgentDir(runFolderName, "manager"));
  writeAgentClaudeMd(absCwd, manager);
  console.log(`synapse: launching window 'manager' in ${absCwd}`);
  launchAgentWindow(tmuxSession, runFolderName, manager, dbFile, claudePath, sessionId, runId, projectRoot);
  cmdRegister("manager", "manager", sessionId, runId, managerModel);

  if (!noMonitor) {
    const monitorCmd = `SYNAPSE_DB='${dbFile}' ${synapseCliPath} monitor --session ${tmuxSession} --run-id ${runId} 2>&1 | tee '${dbFile.replace(/synapse\.db$/, "monitor.log")}'`;
    const r = spawnTmux([
      "send-keys", "-t", `${tmuxSession}:monitor`,
      monitorCmd, "Enter",
    ]);
    if (r.exitCode !== 0) {
      console.error(`synapse: warning — failed to start monitor: ${r.stderr.toString().trim()}`);
    } else {
      console.log(`synapse: monitor started in window '${tmuxSession}:monitor'`);
    }
  }

  cmdSend("manager", "TASK", goal, "operator", null, runId);
  console.log(`synapse: initial goal queued as TASK to 'manager'`);

  db.run(`UPDATE runs SET session=?, status='running' WHERE id=?`, [tmuxSession, runId]);

  console.log();
  console.log(`  Attach: tmux attach -t ${tmuxSession}`);
  console.log(`  Status: synapse status`);
  console.log(`  Finish: SYNAPSE_RUN_ID=${runId} synapse done --status done "<summary>"`);
}


export function cmdSpawn(role: string, flags: Record<string, string>) {
  const VALID_ROLES = ["coder", "reviewer", "tester", "manager"];
  if (!VALID_ROLES.includes(role)) fail(`unknown role '${role}' — must be one of ${VALID_ROLES.join(", ")}`);

  const db = connect();
  const runId = flags["run-id"] ? parseInt(flags["run-id"]) : null;

  const run = runId
    ? db.query("SELECT * FROM runs WHERE id=? AND status='running'").get(runId) as any
    : db.query("SELECT * FROM runs WHERE status='running' ORDER BY id DESC LIMIT 1").get() as any;
  if (!run) fail(runId ? `no running run with id ${runId}` : "no active running run");

  const tmuxSession = run.session as string;
  const runFolderName = `run-${run.id}`;

  const existing = db.query(
    "SELECT window_name FROM agents WHERE run_id=? AND role=?"
  ).all(run.id, role) as any[];
  const count = existing.length;
  const name = count === 0 ? role : `${role}-${count + 1}`;

  const dbFile = dbPath();
  const projectRoot = dirname(dirname(dbFile));

  const claudeWhich = Bun.spawnSync(["which", "claude"]);
  const claudePath = claudeWhich.exitCode === 0 ? claudeWhich.stdout.toString().trim() : "claude";

  const sessionId = crypto.randomUUID();

  const effectiveModel = flags["model"] ?? (role === "manager" ? DEFAULT_MANAGER_MODEL : undefined);
  const agent: AgentConfig = { role, name, model: effectiveModel, focus: flags["focus"] };

  const absCwd = resolve(defaultAgentDir(runFolderName, name));
  writeAgentClaudeMd(absCwd, agent);

  launchAgentWindow(tmuxSession, runFolderName, agent, dbFile, claudePath, sessionId, run.id, projectRoot);
  cmdRegister(name, role, sessionId, run.id, effectiveModel ?? null);

  console.log(`synapse: spawned '${name}' (${role}) in run #${run.id}, window '${tmuxSession}:${name}'`);
}

// The hub agent's signal that the root task has reached a terminal outcome
// (bootstrap-spec.md #8/#13). Writes the run's terminal state and sends the
// final REPLY back to operator. The monitor stays alive after terminal state
// and keeps dispatching operator follow-ups until the tmux session is killed.
export function cmdDone(
  status: string,
  summary: string | null,
  from: string | null,
  refIdFlag: number | null,
  runIdFlag: number | null,
) {
  const agent = resolveFrom(from);
  const resolvedSummary = summary || "Run marked done.";
  const dbStatus = status === "failed" ? "failed" : "completed";

  const db = connect();
  const runId = runIdFlag ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  if (runId === null || Number.isNaN(runId)) {
    console.error(
      "synapse: warning — no run id (SYNAPSE_RUN_ID not set and --run-id not passed); runs table not updated",
    );
  } else {
    const result = db.run(
      "UPDATE runs SET status=?, ended_at=? WHERE id=? AND status='running'",
      [dbStatus, nowIso(), runId],
    );
    if (result.changes === 0) {
      console.error(
        `synapse: warning — run ${runId} not found or already finished`,
      );
    }
  }

  // Default ref_id to the root TASK addressed to this agent, if not given —
  // that's the message this REPLY is closing out.
  let refId = refIdFlag;
  if (refId === null) {
    const root = runId !== null
      ? db
          .query(
            `SELECT id FROM messages WHERE to_agent=? AND type='TASK' AND ref_id IS NULL AND run_id=? ORDER BY id DESC LIMIT 1`,
          )
          .get(agent, runId) as any
      : db
          .query(
            `SELECT id FROM messages WHERE to_agent=? AND type='TASK' AND ref_id IS NULL ORDER BY id DESC LIMIT 1`,
          )
          .get(agent) as any;
    refId = root?.id ?? null;
  }

  cmdSend("operator", "REPLY", resolvedSummary, agent, refId, runId);
  console.log(
    `synapse: done — run ${runId ?? "?"} marked '${dbStatus}', final REPLY sent to operator`,
  );
}

export function cmdSetGoal(goal: string, runId?: number | null) {
  const db = connect();
  let run: any;
  if (runId != null) {
    run = db.query("SELECT id, status FROM runs WHERE id=?").get(runId);
    if (!run) fail(`synapse set-goal: run #${runId} not found`);
  } else {
    run = db.query("SELECT id, status FROM runs WHERE status='running' ORDER BY id DESC LIMIT 1").get();
    if (!run) fail("synapse set-goal: no running run found");
  }
  db.run("UPDATE runs SET goal=? WHERE id=?", [goal.trim(), run.id]);
  console.log(`synapse: goal updated for run #${run.id}`);
}

export function cmdStop(name: string, tmuxSession: string, runId?: number) {
  const db = connect();
  const resolvedRunId = runId ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  const agent = resolvedRunId !== null
    ? db.query("SELECT * FROM agents WHERE window_name=? AND run_id=?").get(name, resolvedRunId) as any
    : db.query("SELECT * FROM agents WHERE window_name=?").get(name) as any;
  if (!agent) fail(`no registered agent named '${name}'${resolvedRunId !== null ? ` in run ${resolvedRunId}` : ""}`);

  db.run(
    "UPDATE agents SET status='stopped', last_seen_at=? WHERE window_name=? AND run_id=?",
    [nowIso(), name, agent.run_id],
  );

  const killResult = Bun.spawnSync([
    "tmux",
    "kill-window",
    "-t",
    `=${tmuxSession}:${name}`,
  ]);
  if (killResult.exitCode !== 0) {
    const stderr = killResult.stderr.toString().trim();
    console.error(`synapse: warning — tmux kill-window failed: ${stderr}`);
  }
  console.log(`synapse: agent '${name}' stopped`);
}

export function cmdAttach(name: string, tmuxSession: string) {
  const result = Bun.spawnSync(
    ["tmux", "attach-session", "-t", `=${tmuxSession}:${name}`],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) {
    fail(`tmux attach failed: ${result.stderr?.toString().trim()}`);
  }
}
