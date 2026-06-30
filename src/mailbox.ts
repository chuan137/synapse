import { connect } from "./db";
import { fail, nowIso, MESSAGE_TYPES, EVENT_TYPES, c, colorType } from "./commands";

export function cmdRegister(name: string, role: string, sessionId: string | null, runId?: number | null) {
  const db = connect();
  const resolvedRunId = runId ?? null;
  db.run(
    `INSERT INTO agents (window_name, run_id, role, session_id, status, last_seen_at)
     VALUES (?, ?, ?, ?, 'unknown', ?)
     ON CONFLICT(window_name, run_id) DO UPDATE SET
       role=excluded.role,
       session_id=excluded.session_id,
       status='unknown',
       last_seen_at=excluded.last_seen_at`,
    [name, resolvedRunId, role, sessionId, nowIso()],
  );
  console.log(
    `synapse: registered '${name}' (role=${role}, session_id=${sessionId ?? "-"})`,
  );
}

export function resolveFrom(from: string | null): string {
  const frm = from ?? process.env.SYNAPSE_AGENT;
  if (!frm) fail("missing sender — pass --from NAME or set SYNAPSE_AGENT");
  return frm;
}

export function cmdSend(
  to: string,
  type: string,
  body: string,
  from: string | null,
  refId: number | null,
  runId?: number | null,
) {
  if (!MESSAGE_TYPES.has(type)) {
    fail(`type must be one of ${[...MESSAGE_TYPES].sort()}, got '${type}'`);
  }
  const frm = resolveFrom(from);
  const db = connect();
  // Resolve run_id: explicit arg → SYNAPSE_RUN_ID env → null
  const resolvedRunId = runId !== undefined && runId !== null
    ? runId
    : (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  if (to !== "broadcast") {
    const known = resolvedRunId !== null
      ? db.query("SELECT 1 FROM agents WHERE window_name=? AND (run_id=? OR run_id=0)").get(to, resolvedRunId)
      : db.query("SELECT 1 FROM agents WHERE window_name=?").get(to);
    if (!known) {
      console.error(
        `synapse: warning — '${to}' not in agents registry yet (sending anyway)`,
      );
    }
  }
  const result = db.run(
    `INSERT INTO messages (run_id, from_agent, to_agent, type, ref_id, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [resolvedRunId, frm, to, type, refId, body],
  );
  console.log(
    `synapse: message ${result.lastInsertRowid} queued (${frm} -> ${to}, ${type}${
      refId ? ", ref=" + refId : ""
    }${resolvedRunId ? ", run=" + resolvedRunId : ""})`,
  );
}

export function cmdLog(agent: string, type: string, summary: string) {
  if (!EVENT_TYPES.has(type)) {
    console.error(
      `synapse: warning — '${type}' is outside the suggested vocab ${[
        ...EVENT_TYPES,
      ].sort()} (logging anyway)`,
    );
  }
  const db = connect();
  const result = db.run(
    "INSERT INTO events (agent, type, summary) VALUES (?, ?, ?)",
    [agent, type, summary],
  );
  console.log(
    `synapse: event ${result.lastInsertRowid} logged (${agent}, ${type})`,
  );
}

export function cmdStatus() {
  const db = connect();

  const activeRun =
    (db.query("SELECT id, session, status, goal FROM runs WHERE status='running' ORDER BY id DESC LIMIT 1").get() as any) ??
    (db.query("SELECT id, session, status, goal FROM runs ORDER BY id DESC LIMIT 1").get() as any);

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
         AND (to_agent=? OR to_agent='broadcast')
         AND run_id=?`,
      )
    : db.query(
        `SELECT COUNT(*) AS n FROM messages WHERE status='pending'
         AND (to_agent=? OR to_agent='broadcast')`,
      );

  if (activeRun) {
    const goal = (activeRun.goal ?? "").replace(/\n.*/s, "").slice(0, 72);
    console.log(`run #${activeRun.id}  ${activeRun.session}  [${activeRun.status}]${goal ? "  " + goal : ""}`);
    console.log("");
  }

  const headers = ["WINDOW", "ROLE", "STATUS", "LAST_SEEN", "PENDING"];
  const rows = agents.map((a) => {
    const pending = activeRun
      ? (pendingStmt.get(a.window_name, activeRun.id) as any).n
      : (pendingStmt.get(a.window_name) as any).n;
    return [
      a.window_name,
      a.role,
      a.status,
      a.last_seen_at ?? "-",
      String(pending),
    ];
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
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
  const headers = ["ID", "SESSION", "STATUS", "STARTED", "ENDED", "GOAL"];
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
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

export function cmdPending(agent: string | null, all?: boolean) {
  const db = connect();

  const activeRun = all ? null :
    (db.query("SELECT id FROM runs WHERE status='running' ORDER BY id DESC LIMIT 1").get() as any) ??
    (db.query("SELECT id FROM runs ORDER BY id DESC LIMIT 1").get() as any);

  const rows = agent
    ? (activeRun
        ? db.query(
            `SELECT * FROM messages WHERE status='pending'
             AND (to_agent=? OR to_agent='broadcast') AND run_id=? ORDER BY created_at`,
          ).all(agent, activeRun.id)
        : db.query(
            `SELECT * FROM messages WHERE status='pending'
             AND (to_agent=? OR to_agent='broadcast') ORDER BY created_at`,
          ).all(agent)
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
    "UPDATE messages SET status='delivered', delivered_at=? WHERE id=? AND status='pending'",
    [nowIso(), id],
  );
  if (result.changes === 0) fail(`no pending message with id=${id}`);
  console.log(`synapse: message ${id} marked delivered`);
}
