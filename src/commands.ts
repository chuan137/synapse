import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";import SHARED_MD from "../templates/shared.md" with { type: "text" };
import ROLE_MANAGER_MD from "../templates/role-manager.md" with { type: "text" };
import ROLE_CODER_MD from "../templates/role-coder.md" with { type: "text" };
import ROLE_REVIEWER_MD from "../templates/role-reviewer.md" with {
  type: "text",
};
import ROLE_TESTER_MD from "../templates/role-tester.md" with {
  type: "text",
};
import { connect, dbPath, defaultAgentDir, initDb } from "./db";
import { buildClaudeArgs } from "./launch-args";
import {
  markOperatorMessagesDelivered,
  newestOpenInboundWork,
  nudgeAgent,
  nudgeForPendingWork,
  readContextTokens,
  sendBackReminderBody,
} from "./monitor";
import { SKILLS } from "./skills.generated";
import { DEFAULT_TMUX_SESSION, fail, nowIso } from "./utils";

export { DEFAULT_TMUX_SESSION, fail, nowIso };

// Emit a Claude Code Stop-hook push notification by writing JSON to stdout.
// The hook contract: exit 0, print {"type":"notification","title":"…","message":"…"}.
// Only called from hook-stop context (the Stop hook reads stdout).
export function emitNotification(message: string, title = "Synapse"): void {
  process.stdout.write(JSON.stringify({ type: "notification", title, message }) + "\n");
}

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

export const DEFAULT_TASK_TEMPLATE = "templates/task.example.yml";

export const DEFAULT_MODEL_BY_ROLE: Record<string, string> = {
  manager: "opus",
  coder: "sonnet",
  reviewer: "opus",
  tester: "sonnet",
};

export const DEFAULT_MANAGER_MODEL = DEFAULT_MODEL_BY_ROLE["manager"];

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
  const projectRoot = dirname(dirname(dbPath()));
  migrateLegacyFolders(dirname(dbPath()));
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

// The lifecycle tags `synapse progress --tag` accepts. `step` is deliberately
// excluded — it's `synapse step`'s own notification, not a body prefix an
// agent should be generating by hand via this flag.
export const PROGRESS_TAGS = new Set(["start", "done", "blocked"]);

export function hasUnbrokenNumberedList(body: string): boolean {
  const matches = body.match(NUMBERED_MARKER_RE);
  if (!matches || matches.length < 2) return false;
  return !body.includes("\n");
}

// Looks up the message a REPLY would close, scoped to the run when known.
// Returns { from_agent, type } — from_agent is who a REPLY must go back to — or
// null if the message doesn't exist. Shared by cmdSend (enforcement), cmdReply
// (recipient resolution), and cmdPending (the reply hint).
export function replyTargetFor(
  db: any,
  refId: number,
  runId: number | null,
): { from_agent: string; type: string } | null {
  const row = runId !== null
    ? db.query("SELECT from_agent, type FROM messages WHERE id=? AND run_id=?").get(refId, runId)
    : db.query("SELECT from_agent, type FROM messages WHERE id=?").get(refId);
  return row ?? null;
}

// Canonical prefix a scout TASK's body must lead with — read by the coder to
// recognize a read-only investigation (see role-coder.md). Generated by
// --scout so the manager never has to hand-type (and possibly misphrase) it.
const SCOUT_BODY_PREFIX = "SCOUT (read-only, no code changes, no worktree).";

