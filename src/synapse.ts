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
  cmdReply,
  cmdRuns,
  cmdSend,
  cmdSetGoal,
  cmdSpawn,
  cmdStart,
  cmdStatus,
  cmdStep,
  cmdStop,
  DEFAULT_MANAGER_MODEL,
  fail,
  HANDOFF_KINDS,
  PROGRESS_TAGS,
  writeArtifact,
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

// Resolve a message body from --body-file (path or - for stdin) if present,
// else from the positional at `rawIndex`. Shared by every message verb
// (send/task/ask/progress/reply) so the stdin/file handling lives in one place.
async function resolveBody(
  context: CommandContext,
  rawIndex: number,
): Promise<string> {
  const src = context.flags["body-file"];
  if (src) {
    const text = src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
    return text.trimEnd();
  }

  const body = context.positional[rawIndex];

  // Shell-mangling detection — only for inline positional bodies.
  //
  // Odd backtick count: shell consumed one command-substitution boundary;
  // the content between the pair was evaluated and removed. Hard-error so
  // the caller re-sends via --body-file.
  const backtickCount = (body?.match(/`/g) ?? []).length;
  if (backtickCount % 2 !== 0) {
    fail(
      `body has an odd number of backticks (${backtickCount}) — shell likely swallowed a command substitution.\n` +
        `Re-send using a quoted heredoc and --body-file to avoid interpolation:\n` +
        `  synapse reply <id> --body-file - <<'EOF'\n` +
        `  <your message here>\n` +
        `  EOF`,
    );
  }

  // Code-token-without-backtick warning: the body references code identifiers
  // (file references like foo.ts:42 or function calls like foo_bar()) but has
  // zero backticks. Backticks are almost always present in technical messages
  // that cite code — zero backticks in such a message strongly suggests they
  // were silently eaten in pairs by the shell.
  if (body && backtickCount === 0) {
    const CODE_TOKEN = /\w+\.(ts|go|c|h|py|md|sh|json|yaml):\d+|\w+_\w+\(\)/;
    if (CODE_TOKEN.test(body)) {
      process.stderr.write(
        `warning: body references code identifiers but contains no backticks — ` +
          `shell may have silently stripped them in matching pairs.\n` +
          `If inline code was lost, re-send via --body-file to avoid interpolation.\n`,
      );
    }
  }

  return body;
}

// Resolve which run a command acts on: explicit --run-id → SYNAPSE_RUN_ID → null.
function resolveRunId(flags: Record<string, string>): number | null {
  if (flags["run-id"]) return parseInt(flags["run-id"], 10);
  return process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null;
}

// Handle the --handoff <kind>:<path> flag shared by the message verbs. Reads
// the file at <path>, writes it to its canonical artifact path (keyed on refId
// + kind), and returns the repo-relative path to fold into the message body.
// Returns null when the flag is absent. Fails on a bad kind, an unresolvable
// run, or a missing/empty file.
async function resolveHandoff(
  context: CommandContext,
  refId: number | null,
  runId: number | null,
): Promise<string | null> {
  const raw = context.flags["handoff"];
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    fail(`--handoff must be <kind>:<path>, e.g. --handoff review:./review.md (got '${raw}')`);
  }
  const kind = raw.slice(0, idx);
  const path = raw.slice(idx + 1);
  if (!HANDOFF_KINDS.has(kind)) {
    fail(`--handoff kind must be one of ${[...HANDOFF_KINDS].sort().join(", ")}, got '${kind}'`);
  }
  if (refId === null || Number.isNaN(refId)) {
    fail("--handoff needs a ref-id to name the artifact — pass --ref-id N (or, for reply, the ref-id positional).");
  }
  if (runId === null || Number.isNaN(runId)) {
    fail("--handoff needs a run id to place the file — set SYNAPSE_RUN_ID or pass --run-id N.");
  }
  const content = await Bun.file(path).text().catch(() => {
    fail(`--handoff: cannot read file '${path}'.`);
    return "";
  });
  if (!content.trim()) fail(`--handoff: file '${path}' is empty.`);
  return writeArtifact(kind, refId, content, runId);
}

// Fold a handoff artifact path into a message body: "<body> — <path>", or just
// the path when the body is empty.
function withHandoffPath(body: string, relPath: string | null): string {
  if (!relPath) return body;
  return body ? `${body} — ${relPath}` : relPath;
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
    usage: "synapse send <to> <type> <body> [--from NAME] [--ref-id N] [--run-id N] [--options opt1,opt2,...] [--title \"Short title\"] [--body-file PATH] [--no-review] [--test-required]",
    summary: "Low-level escape hatch: queue any message type. Prefer the intent verbs — 'task', 'ask', 'progress', 'reply'.",
    help: [
      {
        title: "Arguments",
        lines: [
          "to    Recipient agent name or operator.",
          "type  Message type: TASK, QUESTION, or PROGRESS. (REPLY: use 'synapse reply'.)",
          "body  Message body (omit when --body-file is used).",
        ],
      },
      {
        title: "Options",
        lines: [
          "--from NAME           Sender name. Defaults to $SYNAPSE_AGENT.",
          "--ref-id N            Message id this message references (e.g. a PROGRESS relay or review TASK).",
          "--run-id N            Store the message on a specific run.",
          "--options a,b,c       Choice labels for QUESTION messages.",
          "--title TEXT          Short title shown above the body in QUESTION cards.",
          "--body-file PATH      Read body from file (use - for stdin). Avoids shell interpolation of backticks.",
          "--no-review           On a manager -> coder TASK: waive review for this subtask (the done gate won't require a reviewer verdict).",
          "--test-required       On a manager -> coder TASK: mark this subtask as needing a tester pass.",
        ],
      },
      {
        title: "Note",
        lines: [
          "This is the general form. For everyday use prefer the intent verbs, which",
          "carry only each type's relevant flags: 'synapse task', 'synapse ask',",
          "'synapse progress', 'synapse reply'. 'send' still works for all of them.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [to, type] = positional;
      const body = await resolveBody(context, 2);
      requireArgs(context, !!to && !!type && !!body);
      if (type === "REPLY") {
        fail(
          "REPLY is not sent via 'synapse send'. Use 'synapse reply <id> \"<body>\"' — " +
            "it resolves the recipient to the sender of message <id>, so a REPLY can't be misrouted.",
        );
      }
      // Steer toward the intent verb without breaking the send (in-flight
      // agents may still emit `send`). The verb carries only that type's flags.
      const PREFERRED_VERB: Record<string, string> = {
        TASK: "task",
        QUESTION: "ask",
        PROGRESS: "progress",
      };
      const verb = PREFERRED_VERB[type];
      if (verb) {
        console.error(
          `synapse: note — 'synapse ${verb} <to> "…"' is the preferred spelling for ${type}; 'send' still works.`,
        );
      }
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = flags["run-id"] ? parseInt(flags["run-id"], 10) : null;
      const options = flags["options"]
        ? flags["options"].split(",").map(s => s.trim()).filter(Boolean)
        : null;
      const title = flags["title"] ?? null;
      const reviewWaived = !!flags["no-review"];
      const testRequired = !!flags["test-required"];
      return cmdSend(to, type, body, flags["from"] ?? null, refId, runId, options, title, reviewWaived, testRequired);
    },
  },
  {
    name: "task",
    usage: "synapse task <to> <body> [--from NAME] [--ref-id N] [--run-id N] [--body-file PATH] [--handoff kind:path] [--no-review] [--test-required] [--scout]",
    summary: "Assign a TASK to an agent. The recipient replies when done.",
    help: [
      {
        title: "Arguments",
        lines: [
          "to    Recipient agent name (e.g. coder-1).",
          "body  Task description (omit when --body-file is used).",
        ],
      },
      {
        title: "Options",
        lines: [
          "--from NAME        Sender name. Defaults to $SYNAPSE_AGENT.",
          "--ref-id N         Parent message id this task belongs under (e.g. a review TASK on a coder subtask).",
          "--run-id N         Store the message on a specific run.",
          "--body-file PATH   Read body from file (use - for stdin). Avoids shell interpolation of backticks.",
          "--handoff kind:path  Attach an artifact: write <path> to its canonical .synapse/artifacts path (kind: spec/plan/testplan/review/notes) and append that path to the body.",
          "--no-review        Manager -> coder: waive review for this subtask (the done gate won't require a reviewer verdict).",
          "--test-required    Manager -> coder: mark this subtask as needing a tester pass.",
          "--scout            Manager -> coder: read-only investigation, not a change. Prepends the SCOUT marker",
          "                   the coder recognizes, implies --no-review, and conflicts with --test-required.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [to] = positional;
      let body = await resolveBody(context, 1);
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = resolveRunId(flags);
      const handoffPath = await resolveHandoff(context, refId, runId);
      body = withHandoffPath(body, handoffPath);
      requireArgs(context, !!to && !!body);
      return cmdSend(
        to, "TASK", body, flags["from"] ?? null, refId, runId, null, null,
        !!flags["no-review"], !!flags["test-required"], !!flags["scout"],
      );
    },
  },
  {
    name: "ask",
    aliases: ["question"],
    usage: "synapse ask <to> <body> --options a,b,c [--title \"Short title\"] [--from NAME] [--ref-id N] [--run-id N] [--body-file PATH] [--handoff kind:path]",
    summary: "Ask a blocking QUESTION (to operator, --options required — they become the clickable choices).",
    help: [
      {
        title: "Arguments",
        lines: [
          "to    Recipient (usually operator).",
          "body  The question (omit when --body-file is used).",
        ],
      },
      {
        title: "Options",
        lines: [
          "--options a,b,c   Choice labels shown as buttons. Required for a QUESTION to operator — pass 2-4 short, specific labels.",
          "--title TEXT      Short header shown above the body in the QUESTION card.",
          "--from NAME       Sender name. Defaults to $SYNAPSE_AGENT.",
          "--ref-id N        Message id this question references.",
          "--run-id N        Store the message on a specific run.",
          "--body-file PATH  Read body from file (use - for stdin).",
          "--handoff kind:path  Attach an artifact (see 'synapse task') and append its path to the body — e.g. point the operator at the plan you're asking them to approve.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [to] = positional;
      let body = await resolveBody(context, 1);
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = resolveRunId(flags);
      const handoffPath = await resolveHandoff(context, refId, runId);
      body = withHandoffPath(body, handoffPath);
      requireArgs(context, !!to && !!body);
      const options = flags["options"]
        ? flags["options"].split(",").map(s => s.trim()).filter(Boolean)
        : null;
      return cmdSend(to, "QUESTION", body, flags["from"] ?? null, refId, runId, options, flags["title"] ?? null);
    },
  },
  {
    name: "progress",
    usage: "synapse progress <to> <body> [--from NAME] [--ref-id N] [--run-id N] [--body-file PATH] [--handoff kind:path] [--tag start|done|blocked]",
    summary: "Send a one-way PROGRESS signal (no reply expected). Direct-to-operator bodies must lead with [start]/[done]/[blocked]/[step].",
    help: [
      {
        title: "Arguments",
        lines: [
          "to    Recipient (manager, or operator for a lifecycle marker).",
          "body  One-line signal (omit when --body-file is used).",
        ],
      },
      {
        title: "Options",
        lines: [
          "--from NAME       Sender name. Defaults to $SYNAPSE_AGENT.",
          "--ref-id N        Message id this signal relates to (e.g. the TASK it marks progress on).",
          "--run-id N        Store the message on a specific run.",
          "--body-file PATH  Read body from file (use - for stdin).",
          "--handoff kind:path  Attach an artifact (see 'synapse task') and append its path to the body.",
          "--tag start|done|blocked  Prepend the lifecycle marker a direct-to-operator PROGRESS requires,",
          "                          instead of typing '[start]'/'[done]'/'[blocked]' into the body by hand.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [to] = positional;
      let body = await resolveBody(context, 1);
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      const runId = resolveRunId(flags);
      const handoffPath = await resolveHandoff(context, refId, runId);
      body = withHandoffPath(body, handoffPath);
      requireArgs(context, !!to && !!body);
      if (flags["tag"]) {
        const tag = flags["tag"];
        if (!PROGRESS_TAGS.has(tag)) {
          fail(`--tag must be one of ${[...PROGRESS_TAGS].sort().join(", ")}, got '${tag}'`);
        }
        if (!new RegExp(`^\\[${tag}\\]`).test(body)) {
          body = `[${tag}] ${body}`;
        }
      }
      return cmdSend(to, "PROGRESS", body, flags["from"] ?? null, refId, runId);
    },
  },
  {
    name: "reply",
    usage: "synapse reply <ref-id> <body> [--from NAME] [--run-id N] [--body-file PATH] [--handoff kind:path]",
    summary: "Reply to a message by id; recipient is resolved to its sender, so it can't be misrouted.",
    help: [
      {
        title: "Arguments",
        lines: [
          "ref-id  Id of the message you are replying to (shown by 'synapse pending').",
          "body    Reply body (omit when --body-file is used).",
        ],
      },
      {
        title: "Options",
        lines: [
          "--from NAME       Sender name. Defaults to $SYNAPSE_AGENT.",
          "--run-id N        Reply within a specific run.",
          "--body-file PATH  Read body from file (use - for stdin).",
          "--handoff kind:path  Attach an artifact keyed on <ref-id>: write <path> to its canonical .synapse/artifacts path and append that path to the body. A reviewer closes out with --handoff review:<file>.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [refIdStr] = positional;
      let body = await resolveBody(context, 1);
      const refId = parseInt(refIdStr ?? "", 10);
      if (refIdStr && isNaN(refId)) fail(`synapse reply: invalid ref-id '${refIdStr}'`);
      const runId = resolveRunId(flags);
      const handoffPath = await resolveHandoff(context, isNaN(refId) ? null : refId, runId);
      body = withHandoffPath(body, handoffPath);
      requireArgs(context, !!refIdStr && !!body && !isNaN(refId));
      return cmdReply(refId, body, flags["from"] ?? null, runId);
    },
  },
  {
    name: "doc",
    usage: "synapse doc <kind> <ref-id> <file> [--run-id N]",
    summary: "Write an artifact to its canonical path with no message (e.g. a manager's planning docs, referenced later).",
    help: [
      {
        title: "Arguments",
        lines: [
          "kind    One of: spec, plan, testplan, review, notes.",
          "ref-id  Message id this artifact belongs to (e.g. the root TASK id for a plan).",
          "file    Path to the doc content (use - for stdin).",
        ],
      },
      {
        title: "Options",
        lines: [
          "--run-id N  Run whose artifacts/run-N folder receives the file. Defaults to $SYNAPSE_RUN_ID.",
        ],
      },
      {
        title: "Note",
        lines: [
          "Writes the file only — sends no message. To announce an artifact as part",
          "of a message, use --handoff kind:path on task/ask/progress/reply instead.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [kind, refIdStr, file] = positional;
      requireArgs(context, !!kind && !!refIdStr && !!file);
      if (!HANDOFF_KINDS.has(kind)) {
        fail(`kind must be one of ${[...HANDOFF_KINDS].sort().join(", ")}, got '${kind}'`);
      }
      const refId = parseInt(refIdStr, 10);
      if (isNaN(refId)) fail(`synapse doc: invalid ref-id '${refIdStr}'`);
      const runId = resolveRunId(flags);
      if (runId === null || Number.isNaN(runId)) {
        fail("doc needs a run id to place the file — set SYNAPSE_RUN_ID or pass --run-id N.");
      }
      const content = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text().catch(() => {
        fail(`synapse doc: cannot read file '${file}'.`);
        return "";
      });
      if (!content.trim()) fail(`synapse doc: file '${file}' is empty.`);
      const relPath = writeArtifact(kind, refId, content, runId!);
      console.log(`synapse: wrote ${relPath}`);
    },
  },
  {
    name: "step",
    usage: "synapse step <root-id> <step-index> \"<update>\" [--from NAME] [--run-id N]",
    summary: "Tick a plan step done and emit a progress notification.",
    help: [
      {
        title: "Arguments",
        lines: [
          "root-id      The ref-id used when the plan doc was written (same id passed to 'synapse doc plan').",
          "step-index   1-based position of the step in the ## Plan checklist.",
          "update       One-line description of what actually happened at this step.",
        ],
      },
      {
        title: "Options",
        lines: [
          "--from NAME  Sender name for the notification label. Defaults to $SYNAPSE_AGENT.",
          "--run-id N   Run to look up plan steps in. Defaults to $SYNAPSE_RUN_ID.",
        ],
      },
      {
        title: "Note",
        lines: [
          "Plan steps only exist if the plan was written with 'synapse doc plan' or",
          "--handoff plan:<file>. Step index matches the order of '- [ ]' lines under",
          "the '## Plan' heading in the plan doc.",
        ],
      },
    ],
    run: async (context) => {
      const { positional, flags } = context;
      const [rootIdStr, stepIdxStr, update] = positional;
      requireArgs(context, !!rootIdStr && !!stepIdxStr && !!update);
      const rootId = parseInt(rootIdStr, 10);
      const stepIdx = parseInt(stepIdxStr, 10);
      if (isNaN(rootId)) fail(`synapse step: invalid root-id '${rootIdStr}'`);
      if (isNaN(stepIdx) || stepIdx < 1) fail(`synapse step: step-index must be a positive integer`);
      const runId = resolveRunId(flags);
      return cmdStep(rootId, stepIdx, update, flags["from"] ?? null, runId);
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
    usage: 'synapse start --goal "text" [--workdir PATH] [--manager-model MODEL] [--no-monitor] [--no-headroom]',
    summary: "Start a new run: launch manager with the given goal.",
    help: [
      {
        title: "Options",
        lines: [
          '--goal text             Goal to send to manager as the root TASK (required).',
          '--workdir PATH          Absolute path to the code repo agents will work in. Defaults to the synapse project root. Use when the code lives somewhere other than the directory containing .synapse/ (e.g. synapse is in ~/tasks/ but the repo is in ~/repos/myproject).',
          `--manager-model MODEL   Model for the manager agent (default: "${DEFAULT_MANAGER_MODEL}").`,
          "--no-monitor            Create the team without starting the monitor.",
          "--no-headroom           Disable the headroom MCP server (attached by default).",
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
      return cmdStop(name, flags["session"], runId);
    },
  },
  {
    name: "spawn",
    usage: "synapse spawn <role> [--model MODEL] [--focus text] [--run-id N] [--no-headroom]",
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
          "--no-headroom   Disable the headroom MCP server (attached by default).",        ],
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
      return cmdAttach(name, flags["session"]);
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
      // cmdUi validates --port itself and reads --dev from SYNAPSE_DEV.
      if ("dev" in flags) process.env.SYNAPSE_DEV = "1";
      cmdInit();
      return cmdUi(flags);
    },
  },
  {
    name: "done",
    usage: 'synapse done [run-id] [--reason "<text>"] [--status done|failed] [--ref-id N] [--force]',
    summary: "Mark the active run done or failed (manager owns this; blocks on open subtask chains unless --force).",
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
          "--force               Close even with open (unreported/unreviewed) subtask chains; requires --reason and is logged to events.",
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
      const force = !!flags["force"];
      if (force && !summary) fail("synapse done --force requires --reason \"<why>\" so the override is auditable.");
      return cmdDone(flags["status"] ?? "done", summary, null, refId, runId, force);
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
