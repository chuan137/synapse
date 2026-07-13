import { mkdirSync, readFileSync, watch } from "fs";
import bundledHtml from "../public/index.html" with { type: "text" };
import bundledCss from "../public/styles.css" with { type: "text" };
import bundledJs from "../public/app.js" with { type: "text" };
import { basename, dirname, join, relative, resolve } from "path";
import {
  cmdDone,
  DEFAULT_TASK_TEMPLATE,
  MESSAGE_TYPES,
  nowIso,
} from "./commands";
import { connect, dbPath } from "./db";
import { disbandTeam } from "./monitor";

/** Try to raise the terminal window on macOS using AppleScript. Best-effort; swallows errors. */
function raiseTerminal(): void {
  const TERMINALS = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'Alacritty', 'kitty'];
  // Detect the running terminal via System Events, then activate it in a separate
  // tell block to avoid iTerm2 race where nested tell fires before System Events resolves.
  const script = `
tell application "System Events"
  set runningNames to name of every process whose background only is false
end tell
repeat with appName in {${TERMINALS.map(t => `"${t}"`).join(', ')}}
  if runningNames contains appName then
    set appStr to appName as text
    tell application appStr
      activate
      reopen
    end tell
    return appStr
  end if
end repeat`;
  try {
    const result = Bun.spawnSync(["osascript", "-e", script]);
    if (result.exitCode === 0) {
      const raised = new TextDecoder().decode(result.stdout).trim();
      if (raised) process.stderr.write(`[Synapse] raised ${raised}\n`);
    }
  } catch { /* AppleScript failed, not fatal */ }
}

type PublicAsset = "index.html" | "styles.css" | "app.js";

// In dev mode (SYNAPSE_DEV=1), UI assets are read from disk on every request.
// When running as a compiled binary, import.meta.filename is a virtual /$bunfs
// path, so resolve relative to the real executable instead.
function resolvePublicAssetPath(file: PublicAsset): string {
  const base = dirname(import.meta.filename);
  if (base.startsWith("/$bunfs")) {
    // compiled binary: binary lives at <project>/bin/synapse; assets at <project>/public/*
    return resolve(dirname(process.execPath), "../public", file);
  }
  // bun build script (base == bin/) or bun run source (base == src/) —
  // public/ is one level up from either
  return resolve(base, "../public", file);
}

const PUBLIC_ASSETS: Record<PublicAsset, { path: string; bundled: string; contentType: string }> = {
  "index.html": {
    path: resolvePublicAssetPath("index.html"),
    bundled: bundledHtml,
    contentType: "text/html; charset=utf-8",
  },
  "styles.css": {
    path: resolvePublicAssetPath("styles.css"),
    bundled: bundledCss,
    contentType: "text/css; charset=utf-8",
  },
  "app.js": {
    path: resolvePublicAssetPath("app.js"),
    bundled: bundledJs,
    contentType: "application/javascript; charset=utf-8",
  },
};

function publicAssetResponse(file: PublicAsset, dev: boolean): Response {
  const asset = PUBLIC_ASSETS[file];
  const body = dev ? readFileSync(asset.path, "utf8") : asset.bundled;
  return new Response(body, {
    headers: { "Content-Type": asset.contentType },
  });
}

function synapseCommand(): string[] {
  if (process.execPath === process.argv[0]) {
    return [process.execPath, process.argv[1]];
  }
  return [process.execPath];
}

