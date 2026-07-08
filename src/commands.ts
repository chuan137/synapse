import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, relative, resolve } from "path";
import SHARED_MD from "../templates/shared.md" with { type: "text" };
import ROLE_MANAGER_MD from "../templates/role-manager.md" with { type: "text" };
import ROLE_CODER_MD from "../templates/role-coder.md" with { type: "text" };
import ROLE_REVIEWER_MD from "../templates/role-reviewer.md" with {
  type: "text",
};
import ROLE_TESTER_MD from "../templates/role-tester.md" with {
  type: "text",
};
import TASK_EXAMPLE_YML from "../templates/task.example.yml" with { type: "text" };
import { connect, dbPath, defaultAgentDir, initDb } from "./db";

const ROLE_TEMPLATES: Record<string, string> = {
  manager: ROLE_MANAGER_MD,
  coder: ROLE_CODER_MD,
  reviewer: ROLE_REVIEWER_MD,
  tester: ROLE_TESTER_MD,
};

export const MESSAGE_TYPES = new Set(["TASK", "QUESTION", "PROGRESS", "REPLY"]);

export const DEFAULT_TMUX_SESSION = "team";
export const DEFAULT_TASK_TEMPLATE = "templates/task.example.yml";

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

interface TaskConfig {
  synapseVersion: string;
  workflow: string;
  goal: string | null;
  agents: AgentConfig[];
}

function appendGeneratedTaskFields(
  taskText: string,
  runId: number,
  agentsDir: string,
): string {
  return `${taskText.trimEnd()}\n\n# --- added by synapse start ---\nrun_id: ${runId}\nagents_dir: ${agentsDir}\n`;
}