export function cmdSend(
  to: string,
  type: string,
  body: string,
  from: string | null,
  refId: number | null,
  runId?: number | null,
  options?: string[] | null,
  title?: string | null,
  reviewWaived?: boolean,
  testRequired?: boolean,
  isScout?: boolean,
) {
  if (!MESSAGE_TYPES.has(type)) {
    fail(`type must be one of ${[...MESSAGE_TYPES].sort()}, got '${type}'`);
  }
  if (isScout && testRequired) {
    fail("--scout and --test-required conflict: a scout produces no code, so there is nothing for a tester to run.");
  }
  if (isScout && !/^SCOUT\b/i.test(body)) {
    body = `${SCOUT_BODY_PREFIX}\n${body}`;
  }
  // A scout is read-only investigation, not a change — always waive review,
  // regardless of whether the caller also passed --no-review.
  if (isScout) reviewWaived = true;
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
  // Routing invariant: a REPLY closes the message named by ref-id and must go
  // back to that message's sender (protocol Rule 1). REPLYs can no longer be
  // sent via `synapse send` at all — the CLI rejects them — so every REPLY now
  // originates from cmdReply, which resolves the recipient from the DB and
  // cannot misroute. No routing guard is needed at this layer.
  const optionsJson = options && options.length > 0 ? JSON.stringify(options) : null;
  const result = db.run(
    `INSERT INTO messages (run_id, from_agent, to_agent, type, ref_id, body, options, title, review_waived, test_required, is_scout)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      resolvedRunId, frm, to, type, refId, body, optionsJson, title ?? null,
      reviewWaived ? 1 : null,
      testRequired ? 1 : null,
      isScout ? 1 : null,
    ],
  );
  const msgId = result.lastInsertRowid as number;

  // Create a subtask row for new manager→coder TASKs. Relay TASKs (where
  // ref_id points to a prior manager→coder TASK in the same run) are follow-up
  // instructions, not new work items, so they get no subtask row and are
  // invisible to the completion gate.
  let subtaskId: number | null = null;
  if (type === "TASK" && frm === "manager" && /^coder/.test(to) && resolvedRunId !== null) {
    const isRelay = refId !== null && refId !== undefined && !!db.query(
      `SELECT 1 FROM messages WHERE id=? AND type='TASK' AND from_agent='manager' AND to_agent LIKE 'coder%' LIMIT 1`,
    ).get(refId);
    if (!isRelay) {
      const sub = db.run(
        `INSERT INTO subtasks (run_id, task_msg_id, review_waived, test_required, is_scout) VALUES (?, ?, ?, ?, ?)`,
        [resolvedRunId, msgId, reviewWaived ? 1 : 0, testRequired ? 1 : 0, isScout ? 1 : 0],
      );
      subtaskId = sub.lastInsertRowid as number;
    }
  }

  console.log(
    `synapse: message ${msgId} queued (${frm} -> ${to}, ${type}${
      refId ? ", ref=" + refId : ""
    }${resolvedRunId ? ", run=" + resolvedRunId : ""}${subtaskId !== null ? `, subtask=${subtaskId}` : ""})`,
  );

  // Push-on-send: nudge an idle target immediately so it doesn't wait for the
  // sweep. Best-effort — enqueue already succeeded above, so any failure here
  // is silently swallowed. Guards: real run, deliverable type, not sending to
  // self or operator, target is idle.
  if (
    resolvedRunId !== null &&
    to !== frm &&
    to !== "operator" &&
    ["TASK", "QUESTION", "PROGRESS", "REPLY"].includes(type)
  ) {
    try {
      const targetAgent = db
        .query("SELECT status FROM agents WHERE window_name=? AND run_id=?")
        .get(to, resolvedRunId) as any;
      if (targetAgent?.status === "idle") {
        const tmuxSession = (
          db.query("SELECT session FROM runs WHERE id=?").get(resolvedRunId) as any
        )?.session;
        if (tmuxSession) {
          const log = (s: string) => process.stderr.write(`[send] ${s}\n`);
          nudgeForPendingWork(db, tmuxSession, to, resolvedRunId, log);
        }
      }
    } catch {
      // nudge failure must never surface to the caller
    }
  }
}

// Reply to a message by id, without naming the recipient: the recipient is the
// sender of message #refId, resolved from the DB. This makes a misrouted REPLY
// structurally impossible — the caller can't pick the wrong agent because it
// never picks one. The only input the agent supplies is the ref-id, which
// `synapse pending` prints for every open item.
export function cmdReply(
  refId: number,
  body: string,
  from: string | null,
  runId?: number | null,
) {
  const db = connect();
  const resolvedRunId = runId !== undefined && runId !== null
    ? runId
    : (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  const ref = replyTargetFor(db, refId, resolvedRunId);
  if (!ref || !ref.from_agent) {
    fail(
      `no message #${refId}${resolvedRunId ? ` in run ${resolvedRunId}` : ""} to reply to. ` +
        `Check the id — 'synapse pending' lists open messages and their ids.`,
    );
  }
  cmdSend(ref!.from_agent, "REPLY", body, from, refId, resolvedRunId);
}

