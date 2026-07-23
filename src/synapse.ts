#!/usr/bin/env bun
/**
 * synapse — CLI for the Claude Team Synapse message bus.
 *
 * Commands:
 *   synapse help [command]
 *   synapse init
 *   synapse register <name> <role> [session_id]
 *   synapse send <to> <type> <body> [--from NAME] [--ref-id N]
 *   synapse status
 *   synapse pending [agent]
 *   synapse deliver <id>
 *   synapse monitor [--session NAME] [--interval MS] [--debounce MS] [--once]
 *   synapse start --goal "text" [--manager-model MODEL] [--no-monitor]
 *   synapse stop <name> [--session SESSION]
 *   synapse attach <name> [--session SESSION]
 *   synapse ui [--port N]
 *   synapse set-goal "<text>" [--run-id N]
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
  cmdHookStop,
  cmdInit,
  cmdPending,
  cmdRegister,
  cmdRuns,
  cmdSend,
  cmdSetGoal,
  cmdSpawn,
  cmdStart,
  cmdStatus,
  cmdStop,
  DEFAULT_MANAGER_MODEL,
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
  run: (context: CommandContext) => void | Promise<void>;
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
    usage: "synapse send <to> <type> <body> [--from NAME] [--ref-id N] [--run-id N] [--options opt1,opt2,...] [--title \"Short title\"] [--body-file PATH]",
    summary: "Queue a message for an agent.",
    help: [
      {
        title: "Arguments",
        lines: [
          "to    Recipient agent name or operator.",
          "type  Message type: TASK, QUESTION, PROGRESS, or REPLY.",
          "body  Message body (omit when --body-file is used).",
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
          "--body-file PATH      Read body from file (use - for stdin). Avoids shell interpolation of backticks.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [to, type, rawBody] = positional;
      let body: string;
      if (flags["body-file"]) {
        const src = flags["body-file"];
        body = src === "-"
          ? await Bun.stdin.text()
          : await Bun.file(src).text();
        body = body.trimEnd();
      } else {
        body = rawBody;
      }
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
          "--interval MS   Sweep interval; drives busy/idle checks, roster sync, and mail delivery.",
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
    usage: 'synapse start --goal "text" [--manager-model MODEL] [--no-monitor]',
    summary: "Start a new run: launch manager with the given goal.",
    help: [
      {
        title: "Options",
        lines: [
          '--goal text             Goal to send to manager as the root TASK (required).',
          `--manager-model MODEL   Model for the manager agent (default: "${DEFAULT_MANAGER_MODEL}").`,
          "--no-monitor            Create the team without starting the monitor.",
        ],
      },
    ],
    run: ({ flags }) => cmdStart(flags),
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
    name: "spawn",
    usage: "synapse spawn <role> [--model MODEL] [--focus text] [--run-id N]",
    summary: "Spawn a new agent window in the active (or specified) run.",
    help: [
      {
        title: "Arguments",
        lines: [
          "role        Agent role to launch: coder, reviewer, tester, manager.",
        ],
      },
      {
        title: "Options",
        lines: [
          "--model MODEL   Model override for the new agent.",
          '--focus text    Focus text appended to the agent\'s CLAUDE.md instance block.',
          "--run-id N      Target a specific run (default: most recent running run).",
        ],
      },
    ],
    run(context) {
      const { positional, flags } = context;
      const role = positional[0];
      if (!role) fail("synapse spawn: role is required");
      cmdSpawn(role, flags);
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
    usage: "synapse ui [--port N] [--dev]",
    summary: "Start the operator web UI.",
    help: [
      {
        title: "Options",
        lines: [
          "--port N  HTTP port for the web UI.",
          "--dev     Serve UI assets from disk on every request (live reload).",
        ],
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
      const dev = "dev" in flags;
      cmdInit();
      return startUi(port, dev);
    },
  },
  {
    name: "done",
    usage: 'synapse done [run-id] [--reason "<text>"] [--status done|failed] [--ref-id N]',
    summary: "Mark the active run done or failed.",
    help: [
      {
        title: "Arguments",
        lines: [
          "run-id  Optional run id to finish. Overrides $SYNAPSE_RUN_ID.",
        ],
      },
      {
        title: "Options",
        lines: [
          "--reason TEXT         Summary text for the final reply. Defaults to \"Run marked done.\"",
          "--status done|failed  Terminal status to write. Defaults to done.",
          "--ref-id N            Root task message id this closes.",
        ],
      },
    ],
    run: (context) => {
      const { positional, flags } = context;
      let runId: number | null = null;
      if (positional[0] !== undefined) {
        runId = parseInt(positional[0], 10);
        if (isNaN(runId)) fail(`synapse done: invalid run-id '${positional[0]}' — expected an integer`);
      }
      const summary = flags["reason"] ?? null;
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      return cmdDone(flags["status"] ?? "done", summary, null, refId, runId);
    },
  },
  {
    name: "set-goal",
    usage: 'synapse set-goal "<new goal text>" [--run-id N]',
    summary: "Update the goal of the current (or specified) running run.",
    help: [
      {
        title: "Arguments",
        lines: ["text  New goal text (required)."],
      },
      {
        title: "Options",
        lines: ["--run-id N    Target a specific run by id (default: current running run)."],
      },
    ],
    run(context) {
      const { positional, flags } = context;
      const text = positional[0];
      if (!text || !text.trim()) fail("synapse set-goal: goal text is required");
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      if (flags["run-id"] && isNaN(runId!)) fail(`synapse set-goal: invalid run-id '${flags["run-id"]}'`);
      return cmdSetGoal(text, runId);
    },
  },
  {
    name: "hook-stop",
    usage: "synapse hook-stop",
    summary: "Called by the Claude Code Stop hook; delivers pending work or sets agent idle.",
    run: () => {
      const agentName = process.env.SYNAPSE_AGENT;
      const runIdStr = process.env.SYNAPSE_RUN_ID;
      if (!agentName || !runIdStr) {
        process.stderr.write("[hook-stop] SYNAPSE_AGENT and SYNAPSE_RUN_ID must be set\n");
        return;
      }
      const runId = parseInt(runIdStr, 10);
      if (isNaN(runId)) {
        process.stderr.write(`[hook-stop] invalid SYNAPSE_RUN_ID: ${runIdStr}\n`);
        return;
      }
      cmdHookStop(agentName, runId);
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

async function main() {
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

  await command.run({ positional, flags, command });
}

main();