function workspaceRelativePath(absPath: string): string {
  const rel = relative(process.cwd(), absPath);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : absPath;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function assignAgentNames(agents: Array<Partial<AgentConfig>>): AgentConfig[] {
  const roleCounts = new Map<string, number>();
  for (const agent of agents) {
    if (agent.role) roleCounts.set(agent.role, (roleCounts.get(agent.role) ?? 0) + 1);
  }

  const roleIndexes = new Map<string, number>();
  return agents.map((agent) => {
    if (!agent.role) fail("task.yml: every agent must define 'role'");
    const count = roleCounts.get(agent.role) ?? 0;
    const next = (roleIndexes.get(agent.role) ?? 0) + 1;
    roleIndexes.set(agent.role, next);
    return {
      ...agent,
      name: agent.name ?? (count > 1 ? `${agent.role}-${next}` : agent.role),
      role: agent.role,
    } as AgentConfig;
  });
}

function parseTaskYaml(text: string): TaskConfig {
  // Minimal YAML parser — only handles the task.yml shape in
  // docs/synapse-spec-task-manifest.md, plus optional per-agent `focus`
  // single-line or `|` block scalar.
  // Format:
  //   synapse_version: 0.1.0
  //   workflow: hub-and-spoke
  //   goal: "Implement X"
  //   agents:
  //     - role: manager
  //     - role: coder
  //       focus: <single line>        # or:
  //       focus: |
  //         multi
  //         line
  const lines = text.split("\n");
  let synapseVersion = "";
  let workflow = "";
  let goal: string | null = null;
  const agents: Array<Partial<AgentConfig>> = [];
  let current: Partial<AgentConfig> | null = null;
  // While collecting a `focus: |` block scalar, lines indented further than
  // this column belong to it; the first such line establishes the column.
  let blockIndent: number | null = null;
  const blockLines: string[] = [];

  const flushBlock = () => {
    if (blockIndent !== null && current) {
      current.focus = blockLines.join("\n").replace(/\n+$/, "");
    }
    blockIndent = null;
    blockLines.length = 0;
  };
  const indentOf = (s: string) => s.length - s.replace(/^\s+/, "").length;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (blockIndent !== null) {
      if (line.trim() === "") {
        blockLines.push("");
        continue;
      }
      if (indentOf(line) >= blockIndent) {
        blockLines.push(line.slice(blockIndent));
        continue;
      }
      flushBlock();
      // fall through — this line starts something new, handled below
    }

    if (/^synapse_version:\s/.test(line)) {
      synapseVersion = unquoteYamlScalar(line.replace(/^synapse_version:\s+/, ""));
      continue;
    }
    if (/^workflow:\s/.test(line)) {
      workflow = unquoteYamlScalar(line.replace(/^workflow:\s+/, ""));
      continue;
    }
    if (/^goal:\s/.test(line)) {
      const value = unquoteYamlScalar(line.replace(/^goal:\s+/, ""));
      goal = value.length > 0 ? value : null;
      continue;
    }
    if (/^\s+-\s+role:\s/.test(line)) {
      if (current) agents.push(current);
      current = { role: unquoteYamlScalar(line.replace(/^\s+-\s+role:\s+/, "")) };
      continue;
    }
    if (/^\s+-\s+name:\s/.test(line)) {
      if (current) agents.push(current);
      current = { name: unquoteYamlScalar(line.replace(/^\s+-\s+name:\s+/, "")) };
      continue;
    }
    if (current && /^\s+name:\s/.test(line)) {
      current.name = unquoteYamlScalar(line.replace(/^\s+name:\s+/, ""));
      continue;
    }
    if (current && /^\s+role:\s/.test(line)) {
      current.role = unquoteYamlScalar(line.replace(/^\s+role:\s+/, ""));
      continue;
    }
    if (current && /^\s+focus:\s*\|\s*$/.test(line)) {
      blockIndent = indentOf(line) + 2; // YAML block scalars are conventionally +2
      blockLines.length = 0;
      continue;
    }
    if (current && /^\s+focus:\s/.test(line)) {
      current.focus = unquoteYamlScalar(line.replace(/^\s+focus:\s+/, ""));
      continue;
    }
    if (current && /^\s+model:\s/.test(line)) {
      current.model = unquoteYamlScalar(line.replace(/^\s+model:\s+/, ""));
      continue;
    }
  }
  flushBlock();
  if (current) agents.push(current);

  if (!synapseVersion) fail("task.yml: missing 'synapse_version' field");
  if (!workflow) fail("task.yml: missing 'workflow' field");
  if (workflow !== "hub-and-spoke") {
    fail(`task.yml: unsupported workflow '${workflow}'`);
  }
  if (agents.length === 0) fail("task.yml: no agents defined");
  const namedAgents = assignAgentNames(agents);
  const managers = namedAgents.filter((a) => a.role === "manager");
  if (managers.length !== 1) {
    fail("task.yml: hub-and-spoke workflow requires exactly one manager");
  }
  return { synapseVersion, workflow, goal, agents: namedAgents };
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

// Writes (overwrites) <absCwd>/CLAUDE.md, creating the directory if needed.
function writeAgentClaudeMd(absCwd: string, agent: AgentConfig): void {
  mkdirSync(absCwd, { recursive: true });
  writeFileSync(join(absCwd, "CLAUDE.md"), assembleClaudeMd(agent));
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
    SYNAPSE_DB='${synapseDb}' SYNAPSE_AGENT='${agent.name}' SYNAPSE_RUN_ID='${runId}' '${direnvPath}' exec '${projectRoot}' '${claudePath}' --session-id '${sessionId}' --dangerously-skip-permissions ${modelFlag}'${initialPrompt}'
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

export function cmdStart(configPath: string, flags: Record<string, string>) {
  let taskText: string;
  const defaultUserConfig = join(dirname(dbPath()), "task.yml");
  if (configPath !== DEFAULT_TASK_TEMPLATE) {
    // Explicit path provided — must exist.
    if (!existsSync(configPath)) fail(`task config not found: ${configPath}`);
    taskText = readFileSync(resolve(configPath), "utf8");
  } else if (existsSync(defaultUserConfig)) {
    // .synapse/task.yml exists — use it silently.
    taskText = readFileSync(defaultUserConfig, "utf8");
  } else {
    // No .synapse/task.yml yet — copy the built-in example there so the user
    // can edit it next time, then use it for this run.
    mkdirSync(dirname(defaultUserConfig), { recursive: true });
    writeFileSync(defaultUserConfig, TASK_EXAMPLE_YML, "utf8");
    console.log(`synapse: created ${defaultUserConfig} from built-in example — edit it to customise your team`);
    taskText = TASK_EXAMPLE_YML;
  }
  const config = parseTaskYaml(taskText);
  const goal = flags["goal"] ?? config.goal;
  const noMonitor = flags["no-monitor"] === "true";

  const dbFile = dbPath();
  const dataDir = dirname(dbFile);
  mkdirSync(dataDir, { recursive: true });

  // Init DB now so we can get a run id for the task folder name.
  cmdInit();
  const db = connect();

  const projectRoot = dirname(dirname(dbFile));
  const projectSlug = basename(projectRoot).slice(0, 3).toLowerCase().replace(/[^a-z0-9]/g, "x");

  // Reserve a run id so we can name the task folder, but keep status='pending'
  // until everything is ready. We delete this row on any failure so no orphan
  // runs accumulate.
  const runResult = db.run(
    `INSERT INTO runs (session, goal, status) VALUES ('', ?, 'pending')`,
    [goal ?? ""],
  );
  const runId = Number(runResult.lastInsertRowid);
  const pathHash = Bun.hash(projectRoot).toString(16).slice(0, 4);
  const taskName = `${projectSlug}-${pathHash}-${runId}`;
  const runFolderName = `run-${runId}`;

  const abort = (msg: string): never => {
    db.run(`DELETE FROM runs WHERE id=?`, [runId]);
    fail(msg);
  };

  // Create the durable run folder and copy task.yml into it with generated
  // links back to this run's scratch tree.
  const taskFolder = join(dataDir, "runs", runFolderName);
  const agentsDir = join(dataDir, "agents", runFolderName);
  mkdirSync(taskFolder, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(taskFolder, "task.yml"),
    appendGeneratedTaskFields(taskText, runId, workspaceRelativePath(agentsDir)),
  );
  console.log(`synapse: created run folder ${taskFolder}`);

  // Register operator pseudo-agent (run_id=0 = cross-run sentinel)
  db.run(
    `INSERT INTO agents (window_name, run_id, role, session_id, status, last_seen_at)
     VALUES ('operator', 0, 'operator', NULL, 'idle', ?)
     ON CONFLICT(window_name, run_id) DO UPDATE SET status='idle', last_seen_at=excluded.last_seen_at`,
    [nowIso()],
  );

  const tmuxSession = `-${taskName}`;

  const sessionExists = spawnTmux(["has-session", "-t", `=${tmuxSession}`]);
  if (sessionExists.exitCode === 0) {
    abort(
      `tmux session '${tmuxSession}' already exists — check for a stuck session (tmux kill-session -t ${tmuxSession}) and retry`,
    );
  }
  // Probe the calling terminal's dimensions; fall back to 220×50 if unavailable.
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
  // Rename the default window created with the session (base-index agnostic)
  spawnTmux(["rename-window", "-t", `=${tmuxSession}`, "monitor"]);
  // Use largest-client sizing so attaching a wide terminal fills the windows
  spawnTmux(["set-option", "-t", `=${tmuxSession}`, "window-size", "largest"]);

  const synapseCliPath = resolve(
    process.execPath === process.argv[0]
      ? process.argv[1] // running via bun src/synapse.ts
      : process.execPath, // compiled binary
  );

  // Resolve claude binary path at start time so tmux windows inherit it
  // even if their shell doesn't have the same PATH.
  const claudeWhich = Bun.spawnSync(["which", "claude"]);
  const claudePath =
    claudeWhich.exitCode === 0
      ? claudeWhich.stdout.toString().trim()
      : "claude";

  for (const agent of config.agents) {
    // Generate a UUID to pass as --session-id so we know it before launch.
    const sessionId = crypto.randomUUID();
    const absCwd = resolve(defaultAgentDir(runFolderName, agent.name));
    // Three-segment CLAUDE.md: generated in synapse-managed scratch from
    // templates plus this agent's task.yml `focus`.
    writeAgentClaudeMd(absCwd, agent);
    console.log(
      `synapse: launching window '${agent.name}' (${agent.role}) in ${absCwd}`,
    );
    launchAgentWindow(tmuxSession, runFolderName, agent, dbFile, claudePath, sessionId, runId, projectRoot);
    cmdRegister(agent.name, agent.role, sessionId, runId, agent.model ?? null);
  }

  // Start monitor in the 'monitor' tmux window
  if (!noMonitor) {
    const monitorCmd = `SYNAPSE_DB='${dbFile}' ${synapseCliPath} monitor --session ${tmuxSession} --run-id ${runId} 2>&1 | tee '${dbFile.replace(/synapse\.db$/, "monitor.log")}'`;
    const r = spawnTmux([
      "send-keys",
      "-t",
      `${tmuxSession}:monitor`,
      monitorCmd,
      "Enter",
    ]);
    if (r.exitCode !== 0) {
      console.error(
        `synapse: warning — failed to start monitor: ${r.stderr.toString().trim()}`,
      );
    } else {
      console.log(`synapse: monitor started in window '${tmuxSession}:monitor'`);
    }
  }

  // Send initial goal as TASK from operator to the manager agent, if provided.
  if (goal) {
    const manager = config.agents.find((a) => a.role === "manager")!;
    cmdSend(manager.name, "TASK", goal, "operator", null, runId);
    console.log(`synapse: initial goal queued as TASK to '${manager.name}'`);
  }

  // All agents launched successfully — commit the run as active.
  db.run(`UPDATE runs SET session=?, status='running' WHERE id=?`, [tmuxSession, runId]);

  console.log(
  );
  console.log(`  Attach: tmux attach -t ${tmuxSession}`);
  console.log(`  Status: synapse status`);
  console.log(
    `  Finish: SYNAPSE_RUN_ID=${runId} synapse done --status done "<summary>"  (manager calls this, not the operator)`,
  );
}


// The hub agent's signal that the root task has reached a terminal outcome
// (bootstrap-spec.md #8/#13). Writes the run's terminal state and sends the
// final REPLY back to operator. The monitor stays alive after terminal state
// and keeps dispatching operator follow-ups until the tmux session is killed.
export function cmdDone(
  status: string,
  summary: string,
  from: string | null,
  refIdFlag: number | null,
  runIdFlag: number | null,
) {
  const agent = resolveFrom(from);
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

  cmdSend("operator", "REPLY", summary, agent, refId, runId);
  console.log(
    `synapse: done — run ${runId ?? "?"} marked '${dbStatus}', final REPLY sent to operator`,
  );
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
