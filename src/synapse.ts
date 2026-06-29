#!/usr/bin/env bun
/**
 * synapse — CLI for the Claude Team Synapse message bus.
 *
 * Commands:
 *   synapse init
 *   synapse register <name> <role> [session_id]
 *   synapse send <to> <type> <body> [--from NAME] [--ref-id N]
 *   synapse log <agent> <type> <summary>
 *   synapse status
 *   synapse pending [agent]
 *   synapse deliver <id>
 *   synapse monitor [--session NAME] [--interval MS] [--debounce MS] [--once]
 *   synapse start <task.yml> [--goal "text"] [--no-monitor]
 *   synapse stop <name> [--session SESSION]
 *   synapse attach <name> [--session SESSION]
 *   synapse ui [--port N]
 *   synapse version
 *
 * DB location: $SYNAPSE_DB, else ./.synapse/synapse.db
 * Transcript root: $CLAUDE_PROJECTS_DIR, else ~/.claude/projects
 *
 * Build: make build (injects SYNAPSE_VERSION from `git describe`; see Makefile)
 */
import {
  cmdAttach,
  cmdDone,
  cmdInit,
  cmdMonitor,
  cmdStart,
  cmdStop,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TMUX_SESSION,
  fail,
} from "./commands";
import {
  cmdDeliver,
  cmdLog,
  cmdPending,
  cmdRegister,
  cmdSend,
  cmdStatus,
} from "./mailbox";
import { cmdUi } from "./ui";

// Injected at compile time via `bun build --define SYNAPSE_VERSION=...`
// (see Makefile). The identifier doesn't exist when running uncompiled
// (`bun src/synapse.ts`), and `typeof` on an undeclared identifier never
// throws, so this falls back to "dev" cleanly in that case.
declare const SYNAPSE_VERSION: string | undefined;
const VERSION: string =
  typeof SYNAPSE_VERSION !== "undefined" ? SYNAPSE_VERSION : "dev";

function parseFlags(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      // Boolean flag (--once): treat as true when no value follows or next is also a flag.
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(`synapse ${VERSION}`);
      return;
    case "init":
      return cmdInit();
    case "register": {
      const [name, role, sessionId] = positional;
      if (!name || !role)
        fail("usage: synapse register <name> <role> [session_id]");
      return cmdRegister(name, role, sessionId ?? null);
    }
    case "send": {
      const [to, type, body] = positional;
      if (!to || !type || !body)
        fail(
          "usage: synapse send <to> <type> <body> [--from NAME] [--ref-id N]",
        );
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      return cmdSend(to, type, body, flags["from"] ?? null, refId);
    }
    case "log": {
      const [agent, type, summary] = positional;
      if (!agent || !type || !summary)
        fail("usage: synapse log <agent> <type> <summary>");
      return cmdLog(agent, type, summary);
    }
    case "status":
      return cmdStatus();
    case "pending":
      return cmdPending(positional[0] ?? null);
    case "deliver": {
      const [id] = positional;
      if (!id) fail("usage: synapse deliver <id>");
      return cmdDeliver(parseInt(id, 10));
    }
    case "monitor":
      return cmdMonitor(flags);
    case "start": {
      const [configPath = DEFAULT_TASK_TEMPLATE] = positional;
      return cmdStart(configPath, flags);
    }
    case "stop": {
      const [name] = positional;
      if (!name) fail("usage: synapse stop <name> [--session SESSION]");
      return cmdStop(name, flags["session"] ?? DEFAULT_TMUX_SESSION);
    }
    case "attach": {
      const [name] = positional;
      if (!name) fail("usage: synapse attach <name> [--session SESSION]");
      return cmdAttach(name, flags["session"] ?? DEFAULT_TMUX_SESSION);
    }
    case "ui":
      return cmdUi(flags);
    case "done": {
      const [summary] = positional;
      if (!summary)
        fail(
          'usage: synapse done --status done|failed "<summary>" [--ref-id N] [--run-id N]',
        );
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      return cmdDone(flags["status"] ?? "done", summary, refId, runId);
    }
    default:
      fail(
        `unknown command '${command}'. Expected one of: init, register, send, log, status, pending, deliver, monitor, start, stop, attach, ui, done, version`,
      );
  }
}

main();
