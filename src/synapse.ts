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
import { startUi } from "./ui";

// Injected at compile time via `bun build --define SYNAPSE_VERSION=...`
// (see Makefile). The identifier doesn't exist when running uncompiled
// (`bun src/synapse.ts`), and `typeof` on an undeclared identifier never
// throws, so this falls back to "dev" cleanly in that case.
declare const SYNAPSE_VERSION: string | undefined;
const VERSION: string =
  typeof SYNAPSE_VERSION !== "undefined" ? SYNAPSE_VERSION : "dev";
const DEFAULT_UI_PORT = 7700;

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

type ParsedFlags = ReturnType<typeof parseFlags>;
type CommandContext = ParsedFlags & { command: CommandSpec };

interface HelpSection {
  title: string;
  lines: string[];
}

interface CommandSpec {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  help?: HelpSection[];
  run: (context: CommandContext) => void;
}

function requireArgs(context: CommandContext, ok: boolean): void {
  if (!ok) fail(`usage: ${context.command.usage}`);
}

const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    aliases: ["--help", "-h"],
    usage: "synapse help [command]",
    summary: "Show general help or help for one command.",
    help: [
      {
        title: "Arguments",
        lines: ["command  Optional command name to inspect."],
      },
    ],
    run: ({ positional }) => printHelp(positional[0]),
  },
  {
    name: "version",
    aliases: ["--version", "-v"],
    usage: "synapse version",
    summary: "Print the synapse version.",
    run: () => console.log(`synapse ${VERSION}`),
  },
  {
    name: "init",
    usage: "synapse init",
    summary: "Create or migrate the Synapse database.",
    run: () => cmdInit(),
  },
  {
    name: "register",
    usage: "synapse register <name> <role> [session_id] [--run-id N]",
    summary: "Register or update an agent for a run.",
    help: [
      {
        title: "Arguments",
        lines: [
          "name        Tmux window/agent name.",
          "role        Agent role, such as manager, coder, reviewer, or operator.",
          "session_id  Optional Claude Code session id used for transcript monitoring.",
        ],
      },
      {
        title: "Options",
        lines: ["--run-id N  Register the agent against a specific run."],
      },
    ],
    run: (context) => {
      const { positional, flags } = context;
      const [name, role, sessionId] = positional;
      requireArgs(context, !!name && !!role);
      const runId = flags["run-id"]
        ? parseInt(flags["run-id"], 10)
        : process.env.SYNAPSE_RUN_ID
          ? parseInt(process.env.SYNAPSE_RUN_ID, 10)
          : null;
      if (runId === null) fail("missing run id — pass --run-id N or set SYNAPSE_RUN_ID");
      return cmdRegister(name, role, sessionId ?? null, runId);
    },
  },
  {
    name: "send",
    usage: "synapse send <to> <type> <body> [--from NAME] [--ref-id N] [--run-id N] [--options opt1,opt2,...] [--title \"Short title\"]",
    summary: "Queue a message for an agent.",
    help: [
      {
        title: "Arguments",
        lines: [
          "to    Recipient agent name or operator.",
          "type  Message type: TASK, STATUS, REVIEW, ACK, INFO, or QUESTION.",
          "body  Message body.",
        ],
      },
      {
        title: "Options",
        lines: [
          "--from NAME           Sender name. Defaults to $SYNAPSE_AGENT.",
          "--ref-id N            Message id this message replies to or closes.",
          "--run-id N            Store the message on a specific run.",
          "--options a,b,c       Choice labels for QUESTION messages.",
          "--title TEXT          Short title shown above the body in QUESTION cards.",
        ],
      },
    ],
    run: (context) => {
      const { positional, flags } = context;
      const [to, type, body] = positional;
      requireArgs(context, !!to && !!type && !!body);
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      const options = flags["options"]
        ? flags["options"].split(",").map(s => s.trim()).filter(Boolean)
        : null;
      const title = flags["title"] ?? null;
      return cmdSend(to, type, body, flags["from"] ?? null, refId, runId, options, title);
    },
  },
  {
    name: "log",
    usage: "synapse log <agent> <type> <summary>",
    summary: "Record an event in the run log.",
    help: [
      {
        title: "Arguments",
        lines: [
          "agent    Agent name.",
          "type     Suggested event type: task_start, task_end, or decision.",
          "summary  Event summary.",
        ],
      },
    ],
    run: (context) => {
      const { positional } = context;
      const [agent, type, summary] = positional;
      requireArgs(context, !!agent && !!type && !!summary);
      return cmdLog(agent, type, summary);
    },
  },
  {
    name: "status",
    usage: "synapse status",
    summary: "Show registered agents and pending counts.",
    run: () => cmdStatus(),
  },
  {
    name: "runs",
    usage: "synapse runs",
    summary: "List known runs.",
    run: () => cmdRuns(),
  },
  {
    name: "pending",
    usage: "synapse pending [agent] [--all]",
    summary: "Show pending messages.",
    help: [
      {
        title: "Options",
        lines: ["--all  Include pending messages across all runs instead of the active run."],
      },
    ],
    run: ({ positional, flags }) => cmdPending(positional[0] ?? null, !!flags["all"]),
  },
  {
    name: "deliver",
    usage: "synapse deliver <id>",
    summary: "Mark one pending or delivered message read.",
    run: (context) => {
      const { positional } = context;
      const [id] = positional;
      requireArgs(context, !!id);
      return cmdDeliver(parseInt(id, 10));
    },
  },
  {
    name: "monitor",
    usage: "synapse monitor [--session NAME] [--interval MS] [--debounce MS] [--once]",
    summary: "Watch agent transcripts and deliver queued messages.",
    help: [
      {
        title: "Options",
        lines: [
          "--session NAME  Tmux session to monitor.",
          "--interval MS   Sweep interval for roster/mail checks.",
          "--debounce MS   Quiet window before end_turn counts as idle.",
          "--once          Run a single synchronous polling pass.",
          "--run-id N      Restrict monitor work to a run.",
        ],
      },
    ],
    run: ({ flags }) => cmdMonitor(flags),
  },
  {
    name: "start",
    usage: 'synapse start [task.yml] [--goal "text"] [--no-monitor]',
    summary: "Start a task from a task manifest.",
    help: [
      {
        title: "Options",
        lines: [
          "--goal text    Override the goal from the task manifest.",
          "--no-monitor   Create the team without starting the monitor.",
        ],
      },
    ],
    run: ({ positional, flags }) => {
      const [configPath = DEFAULT_TASK_TEMPLATE] = positional;
      return cmdStart(configPath, flags);
    },
  },
  {
    name: "stop",
    usage: "synapse stop <name> [--session SESSION] [--run-id N]",
    summary: "Mark an agent stopped and close its tmux window.",
    help: [
      {
        title: "Options",
        lines: [
          "--session SESSION  Tmux session containing the agent window.",
          "--run-id N          Stop the agent in a specific run.",
        ],
      },
    ],
    run: (context) => {
      const { positional, flags } = context;
      const [name] = positional;
      requireArgs(context, !!name);
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : undefined;
      return cmdStop(name, flags["session"] ?? DEFAULT_TMUX_SESSION, runId);
    },
  },
  {
    name: "attach",
    usage: "synapse attach <name> [--session SESSION]",
    summary: "Attach to an agent tmux window.",
    help: [
      {
        title: "Options",
        lines: ["--session SESSION  Tmux session containing the agent window."],
      },
    ],
    run: (context) => {
      const { positional, flags } = context;
      const [name] = positional;
      requireArgs(context, !!name);
      return cmdAttach(name, flags["session"] ?? DEFAULT_TMUX_SESSION);
    },
  },
  {
    name: "ui",
    usage: "synapse ui [--port N]",
    summary: "Start the operator web UI.",
    help: [
      {
        title: "Options",
        lines: ["--port N  HTTP port for the web UI."],
      },
    ],
    run: ({ flags }) => {
      const port = flags["port"] !== undefined
        ? parseInt(flags["port"], 10)
        : DEFAULT_UI_PORT;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error("synapse: --port must be an integer from 0 to 65535");
        process.exit(1);
      }
      cmdInit();
      return startUi(port);
    },
  },
  {
    name: "done",
    usage: 'synapse done --status done|failed "<summary>" [--from NAME] [--run-id N] [--ref-id N]',
    summary: "Mark the active run done or failed.",
    help: [
      {
        title: "Options",
        lines: [
          "--status done|failed  Terminal status to write. Defaults to done.",
          "--from NAME           Agent sending the final status.",
          "--run-id N            Run to finish.",
          "--ref-id N            Root task message id this closes.",
        ],
      },
    ],
    run: (context) => {
      const { positional, flags } = context;
      const [summary] = positional;
      requireArgs(context, summary !== undefined);
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      return cmdDone(flags["status"] ?? "done", summary, flags["from"] ?? null, refId, runId);
    },
  },
];