export const HANDOFF_KINDS = new Set(["spec", "plan", "testplan", "review", "notes"]);

// Write handoff/doc content to its canonical artifact path and return the
// repo-relative path (for folding into a message body). The run folder is
// derived from runId, never guessed — this is the whole reason artifact
// placement is owned here rather than hand-computed by agents. Shared by the
// `--handoff <kind>:<file>` flag on the message verbs and the write-only
// `synapse doc` command.
export function writeArtifact(
  kind: string,
  refId: number,
  content: string,
  runId: number,
): string {
  const dataDir = dirname(dbPath());
  const relPath = join(".synapse", "artifacts", `run-${runId}`, `${refId}-${kind}.md`);
  const absPath = join(dataDir, "artifacts", `run-${runId}`, `${refId}-${kind}.md`);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content.endsWith("\n") ? content : content + "\n");
  if (kind === "plan") {
    storePlanSteps(refId, content, runId);
  }
  return relPath;
}

// Parse the ## Plan checklist from a plan doc and upsert rows into plan_steps.
// Lines matching `- [ ] <text>` under the `## Plan` heading are steps; order
// is their 1-based position in that section.
export function storePlanSteps(rootMsgId: number, content: string, runId: number): void {
  const db = connect();
  const steps = parsePlanSteps(content);
  if (steps.length === 0) {
    process.stderr.write(`synapse: plan doc has no '- [ ]' steps under ## Plan — plan_steps not populated\n`);
    return;
  }
  const insert = db.prepare(
    `INSERT INTO plan_steps (run_id, root_msg_id, step_index, label)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id, root_msg_id, step_index) DO UPDATE SET label=excluded.label`
  );
  for (const { index, label } of steps) {
    insert.run(runId, rootMsgId, index, label);
  }
}

