#!/usr/bin/env bun
/**
 * synapse — CLI for the Claude Team Synapse message bus.
 *
 * Commands:
 *   synapse help [command]
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
  cmdDeliver,
  cmdDone,
  cmdInit,
  cmdLog,
  cmdPending,
  cmdRegister,
  cmdRuns,
  cmdSend,
  cmdStart,
  cmdStatus,
  cmdStop,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TMUX_SESSION,
  fail,
} from "./commands";
import { cmdMonitor } from "./monitor";
import { cmdUi } from "./ui";

// Injected at compile time via `bun build --define SYNAPSE_VERSION=...`
// (see Makefile). The identifier doesn't exist when running uncompiled
// (`bun src/synapse.ts`), and `typeof` on an undeclared identifier never
// throws, so this falls back to "dev" cleanly in that case.
declare const SYNAPSE_VERSION: string | undefined;
const VERSION: string =
  typeof SYNAPSE_VERSION !== "undefined" ? SYNAPSE_VERSION : "dev";

const COMMAND_USAGE: Record<string, string> = {
  help: "synapse help [command]",
  init: "synapse init",
  register: "synapse register <name> <role> [session_id] [--run-id N]",
  send: "synapse send <to> <type> <body> [--from NAME] [--ref-id N] [--run-id N] [--options opt1,opt2,...]",
  log: "synapse log <agent> <type> <summary>",
  status: "synapse status",
  runs: "synapse runs",
  pending: "synapse pending [agent] [--all]",
  deliver: "synapse deliver <id>",
  monitor: "synapse monitor [--session NAME] [--interval MS] [--debounce MS] [--once]",
  start: 'synapse start [task.yml] [--goal "text"] [--no-monitor]',
  stop: "synapse stop <name> [--session SESSION] [--run-id N]",
  attach: "synapse attach <name> [--session SESSION]",
  ui: "synapse ui [--port N]",
  done: 'synapse done --status done|failed "<summary>" [--from NAME] [--run-id N] [--ref-id N]',
  version: "synapse version",
};

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  help: "Show general help or help for one command.",
  init: "Create or migrate the Synapse database.",
  register: "Register or update an agent for a run.",
  send: "Queue a message for an agent.",
  log: "Record an event in the run log.",
  status: "Show registered agents and pending counts.",
  runs: "List known runs.",
  pending: "Show pending messages.",
  deliver: "Mark one pending message delivered.",
  monitor: "Poll tmux windows and deliver queued messages.",
  start: "Start a task from a task manifest.",
  stop: "Mark an agent stopped and close its tmux window.",
  attach: "Attach to an agent tmux window.",
  ui: "Start the operator web UI.",
  done: "Mark the active run done or failed.",
  version: "Print the synapse version.",
};

const COMMANDS = Object.keys(COMMAND_USAGE);

function commandList() {
  return COMMANDS.map((name) => {
    const padded = name.padEnd(10);
    return `  ${padded} ${COMMAND_DESCRIPTIONS[name]}`;
  }).join("\n");
}

function printHelp(command?: string) {
  if (command) {
    const usage = COMMAND_USAGE[command];
    if (!usage) fail(`unknown command '${command}'. Run 'synapse help' for available commands.`);
    console.log(`Usage: ${usage}\n\n${COMMAND_DESCRIPTIONS[command]}`);
    return;
  }

  console.log(`synapse ${VERSION}

Usage:
  synapse <command> [args]
  synapse help [command]

Commands:
${commandList()}

DB location: $SYNAPSE_DB, else ./.synapse/synapse.db
Transcript root: $CLAUDE_PROJECTS_DIR, else ~/.claude/projects`);
}

function parseFlags(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h") {
      flags.h = "true";
    } else if (a.startsWith("--")) {
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

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp(positional[0]);
    return;
  }

  if (flags["help"] || flags["h"]) {
    printHelp(command);
    return;
  }

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
        fail("usage: synapse register <name> <role> [session_id] [--run-id N]");
      const runId = flags["run-id"]
        ? parseInt(flags["run-id"], 10)
        : process.env.SYNAPSE_RUN_ID
          ? parseInt(process.env.SYNAPSE_RUN_ID, 10)
          : null;
      if (runId === null) fail("missing run id — pass --run-id N or set SYNAPSE_RUN_ID");
      return cmdRegister(name, role, sessionId ?? null, runId);
    }
    case "send": {
      const [to, type, body] = positional;
      if (!to || !type || !body)
        fail(
          "usage: synapse send <to> <type> <body> [--from NAME] [--ref-id N] [--run-id N] [--options opt1,opt2,...]",
        );
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      const options = flags["options"]
        ? flags["options"].split(",").map(s => s.trim()).filter(Boolean)
        : null;
      return cmdSend(to, type, body, flags["from"] ?? null, refId, runId, options);
    }
    case "log": {
      const [agent, type, summary] = positional;
      if (!agent || !type || !summary)
        fail("usage: synapse log <agent> <type> <summary>");
      return cmdLog(agent, type, summary);
    }
    case "status":
      return cmdStatus();
    case "runs":
      return cmdRuns();
    case "pending":
      return cmdPending(positional[0] ?? null, !!flags["all"]);
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
      if (!name) fail("usage: synapse stop <name> [--session SESSION] [--run-id N]");
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : undefined;
      return cmdStop(name, flags["session"] ?? DEFAULT_TMUX_SESSION, runId);
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
      if (summary === undefined)
        fail(
          'usage: synapse done --status done|failed "<summary>" [--from NAME] [--run-id N] [--ref-id N]',
        );
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      return cmdDone(flags["status"] ?? "done", summary, flags["from"] ?? null, refId, runId);
    }
    default:
      fail(
        `unknown command '${command}'. Run 'synapse help' for available commands.`,
      );
  }
}

main();