export function startUi(port: number, dev = false) {
  dev = dev || !!process.env.SYNAPSE_DEV;
  const db = connect();

  const lastMessageId = new Map<number, number>(); // runId -> last seen msg id
  const lastManagerMsgId = new Map<number, number>(); // runId -> last seen messages.id for manager→coder TASKs

  // SSE client registry
  const clients = new Set<ReadableStreamDefaultController>();

  function pushToAll(eventName: string, data: unknown) {
    const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  function push(ctrl: ReadableStreamDefaultController, eventName: string, data: unknown) {
    ctrl.enqueue(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function pushReload() {
    const chunk = `event: reload\ndata: {}\n\n`;
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  function activeRun() {
    return (
      (db
        .query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
           FROM runs
           WHERE status='running'
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as any) ??
      (db
        .query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
           FROM runs
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as any) ??
      null
    );
  }

  function operatorThreadMessages(run: any) {
    if (!run) {
      return db
        .query(
          `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
           FROM messages
           WHERE (from_agent='operator' OR to_agent='operator')
           ORDER BY id DESC LIMIT 200`,
        )
        .all()
        .reverse();
    }
    return db
      .query(
        `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
         FROM messages
         WHERE (from_agent='operator' OR to_agent='operator')
           AND run_id = ?
         ORDER BY id DESC LIMIT 200`,
      )
      .all(run.id)
      .reverse();
  }

  function managerActivityForRun(runId: number | null): any[] {
    if (!runId) return [];
    // from_agent is always 'manager' here (see WHERE below) but is selected
    // explicitly so buildActivityMarker on the frontend can render a sender
    // badge off one uniform field, same as the direct-PROGRESS messages that
    // now also flow through the activity marker renderer (see
    // docs/progress-direct-signal-spec.md decision 4) — no special-casing
    // "this feed implies manager" in the client.
    return db.query(
      `SELECT 'message' AS source, m.id, m.type, m.body, m.created_at, m.from_agent, m.to_agent
       FROM messages m
       WHERE m.from_agent = 'manager'
         AND m.to_agent != 'operator'
         AND m.run_id = ?
       ORDER BY created_at`,
    ).all(runId) as any[];
  }

  function pushOperatorThread(ctrl: ReadableStreamDefaultController) {
    const run = activeRun();
    const messages = operatorThreadMessages(run);
    const managerActivity = managerActivityForRun(run?.id ?? null);
    const chunk = `event: operator-thread\ndata: ${JSON.stringify({ run, messages, managerActivity })}\n\n`;
    ctrl.enqueue(chunk);
  }

  function pollDb() {
    // 1. All running runs
    const runningRuns = db.query(
      `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
       FROM runs WHERE status='running' ORDER BY id DESC LIMIT 10`
    ).all() as any[];

    for (const run of runningRuns) {
      const agents = db.query(
        `SELECT window_name, role, model, status, last_seen_at, context_tokens,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.status='pending' AND m.to_agent=a.window_name
                   AND m.run_id = ?) AS pending_count
         FROM agents a
         WHERE (run_id=? OR run_id=0) AND window_name != 'operator'
         ORDER BY role, window_name`,
      ).all(run.id, run.id);
      pushToAll("agent-status", { run_id: run.id, agents });

      const lastId = lastMessageId.get(run.id) ?? 0;
      const newMessages = db.query(
        `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
         FROM messages
         WHERE id > ?
           AND (from_agent='operator' OR to_agent='operator')
           AND run_id = ?
         ORDER BY id`,
      ).all(lastId, run.id) as any[];
      if (newMessages.length > 0) {
        lastMessageId.set(run.id, (newMessages[newMessages.length - 1] as any).id);
        for (const msg of newMessages) {
          pushToAll("message-stream", msg);
        }
      }

      const lastDelegateId = lastManagerMsgId.get(run.id) ?? 0;
      const newDelegations = db.query(
        `SELECT 'message' AS source, m.id AS id, m.type AS type, m.body, m.created_at, m.from_agent
         FROM messages m
         WHERE m.from_agent = 'manager'
           AND m.to_agent != 'operator'
           AND m.run_id = ?
           AND m.id > ?
         ORDER BY m.created_at`,
      ).all(run.id, lastDelegateId) as any[];
      if (newDelegations.length > 0) {
        lastManagerMsgId.set(run.id, (newDelegations[newDelegations.length - 1] as any).id);
      }

      if (newDelegations.length > 0) {
        pushToAll("manager-activity-stream", { run_id: run.id, items: newDelegations });
      }
    }

    // 2. Push runs-list (all runs, not just running)
    const allRuns = db.query(
      `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
       FROM runs ORDER BY id DESC LIMIT 20`
    ).all();
    pushToAll("runs-list", { runs: allRuns });
  }

  const pollTimer = setInterval(pollDb, 1000);

  // Dev mode: watch src/public assets and push reload to clients on change.
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  if (dev) {
    const watchers: ReturnType<typeof watch>[] = [];
    try {
      for (const asset of Object.values(PUBLIC_ASSETS)) {
        watchers.push(watch(asset.path, () => {
          if (reloadDebounce) clearTimeout(reloadDebounce);
          reloadDebounce = setTimeout(() => {
            console.log("synapse ui: public asset changed — pushing reload");
            pushReload();
            reloadDebounce = null;
          }, 150);
        }));
      }
      process.on("SIGINT",  () => { watchers.forEach(w => w.close()); shutdown(); });
      process.on("SIGTERM", () => { watchers.forEach(w => w.close()); shutdown(); });
      console.log(`synapse ui: dev mode — watching ${dirname(PUBLIC_ASSETS["index.html"].path)}`);
    } catch {
      watchers.forEach(w => w.close());
      process.on("SIGINT",  shutdown);
      process.on("SIGTERM", shutdown);
    }
  } else {
    process.on("SIGINT",  shutdown);
    process.on("SIGTERM", shutdown);
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" && req.method === "GET") {
        return publicAssetResponse("index.html", dev);
      }

      if (url.pathname === "/styles.css" && req.method === "GET") {
        return publicAssetResponse("styles.css", dev);
      }

      if (url.pathname === "/app.js" && req.method === "GET") {
        return publicAssetResponse("app.js", dev);
      }

      if (url.pathname === "/events" && req.method === "GET") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            clients.add(ctrl);
            pushOperatorThread(ctrl);
            const allRuns = db.query(
              `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
               FROM runs ORDER BY id DESC LIMIT 20`
            ).all();
            push(ctrl, "runs-list", { runs: allRuns });
            pollDb();
          },
          cancel() {
            clients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/info" && req.method === "GET") {
        const projectRoot = resolve(dirname(dbPath()), "..");
        const projectName = basename(projectRoot);
        const tmuxPane = process.env.TMUX_PANE ?? null;
        let uiSession: string | null = null;
        let uiWindow: string | null = null;
        if (tmuxPane) {
          const s = Bun.spawnSync(["tmux", "display-message", "-p", "-t", tmuxPane, "#S"]);
          const w = Bun.spawnSync(["tmux", "display-message", "-p", "-t", tmuxPane, "#I"]);
          if (s.exitCode === 0) uiSession = new TextDecoder().decode(s.stdout).trim();
          if (w.exitCode === 0) uiWindow  = new TextDecoder().decode(w.stdout).trim();
        }
        return Response.json({ projectName, uiSession, uiWindow });
      }

      if (url.pathname === "/runs" && req.method === "GET") {
        const runs = db.query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
           FROM runs ORDER BY id DESC LIMIT 20`
        ).all();
        return Response.json({ runs });
      }

      if (url.pathname === "/thread" && req.method === "GET") {
        const runId = Number(url.searchParams.get("run_id"));
        if (!runId) return Response.json({ error: "missing run_id" }, { status: 400 });
        const run = db.query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at FROM runs WHERE id=?`
        ).get(runId) as any;
        if (!run) return Response.json({ error: "run not found" }, { status: 404 });
        const messages = db.query(
          `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
           FROM messages
           WHERE (from_agent='operator' OR to_agent='operator') AND run_id=?
           ORDER BY id`,
        ).all(runId);
        const managerActivity = managerActivityForRun(runId);
        return Response.json({ run, messages, managerActivity });
      }

      if (url.pathname === "/open-file" && req.method === "POST") {
        return req.json().then(async (body: any) => {
          const filePath = body?.path ?? "";
          const projectRoot = resolve(dirname(dbPath()), "..");
          const abs = resolve(filePath.startsWith("/") ? filePath : join(projectRoot, filePath));
          if (!abs.startsWith(projectRoot + "/") && abs !== projectRoot) {
            return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
          }
          try {
            Bun.spawn(["open", "-a", "Cursor", abs]);
          } catch {
            try {
              Bun.spawn(["open", abs]);
            } catch (err: any) {
              return Response.json({ ok: false, error: String(err) });
            }
          }
          return Response.json({ ok: true });
        });
      }

      if (url.pathname === "/file" && req.method === "GET") {
        const filePath = url.searchParams.get("path") ?? "";
        const projectRoot = resolve(dirname(dbPath()), "..");
        const abs = resolve(filePath.startsWith("/") ? filePath : join(projectRoot, filePath));
        if (!abs.startsWith(projectRoot + "/") && abs !== projectRoot) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const content = readFileSync(abs, "utf8");
          return Response.json({ path: filePath, content });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      if (url.pathname === "/send" && req.method === "POST") {
        return req
          .json()
          .then((body: any) => {
            const { to, type, body: msgBody, run_id, ref_id } = body ?? {};
            if (!to || !type || !msgBody) {
              return Response.json(
                { ok: false, error: "missing to, type, or body" },
                { status: 400 },
              );
            }
            if (!MESSAGE_TYPES.has(type)) {
              return Response.json(
                {
                  ok: false,
                  error: `type must be one of ${[...MESSAGE_TYPES].sort()}`,
                },
                { status: 400 },
              );
            }
            if (to === "broadcast") {
              return Response.json(
                {
                  ok: false,
                  error: "broadcast messages are no longer supported; send to a specific agent",
                },
                { status: 400 },
              );
            }
            const run = run_id
              ? (db.query(`SELECT id FROM runs WHERE id=?`).get(run_id) as any)
              : activeRun();
            const known = db
              .query(
                "SELECT 1 FROM agents WHERE window_name=? AND (run_id=? OR run_id=0)",
              )
              .get(to, run?.id ?? -1);
            if (!known) {
              console.error(
                `synapse ui: warning — '${to}' not in agents registry (sending anyway)`,
              );
            }
            const result = db.run(
              `INSERT INTO messages (run_id, from_agent, to_agent, type, ref_id, body) VALUES (?, 'operator', ?, ?, ?, ?)`,
              [run?.id ?? null, to, type, ref_id ?? null, msgBody],
            );
            // Mark the message this is replying to as read so its status
            // reflects reality (the UI itself no longer relies on this to
            // decide whether a QUESTION card is answered — it checks for a
            // matching reply row directly — but keep the column honest).
            if (ref_id) {
              db.run(`UPDATE messages SET status='read' WHERE id=? AND status != 'read'`, [ref_id]);
            }
            return Response.json({
              ok: true,
              id: Number(result.lastInsertRowid),
            });
          })
          .catch(() =>
            Response.json(
              { ok: false, error: "invalid JSON" },
              { status: 400 },
            ),
          );
      }

      if (url.pathname === "/focus-agent" && req.method === "POST") {
        return req.json().then((body: any) => {
          const { session, window: win } = body ?? {};
          if (!session || !win) {
            return Response.json({ ok: false, error: "missing session or window" }, { status: 400 });
          }
          const target = `${session}:${win}`;
          const selectResult = Bun.spawnSync(["tmux", "select-window", "-t", target]);
          if (selectResult.exitCode !== 0) {
            const stderr = new TextDecoder().decode(selectResult.stderr).trim();
            return Response.json({ ok: false, error: stderr || `exit ${selectResult.exitCode}` }, { status: 500 });
          }
          // Redirect all tmux clients (regardless of their current session) to the target window
          const listResult = Bun.spawnSync(["tmux", "list-clients", "-F", "#{client_name} #{session_name}"]);
          const clientLines = new TextDecoder().decode(listResult.stdout).trim().split('\n').filter(Boolean);
          if (clientLines.length === 0) {
            process.stderr.write(`[Synapse] switch-client: no tmux clients found\n`);
          } else {
            for (const line of clientLines) {
              const clientName = line.split(' ')[0];
              const switchResult = Bun.spawnSync(["tmux", "switch-client", "-c", clientName, "-t", target]);
              if (switchResult.exitCode !== 0) {
                const stderr = new TextDecoder().decode(switchResult.stderr).trim();
                process.stderr.write(`[Synapse] switch-client -c ${clientName} failed: ${stderr}\n`);
              }
            }
          }
          raiseTerminal();
          return Response.json({ ok: true });
        }).catch(() => Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }));
      }

      if (url.pathname === "/start" && req.method === "POST") {
        return req
          .json()
          .then((body: any) => {
            const goal = String(body?.goal ?? "").trim();
            const configPath = String(body?.config_path ?? DEFAULT_TASK_TEMPLATE).trim();
            const args = [...synapseCommand(), "start", configPath];
            if (goal) args.push("--goal", goal);
            if (body?.no_monitor) args.push("--no-monitor");
            const result = Bun.spawnSync({
              cmd: args,
              env: { ...process.env, SYNAPSE_DB: dbPath() },
            });
            const stdout = result.stdout.toString();
            const stderr = result.stderr.toString();
            if (result.exitCode !== 0) {
              return Response.json(
                { ok: false, error: stderr.trim() || stdout.trim() || "start failed" },
                { status: 500 },
              );
            }
            const runId = Number(stdout.match(/run #(\d+)/)?.[1] ?? 0) || null;
            pollDb();
            return Response.json({ ok: true, run_id: runId, stdout });
          })
          .catch(() =>
            Response.json(
              { ok: false, error: "invalid JSON" },
              { status: 400 },
            ),
          );
      }

      if (url.pathname === "/kill-session" && req.method === "POST") {
        return req.json().then((body: any) => {
          const reqRunId = body?.run_id ? Number(body.run_id) : null;
          const run = reqRunId
            ? (db.query(`SELECT id, session, status, goal, started_at, ended_at, session_killed_at FROM runs WHERE id=?`).get(reqRunId) as any)
            : activeRun();
          if (!run) {
            return Response.json(
              { ok: false, error: "no run selected" },
              { status: 404 },
            );
          }
          if (run.status === "running") {
            return Response.json(
              { ok: false, error: "run is still running" },
              { status: 409 },
            );
          }
          const runId = Number(run.id);
          const session = run.session;
          db.run(
            "INSERT INTO events (agent, type, summary, created_at) VALUES ('operator', 'decision', ?, ?)",
            [`requested tmux session kill for terminal run ${runId}; session ${session}`, nowIso()],
          );
          const result = disbandTeam(db, session, runId, (s) => console.log(`[kill-session] ${s}`));
          pollDb();
          if (!result.sessionKilled) {
            return Response.json(
              { ok: false, run_id: runId, session, error: result.error || "tmux session still exists" },
              { status: 500 },
            );
          }
          const updated = db
            .query("SELECT session_killed_at FROM runs WHERE id=?")
            .get(runId) as any;
          return Response.json({ ok: true, run_id: runId, session, session_killed_at: updated?.session_killed_at ?? null });
        });
      }

      if (url.pathname === "/finish-run" && req.method === "POST") {
        return req.json().then((body: any) => {
          const reqRunId = body?.run_id ? Number(body.run_id) : null;
          const run = reqRunId
            ? (db.query(`SELECT id, session, status, goal, started_at, ended_at, session_killed_at FROM runs WHERE id=?`).get(reqRunId) as any)
            : activeRun();
          if (!run) {
            return Response.json(
              { ok: false, error: "no run selected" },
              { status: 404 },
            );
          }
          if (run.status !== "running") {
            return Response.json(
              { ok: false, error: "run is not running" },
              { status: 409 },
            );
          }
          const runId = Number(run.id);
          const session = run.session;
          cmdDone("done", "Operator finished the run from UI.", "operator", null, runId);
          const result = disbandTeam(db, session, runId, (s) => console.log(`[finish-run] ${s}`));
          pollDb();
          if (!result.sessionKilled) {
            return Response.json(
              { ok: false, run_id: runId, session, error: result.error || "tmux session still exists" },
              { status: 500 },
            );
          }
          const updated = db
            .query("SELECT session_killed_at FROM runs WHERE id=?")
            .get(runId) as any;
          return Response.json({ ok: true, run_id: runId, session, session_killed_at: updated?.session_killed_at ?? null });
        });
      }

      if (req.method === "POST" && pathname === "/upload") {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return Response.json({ error: "no file" }, { status: 400 });

        const uploadsDir = join(dirname(dbPath()), "uploads");
        mkdirSync(uploadsDir, { recursive: true });

        const safeName = basename(file.name).replace(/[^\w.\-]/g, "_");
        const destPath = join(uploadsDir, safeName);
        await Bun.write(destPath, await file.arrayBuffer());

        const projectRoot = dirname(dirname(dbPath()));
        const relPath = relative(projectRoot, destPath);
        return Response.json({ path: relPath });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  function shutdown() {
    clearInterval(pollTimer);
    for (const ctrl of clients) {
      try { ctrl.close(); } catch {}
    }
    server.stop(true);
    process.exit(0);
  }

  console.log(`synapse ui: listening on http://localhost:${server.port}`);
  console.log(`  GET  /        — dashboard`);
  console.log(`  GET  /events  — SSE stream (agent-status, message-stream, reload)`);
  console.log(`  POST /send    — {to, type, body}`);
}