const commandHelp = COMMANDS.find((command) => command.name === "help")!;

const COMMAND_BY_NAME = new Map<string, CommandSpec>();
for (const command of COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    COMMAND_BY_NAME.set(alias, command);
  }
}

function commandList() {
  return COMMANDS.map((command) => {
    const padded = command.name.padEnd(10);
    return `  ${padded} ${command.summary}`;
  }).join("\n");
}

function printCommandHelp(command: CommandSpec) {
  const sections = command.help
    ?.map((section) => `\n${section.title}:\n${section.lines.map((line) => `  ${line}`).join("\n")}`)
    .join("\n") ?? "";
  console.log(`Usage: ${command.usage}\n\n${command.summary}${sections}`);
}

function printHelp(commandName?: string) {
  if (commandName) {
    const command = COMMAND_BY_NAME.get(commandName);
    if (!command) fail(`unknown command '${commandName}'. Run 'synapse help' for available commands.`);
    printCommandHelp(command);
    return;
  }

  console.log(`synapse ${VERSION}

Usage:
  synapse <command> [args]
  ${commandHelp.usage}

Commands:
${commandList()}

DB location: $SYNAPSE_DB, else ./.synapse/synapse.db
Transcript root: $CLAUDE_PROJECTS_DIR, else ~/.claude/projects`);
}

function main() {
  const [commandName, ...rest] = process.argv.slice(2);
  if (commandName === undefined) {
    printHelp();
    return;
  }

  const { positional, flags } = parseFlags(rest);
  const command = COMMAND_BY_NAME.get(commandName);
  if (!command) {
    fail(`unknown command '${commandName}'. Run 'synapse help' for available commands.`);
  }

  if ((flags["help"] || flags["h"]) && command.name !== "help") {
    printCommandHelp(command);
    return;
  }

  command.run({ positional, flags, command });
}

main();