export function parsePlanSteps(content: string): { index: number; label: string }[] {
  const lines = content.split("\n");
  let inPlanSection = false;
  const steps: { index: number; label: string }[] = [];
  for (const line of lines) {
    if (/^##\s+Plan\s*$/.test(line.trim())) { inPlanSection = true; continue; }
    if (inPlanSection && /^##\s/.test(line)) break;
    if (inPlanSection) {
      const m = line.match(/^[-*]\s+\[\s*[ x]?\s*\]\s+(.+)$/);
      if (m) steps.push({ index: steps.length + 1, label: m[1].trim() });
    }
  }
  return steps;
}

// Tick a plan step done and emit a progress notification.
export function cmdStep(
  rootMsgId: number,
  stepIndex: number,
  updateText: string,
  from: string | null,
  runId: number | null,
): void {
  const db = connect();
  const resolvedRunId = runId ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  if (resolvedRunId === null || Number.isNaN(resolvedRunId)) {
    fail("step needs a run id — set SYNAPSE_RUN_ID or pass --run-id N.");
  }
  const step = db.query(
    "SELECT * FROM plan_steps WHERE run_id=? AND root_msg_id=? AND step_index=?"
  ).get(resolvedRunId, rootMsgId, stepIndex) as any;
  if (!step) {
    fail(
      `no step ${stepIndex} for root-id ${rootMsgId} in run ${resolvedRunId}. ` +
      `Check the index — steps are 1-based and only exist if the plan was written with 'synapse doc plan'.`
    );
  }
  const now = nowIso();
  const agent = from ?? process.env.SYNAPSE_AGENT ?? "agent";
  db.run(
    "UPDATE plan_steps SET completed_at=?, update_text=?, agent=? WHERE run_id=? AND root_msg_id=? AND step_index=?",
    [now, updateText, agent, resolvedRunId, rootMsgId, stepIndex]
  );
  const total = (db.query(
    "SELECT COUNT(*) AS n FROM plan_steps WHERE run_id=? AND root_msg_id=?"
  ).get(resolvedRunId, rootMsgId) as any).n;
  const done = (db.query(
    "SELECT COUNT(*) AS n FROM plan_steps WHERE run_id=? AND root_msg_id=? AND completed_at IS NOT NULL"
  ).get(resolvedRunId, rootMsgId) as any).n;
  console.log(`synapse: step ${stepIndex} marked done (${done}/${total} steps complete)`);
  // No emitNotification here: this runs as a plain CLI invocation from the
  // agent's own Bash tool, not as the Stop hook subprocess, so stdout here
  // never reaches the operator (see emitNotification's doc comment). The
  // Stop hook (cmdHookStop) picks this row up from plan_steps instead, once
  // the agent's turn actually ends.
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
    // TASK/QUESTION addressed to this agent expects a reply back to its sender.
    // Print the exact command so the agent never has to name a recipient (and so
    // can't misroute it) — it only needs this id, shown here.
    if (targetAgent && r.to_agent === targetAgent && (r.type === "TASK" || r.type === "QUESTION")) {
      // A review TASK (to a reviewer, carrying the coder subtask as ref_id) is
      // closed with a REPLY that attaches the review doc — the reply-pair on
      // this id is what the completion gate looks for.
      if (r.type === "TASK" && targetAgent.startsWith("reviewer") && r.ref_id) {
        console.log(`      ${c.dim}↳ close with: synapse reply ${r.id} "LGTM|issues found" --handoff review:<file>${c.reset}`);
      } else {
        console.log(`      ${c.dim}↳ reply with: synapse reply ${r.id} "<result>"${c.reset}`);
      }
    }
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

// Injects the synapse hook-stop Stop hook into <absCwd>/.claude/settings.json.
// Merges with any existing content; idempotent — won't duplicate an existing entry.
function injectStopHook(absCwd: string, agentName: string, runId: number, dbFile: string): void {
  const settingsPath = join(absCwd, ".claude", "settings.json");
  let settings: any = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {}
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  const hookCmd = `SYNAPSE_DB='${dbFile}' SYNAPSE_AGENT='${agentName}' SYNAPSE_RUN_ID='${runId}' synapse hook-stop`;
  const alreadyPresent = settings.hooks.Stop.some((entry: any) =>
    entry.hooks?.some((h: any) => h.command === hookCmd)
  );
  if (!alreadyPresent) {
    settings.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: hookCmd }] });
  }
  mkdirSync(join(absCwd, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
  workdir: string,
  headroom?: boolean,
): void {
  const absCwd = resolve(defaultAgentDir(taskName, agent.name));
  presetClaudeTrust(absCwd);
  injectStopHook(absCwd, agent.name, runId, synapseDb);

  // Use direnv exec to load the project root's .envrc (if any), giving each
  // agent the env that matches the project directory rather than inheriting
  // whatever the launching shell had (e.g. a ~/ccloud direnv that sets
  // ANTHROPIC_BASE_URL to an enterprise proxy).
  const direnvPath = Bun.spawnSync(["which", "direnv"]).stdout.toString().trim() || "direnv";
  const claudeArgs = buildClaudeArgs(sessionId, agent.model, `synapse pending ${agent.name}`);
  // Shell-quote each arg; none contain single quotes, so this is safe.
  const quotedArgs = claudeArgs.map((a) => `'${a}'`).join(" ");
  // Use `headroom wrap claude` to route API calls through the compression proxy,
  // unless an *external* ANTHROPIC_BASE_URL is set (enterprise proxy) or headroom is disabled.
  // A second `headroom wrap` call reuses the already-running proxy rather than starting a new one.
  // We must NOT skip when ANTHROPIC_BASE_URL is already a localhost headroom URL — that happens
  // when the manager (itself headroom-wrapped) spawns coders/reviewers, and the env var is inherited.
  // Skipping in that case is the bug: spawned agents would launch plain claude with no wrapping.
  const inheritedBase = process.env.ANTHROPIC_BASE_URL ?? "";
  const isHeadroomProxy = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(inheritedBase);
  const useHeadroom = headroom && (!inheritedBase || isHeadroomProxy);
  const headroomBin = useHeadroom
    ? (Bun.spawnSync(["which", "headroom"]).stdout.toString().trim() || "headroom")
    : null;
  const launchCmd = useHeadroom
    ? `'${headroomBin}' wrap claude -- ${quotedArgs}`
    : `'${claudePath}' ${quotedArgs}`;
  const shellCmd = `
    cd '${absCwd}' || exit 1
    SYNAPSE_DB='${synapseDb}' SYNAPSE_AGENT='${agent.name}' SYNAPSE_RUN_ID='${runId}' SYNAPSE_PROJECT_ROOT='${projectRoot}' SYNAPSE_WORKDIR='${workdir}' '${direnvPath}' exec '${projectRoot}' ${launchCmd}
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

export function migrateLegacyFolders(dataDir: string) {
  for (const [oldName, newName] of [["runs", "artifacts"], ["agents", "workdirs"]] as const) {
    const oldPath = join(dataDir, oldName);
    const newPath = join(dataDir, newName);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      renameSync(oldPath, newPath);
      console.log(`synapse: migrated ${oldName}/ → ${newName}/`);
    }
  }
}

export function cmdStart(flags: Record<string, string>) {
  const goal = flags["goal"];
  if (!goal) fail("--goal is required");
  const noMonitor = flags["no-monitor"] === "true";
  const headroom = !flags["no-headroom"];
  const managerModel = flags["manager-model"] ?? DEFAULT_MANAGER_MODEL;

  const dbFile = dbPath();
  const dataDir = dirname(dbFile);
  mkdirSync(dataDir, { recursive: true });

  cmdInit();
  const db = connect();

  const projectRoot = dirname(dirname(dbFile));
  const workdir = flags["workdir"] ? resolve(flags["workdir"]) : projectRoot;
  if (flags["workdir"] && !existsSync(workdir)) {
    fail(`--workdir '${workdir}' does not exist`);
  }
  const projectSlug = basename(projectRoot).slice(0, 3).toLowerCase().replace(/[^a-z0-9]/g, "x");

  const runResult = db.run(
    `INSERT INTO runs (session, goal, workdir, status) VALUES ('', ?, ?, 'pending')`,
    [goal, workdir],
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
  launchAgentWindow(tmuxSession, runFolderName, manager, dbFile, claudePath, sessionId, runId, projectRoot, workdir, headroom);
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
  // The manager owns run closure (calls `synapse done` itself once every
  // subtask chain is terminal). This is only an operator-side override.
  console.log(`  Force-close (override): SYNAPSE_AGENT=operator SYNAPSE_RUN_ID=${runId} synapse done --status done --force --reason "<why>"`);
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
  const name = count === 0 ? role : `${role}-${count}`;

  const dbFile = dbPath();
  const projectRoot = dirname(dirname(dbFile));
  const workdir = (run.workdir as string | null) ?? projectRoot;

  const claudeWhich = Bun.spawnSync(["which", "claude"]);
  const claudePath = claudeWhich.exitCode === 0 ? claudeWhich.stdout.toString().trim() : "claude";

  const sessionId = crypto.randomUUID();

  const effectiveModel = flags["model"] ?? DEFAULT_MODEL_BY_ROLE[role];
  const agent: AgentConfig = { role, name, model: effectiveModel, focus: flags["focus"] };

  const absCwd = resolve(defaultAgentDir(runFolderName, name));
  writeAgentClaudeMd(absCwd, agent);

  launchAgentWindow(tmuxSession, runFolderName, agent, dbFile, claudePath, sessionId, run.id, projectRoot, workdir, !flags["no-headroom"]);
  cmdRegister(name, role, sessionId, run.id, effectiveModel ?? null);

  console.log(`synapse: spawned '${name}' (${role}) in run #${run.id}, window '${tmuxSession}:${name}'`);
}

// The hub agent's signal that the root task has reached a terminal outcome
// (bootstrap-spec.md #8/#13). Writes the run's terminal state and sends the
// final REPLY back to operator. The monitor stays alive after terminal state
// and keeps dispatching operator follow-ups until the tmux session is killed.
// A subtask row (created by cmdSend when manager dispatches to a coder) is
// "open" until the coder replies to its task_msg_id AND — unless review was
// waived — a reviewer closes it. Reading from the subtasks table instead of
// inferring topology from ref_id chains means follow-up relay TASKs
// (e.g. "please merge") are invisible to the gate because they create no row.
export function openChains(
  db: ReturnType<typeof connect>,
  runId: number | null,
): { subtaskId: number; reason: string }[] {
  const subtasks = (runId !== null
    ? db.query(`SELECT id, task_msg_id, review_waived FROM subtasks WHERE run_id=?`).all(runId)
    : db.query(`SELECT id, task_msg_id, review_waived FROM subtasks`).all()) as any[];

  const open: { subtaskId: number; reason: string }[] = [];
  for (const s of subtasks) {
    const reportedDone = !!db.query(
      `SELECT 1 FROM messages WHERE ref_id=? AND type='REPLY' AND to_agent='manager' LIMIT 1`,
    ).get(s.task_msg_id);
    if (!reportedDone) {
      open.push({ subtaskId: s.id, reason: "coder has not reported done (no REPLY to manager)" });
      continue;
    }
    if (s.review_waived) continue;
    // Reviewer TASK carries ref_id = subtask.id (new convention) or task_msg_id
    // (old convention, for runs that predate v18). Accept either.
    const reviewed = !!db.query(
      `SELECT 1 FROM messages rt JOIN messages rr ON rr.ref_id=rt.id
       WHERE (rt.ref_id=? OR rt.ref_id=?) AND rt.type='TASK' AND rt.to_agent LIKE 'reviewer%'
         AND rr.type='REPLY' AND rr.from_agent LIKE 'reviewer%' LIMIT 1`,
    ).get(s.id, s.task_msg_id);
    if (!reviewed) {
      open.push({ subtaskId: s.id, reason: "not reviewed (no reviewer verdict; pass --no-review on the TASK to waive)" });
    }
  }
  return open;
}

// Git-side evidence that each subtask was actually merged and cleaned up.
// The coder names its worktree/branch `subtask-<S>` after the subtask id.
// A leftover worktree or an unmerged branch means "done" was reported without
// the merge — so the gate holds on it. Skips silently when the project isn't
// a git repo or has no `main` branch.
export function worktreeIssues(
  db: ReturnType<typeof connect>,
  runId: number | null,
): { subtaskId: number; reason: string }[] {
  const projectRoot = dirname(dirname(dbPath()));
  const git = (args: string[]) => Bun.spawnSync({ cmd: ["git", "-C", projectRoot, ...args] });
  if (git(["rev-parse", "--git-dir"]).exitCode !== 0) return [];
  if (git(["rev-parse", "--verify", "--quiet", "refs/heads/main"]).exitCode !== 0) return [];

  const subtasks = (runId !== null
    ? db.query(`SELECT id FROM subtasks WHERE run_id=?`).all(runId)
    : db.query(`SELECT id FROM subtasks`).all()) as any[];
  if (subtasks.length === 0) return [];

  const mergedOut = git(["branch", "--merged", "main"]);
  const merged = new Set(
    mergedOut.exitCode === 0
      ? mergedOut.stdout.toString().split("\n").map((l) => l.replace(/^[*+ ]+/, "").trim()).filter(Boolean)
      : [],
  );

  const issues: { subtaskId: number; reason: string }[] = [];
  for (const s of subtasks) {
    const branch = `subtask-${s.id}`;
    if (existsSync(join(projectRoot, ".worktrees", branch))) {
      issues.push({ subtaskId: s.id, reason: `worktree .worktrees/${branch} not removed (merge + cleanup incomplete)` });
      continue;
    }
    const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
    if (branchExists && !merged.has(branch)) {
      issues.push({ subtaskId: s.id, reason: `branch ${branch} exists but is not merged into main` });
    }
  }
  return issues;
}

export function cmdDone(
  status: string,
  summary: string | null,
  from: string | null,
  refIdFlag: number | null,
  runIdFlag: number | null,
  force?: boolean,
) {
  const agent = resolveFrom(from);
  const resolvedSummary = summary || "Run marked done.";
  const dbStatus = status === "failed" ? "failed" : "completed";

  const db = connect();
  const runId = runIdFlag ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);

  // Completion gate: refuse to close a still-open run unless failing or forced.
  // Only meaningful when we can scope to a run and are marking it done.
  if (dbStatus === "completed" && runId !== null && !Number.isNaN(runId)) {
    const chains = openChains(db, runId);
    // Add git-side merge evidence, but don't double-report a subtask already
    // flagged for an incomplete chain (fix the chain first, re-run, and the
    // worktree issue surfaces then if still present).
    const flagged = new Set(chains.map((c) => c.subtaskId));
    const open = [...chains, ...worktreeIssues(db, runId).filter((w) => !flagged.has(w.subtaskId))];
    if (open.length > 0) {
      if (!force) {
        fail(
          `run ${runId} has ${open.length} open subtask chain(s) — not closing:\n` +
            open.map((o) => `  #${o.subtaskId}: ${o.reason}`).join("\n") +
            `\nRelay/close them, or re-run with --force --reason "<why>" to override.`,
        );
      }
      // Forced past open chains — record it so the override is auditable.
      db.run(
        `INSERT INTO events (agent, type, summary, run_id) VALUES (?, 'decision', ?, ?)`,
        [
          agent,
          `forced done past ${open.length} open chain(s): ` +
            open.map((o) => `#${o.subtaskId} (${o.reason})`).join("; ") +
            (summary ? ` — reason: ${summary}` : ""),
          runId,
        ],
      );
      console.error(
        `synapse: warning — forcing done past ${open.length} open chain(s); logged to events.`,
      );
    }
  }

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

export function cmdStop(name: string, explicitSession: string | undefined, runId?: number) {
  const db = connect();
  const resolvedRunId = runId ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  const agent = resolvedRunId !== null
    ? db.query("SELECT * FROM agents WHERE window_name=? AND run_id=?").get(name, resolvedRunId) as any
    : db.query("SELECT * FROM agents WHERE window_name=?").get(name) as any;
  if (!agent) fail(`no registered agent named '${name}'${resolvedRunId !== null ? ` in run ${resolvedRunId}` : ""}`);

  const tmuxSession = explicitSession
    ?? (db.query("SELECT session FROM runs WHERE id=?").get(agent.run_id) as any)?.session;
  if (!tmuxSession) fail(`cannot resolve tmux session for agent '${name}' (run_id=${agent.run_id})`);

  const killResult = Bun.spawnSync([
    "tmux",
    "kill-window",
    "-t",
    `=${tmuxSession}:${name}`,
  ]);
  if (killResult.exitCode !== 0) {
    const stderr = killResult.stderr.toString().trim();
    // Verify the window is actually still present — only block the DB flip if it is.
    // If tmux isn't running or the window is already gone, treat as successfully stopped.
    const checkResult = Bun.spawnSync(["tmux", "list-windows", "-t", `=${tmuxSession}`, "-F", "#{window_name}"]);
    if (checkResult.exitCode === 0) {
      const windows = checkResult.stdout.toString().split("\n").map(l => l.trim()).filter(Boolean);
      if (windows.includes(name)) {
        console.error(`synapse: warning — tmux kill-window failed: ${stderr} (agent not marked stopped)`);
        return;
      }
    }
    // Window is gone (or tmux not running) — safe to mark stopped
    if (stderr) console.error(`synapse: warning — tmux kill-window: ${stderr}`);
  }

  db.run(
    "UPDATE agents SET status='stopped', last_seen_at=? WHERE window_name=? AND run_id=?",
    [nowIso(), name, agent.run_id],
  );
  console.log(`synapse: agent '${name}' stopped`);
}

export function cmdAttach(name: string, explicitSession: string | undefined) {
  const db = connect();
  const agent = db.query("SELECT * FROM agents WHERE window_name=?").get(name) as any;
  const tmuxSession = explicitSession
    ?? (agent ? (db.query("SELECT session FROM runs WHERE id=?").get(agent.run_id) as any)?.session : undefined);
  if (!tmuxSession) fail(`cannot resolve tmux session for agent '${name}'`);

  const result = Bun.spawnSync(
    ["tmux", "attach-session", "-t", `=${tmuxSession}:${name}`],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) {
    fail(`tmux attach failed: ${result.stderr?.toString().trim()}`);
  }
}

export function cmdHookStop(agentName: string, runId: number): void {
  const path = dbPath();
  if (!existsSync(path)) {
    process.stderr.write(`[hook-stop] DB not found at ${path}\n`);
    return;
  }
  let db;
  try {
    db = connect();
  } catch (err) {
    process.stderr.write(`[hook-stop] DB unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const log = (s: string) => process.stderr.write(`[hook-stop] ${s}\n`);

  try {
    const agent = db.query("SELECT * FROM agents WHERE window_name=? AND run_id=?")
      .get(agentName, runId) as any;
    if (!agent || agent.status === "stopped") return;

    const tmuxSession = (db.query("SELECT session FROM runs WHERE id=?").get(runId) as any)?.session;
    if (!tmuxSession) return;

    // Update context tokens from transcript
    if (agent.session_id && agent.session_id !== "-") {
      const ctx = readContextTokens(agent.session_id);
      if (ctx !== null) db.run("UPDATE agents SET context_tokens=? WHERE id=?", [ctx, agent.id]);
    }

    // Send-back enforcement takes priority — check before pending messages
    const open = newestOpenInboundWork(db, agent, runId);
    if (open) {
      nudgeAgent(tmuxSession, agentName, sendBackReminderBody(agentName, open), log);
      db.run("UPDATE agents SET sendback_nudged_at=? WHERE window_name=? AND run_id=?",
        [nowIso(), agentName, runId]);
      return;
    }

    // Notify operator about messages this agent sent, and plan steps it ticked
    // via `synapse step`, since last notification. Only fires on end_turn turns
    // (the hook only reaches here when the agent is idle), so tool-use mid-task
    // turns are already excluded. `synapse step` itself can't emit this
    // notification — it runs as a plain CLI call from the agent's own Bash
    // tool, not as this Stop hook subprocess — so completed steps sit in
    // plan_steps until picked up here.
    const since = agent.last_notified_at ?? "1970-01-01T00:00:00";
    const newMsgs = db.query(
      `SELECT type, to_agent, body FROM messages
       WHERE from_agent=? AND run_id=? AND created_at > ? ORDER BY created_at`
    ).all(agentName, runId, since) as { type: string; to_agent: string; body: string }[];
    const newSteps = db.query(
      `SELECT step_index, update_text FROM plan_steps
       WHERE agent=? AND run_id=? AND completed_at > ? ORDER BY completed_at`
    ).all(agentName, runId, since) as { step_index: number; update_text: string }[];
    if (newMsgs.length > 0 || newSteps.length > 0) {
      const lines = [
        ...newMsgs.map((m) => {
          const preview = m.body.split("\n")[0].slice(0, 80);
          return `${m.type} → ${m.to_agent}: ${preview}`;
        }),
        ...newSteps.map((s) => `step ${s.step_index}: ${(s.update_text ?? "").split("\n")[0].slice(0, 80)}`),
      ];
      emitNotification(lines.join("\n"), `[${agentName}]`);
      db.run("UPDATE agents SET last_notified_at=? WHERE window_name=? AND run_id=?",
        [nowIso(), agentName, runId]);
    }

    // Check for pending messages — route through shared DB-cooled nudge so hook
    // and sweep never double-nudge the same pending set. Returns false when
    // cooldown suppressed the nudge or when there's no pending work at all.
    const hasPending = !!db.query(
      "SELECT 1 FROM messages WHERE status='pending' AND to_agent=? AND run_id=? LIMIT 1"
    ).get(agentName, runId);
    if (hasPending) {
      nudgeForPendingWork(db, tmuxSession, agentName, runId, log);
      return;
    }

    // No work — agent is truly idle
    db.run(
      "UPDATE agents SET status='idle', last_seen_at=? WHERE window_name=? AND run_id=? AND status != 'stopped'",
      [nowIso(), agentName, runId],
    );
    markOperatorMessagesDelivered(db, runId, log);
  } catch (err) {
    process.stderr.write(`[hook-stop] error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
