# Synapse — Architecture

_As-built overview of the Synapse codebase. Reflects schema v12 / CHANGELOG v0.0.3.
For the original pre-implementation design, see `synapse-spec.md` (historical) and
`bootstrap-spec.md`._

## What Synapse is

Synapse runs several Claude Code agents as a coordinated team. Each agent is its
own `claude` process in its own tmux window; they never talk to each other
directly. Instead they exchange messages through a shared SQLite mailbox, and a
separate **monitor** process watches each agent's transcript, decides when it has
gone idle, and injects a nudge into its tmux pane so the agent pulls its queued
mail. A human **operator** drives and observes the team through a CLI and a local
web UI.

The whole system is a single Bun/TypeScript program compiled to one binary
(`bin/synapse`). There is no server daemon beyond the monitor and the optional UI;
state lives entirely in the SQLite file and the filesystem.

## Runtime topology

```
                         operator (human)
                        /                \
                 synapse CLI          synapse ui  (Bun.serve, SSE)
                        \                /
                         v              v
                     ┌──────────────────────┐
                     │   .synapse/synapse.db │  ← SQLite mailbox (WAL)
                     │   agents · messages   │     shared by everyone
                     │   events · runs       │
                     └──────────────────────┘
                        ^                ^
              writes/reads          reads state,
              (synapse send/         nudges panes
               pending/done)              │
                        │                 │
   tmux session "slug-hash-runid"         │
   ┌───────────┬───────────┬───────────┐  │
   │ monitor   │ manager   │ coder-1   │  │
   │ window    │ window    │ reviewer… │◄─┘  monitor injects
   │ (sweep)   │ (claude)  │ (claude)  │     `synapse pending <name>`
   └───────────┴───────────┴───────────┘     into idle panes
```

One **run** = one team = one tmux session = one row in `runs`. The tmux session is
named `<projectSlug>-<pathHash>-<runId>` (e.g. `syn-488d-9`); window 0 is the
monitor, and every other window is one agent addressed by its window name
(`manager`, `coder-1`, `reviewer`, …).

## Components

The source is small — five TypeScript modules under `src/`, plus the browser
frontend under `public/`.

### CLI dispatch — `src/synapse.ts` (~490 lines)

The entry point. Defines a `COMMANDS` table (each with `name`, `aliases`, `usage`,
help sections, and a `run` handler), a tiny `parseFlags` that splits `--key value`
pairs and booleans from positionals, and a help renderer. `main()` looks up the
command by name/alias and dispatches. `SYNAPSE_VERSION` is injected at compile time
via `bun build --define` and falls back to `"dev"` when run uncompiled.

Commands: `help`, `version`, `init`, `register`, `send`, `status`, `runs`,
`pending`, `deliver`, `monitor`, `start`, `stop`, `spawn`, `attach`, `ui`, `done`,
`set-goal`.

### Message bus & persistence — `src/db.ts` + `src/schema.sql`

`db.ts` owns the SQLite connection and migrations. `connect()` opens the DB with
`journal_mode=WAL`, `foreign_keys=ON`, and `busy_timeout=5000` — WAL plus the busy
timeout is what lets the monitor, CLI, and UI all touch the file concurrently
without spurious `SQLITE_BUSY`.

`initDb()` is the migration engine. The current schema is **v12**, tracked in
`PRAGMA user_version` so version detection works before any table exists.
Non-destructive column adds (v2→v3, v4→v12) run as in-place `ALTER TABLE` steps
chained by version number. The one breaking change (v3→v4, which changed the
`agents` primary key) can't be done with `ALTER TABLE`, so any DB older than the
binary's schema that can't be stepped forward triggers a **backup-and-rebuild**:
the entire data directory is renamed to `.synapse.vN.bak-<timestamp>` and a fresh
DB is created. That is why the repo contains `.synapse.v3.bak-*` and
`.synapse.v4.bak-*` folders. `schema.sql` is imported as text and applied
idempotently (`CREATE TABLE IF NOT EXISTS`).

`db.ts` also defines the on-disk layout helpers: `dbPath()` (from `$SYNAPSE_DB`,
else `./.synapse/synapse.db`) and `defaultAgentDir()` (per-agent scratch cwd under
`.synapse/workdirs/<run-folder>/<agent-name>`).

### Agent bootstrap & CLI commands — `src/commands.ts` (~860 lines)

The bulk of the CLI logic and all of team bootstrap.

**Sending / receiving.** `cmdSend` validates the message type, rejects unsupported
patterns (a `broadcast` recipient; a `QUESTION` to `operator` with no `--options`;
a numbered list crammed into one line with no breaks; a non-manager agent sending
direct `PROGRESS` to operator without a `[start]`/`[done]`/`[blocked]`/`[step]`
lifecycle prefix), resolves the run id (flag → `SYNAPSE_RUN_ID` → null), and
inserts the row. `cmdPending` is how an agent pulls its mailbox: it prints pending
messages and, when the caller *is* the target agent (`SYNAPSE_AGENT` matches),
marks them `read` in the same pass. For the manager it first prints an
"unrelayed checkpoint" — `ref_id` chains it received but never relayed to operator.

**Starting a run — `cmdStart`.** Inserts a `pending` run row to reserve an id,
derives the tmux/session name, creates the `artifacts/` and `workdirs/` folders,
registers the `operator` pseudo-agent (sentinel `run_id = 0`), creates the tmux
session with a `monitor` window sized to the terminal, launches **only** the
manager (the manager spawns workers itself), starts the monitor in window 0,
queues the goal as the root `TASK` to the manager, and flips the run to `running`.
If any tmux step fails it deletes the reserved run row and aborts.

**Launching an agent window — `launchAgentWindow`.** Each agent runs `claude`
directly in a real tmux TTY (no pty wrapper). Synapse passes `--session-id`
explicitly so the transcript path is known up front (no polling for a new jsonl).
The launch is wrapped in `direnv exec <projectRoot>` so the agent inherits the
project's `.envrc` rather than the launching shell's env. The initial prompt is
just `synapse pending <name>` — the agent pulls its own work the instant the
session loads. `--dangerously-skip-permissions` clears per-tool approval and
`--disallowedTools AskUserQuestion,EnterPlanMode` blocks the two interactive tools;
`presetClaudeTrust` writes `hasTrustDialogAccepted` into `~/.claude.json`
(keyed by the **symlink-resolved** cwd) to clear the one-time workspace-trust
dialog before launch.

**CLAUDE.md assembly.** Each agent's `CLAUDE.md` is assembled from three segments:
`templates/shared.md` (identical for all), the role template
(`templates/role-<role>.md`), and an optional per-agent "focus" instance block.
It's regenerated and overwritten on every launch. The packaged skills are also
installed into each agent's own `.claude/skills/` (Claude Code only discovers
skills under its launch cwd), driven by `src/skills.generated.ts` — generated from
`skills/` by `scripts/gen-skills.ts` at build time.

**Other commands.** `cmdSpawn` adds a worker to a running run (names it
`role`, `role-2`, … by counting existing agents of that role). `cmdDone` writes the
run's terminal status and sends the final `REPLY` to operator. `cmdStop` marks one
agent stopped and kills its window. `cmdSetGoal` updates a run's goal.
`migrateLegacyFolders` renames the old `runs/`→`artifacts/` and `agents/`→`workdirs/`.

### Monitor — `src/monitor.ts` (~820 lines)

The heartbeat. A single **sweep loop** on a fixed cadence (default 250ms) is the
sole driver of busy/idle evaluation and message delivery.

**Idle detection.** For each agent, the monitor reads its Claude Code transcript
(`~/.claude/projects/**/<session-id>.jsonl`, located by globbing since the session
id is unique) and looks at the last well-formed assistant entry's `stop_reason`.
Anything other than `end_turn` means busy. `end_turn` plus a quiet window
(`debounce`, default 2000ms) means idle. If there's no transcript or no assistant
turn yet, the agent is `unknown`; after `DEFAULT_UNKNOWN_IDLE_TIMEOUT_MS` (30s) an
`unknown` agent is forced idle so a stuck agent isn't stranded. Agents with no
session id fall back to scraping the tmux pane for a shell prompt.

`fs.watch` (via `FileWatchPool`) plays a deliberately narrow role: it only records
a high-resolution "last write observed" timestamp per transcript so the debounce
math isn't limited by coarse filesystem mtime granularity. It never triggers
delivery — only the sweep does. Each sweep also records each agent's context-token
usage from the transcript's latest `usage` block.

**Delivery & enforcement.** When an agent goes idle, the monitor first runs a
**send-back check** (`nudgeForMissingStatusBeforeMoreWork`): if a coder/reviewer
still owes a `REPLY` on an open inbound `TASK`, it injects a reminder to send that
REPLY and *holds* further delivery (with a 60s cooldown so it doesn't spam). The
coder check is aware that a coder legitimately blocked waiting on a reviewer isn't
delinquent. Only once nothing is owed does it nudge the agent with
`synapse pending <name>` if pending mail exists. Nudges are literal tmux
`send-keys` (`-l` for literal text, then a separate `Enter` keypress).

**Lifecycle.** A `monitor-<session>.pid` lockfile prevents two monitors per
session. When a run reaches terminal state the monitor stays alive so the team
remains inspectable, but an **auto-teardown** fallback disbands it after
`DEFAULT_AUTO_TEARDOWN_MS` (30 min) if nobody kills the session. `disbandTeam`
kills every non-operator window and the tmux session, marks agents stopped, and
stamps `runs.session_killed_at` — the DB audit trail is never deleted, only the
live tmux tree. Transient DB errors during a sweep are caught and retried on the
next tick rather than killing the monitor.

### Web UI — `src/ui.ts` (~650 lines) + `public/`

`startUi` runs a `Bun.serve` HTTP server (default port 7700). The frontend is a
single-page app: `public/index.html` + `public/styles.css` + `public/app.js`
(~1670 lines, vanilla JS). Assets are bundled into the binary as text imports; in
`--dev` mode they're read from disk on every request and file changes push a live
reload over SSE.

Live updates flow over a **Server-Sent Events** stream at `/events`. A 1-second
`pollDb` timer diffs the DB and pushes named events to all connected clients:
`agent-status`, `message-stream` (operator↔agent messages), `manager-activity-stream`
(manager→worker delegations, so the operator sees the team working), and
`runs-list`. The operator thread and runs list are also pushed on connect.

HTTP endpoints: `GET /` `/styles.css` `/app.js` (assets), `GET /events` (SSE),
`GET /info` `/runs` `/thread` `/file`, and `POST /send`, `/open-file`,
`/focus-agent` (tmux `switch-client` to bring a window forward, plus an AppleScript
to raise the terminal), `/start`, `/kill-session`, `/finish-run`, `/upload`.
`/file` and `/open-file` are path-guarded to the project root. `/finish-run` calls
`cmdDone` then `disbandTeam`; `/kill-session` only disbands an already-terminal run.

### Templates & skills

`templates/` holds the CLAUDE.md building blocks: `shared.md` (the team protocol —
roles, message types, hub-and-spoke routing, bootstrap rules) and one
`role-<role>.md` per role (`manager`, `coder`, `reviewer`, `tester`). `skills/`
holds the operator-facing skills (`synapse-operator`, `synapse-planning`, `tmux`)
that get compiled into `skills.generated.ts` and installed into each agent's and
the project's `.claude/skills/`.

## Data model

Four tables (`src/schema.sql`):

| Table | Purpose | Key columns |
|---|---|---|
| `agents` | Registry of every window in a run | `window_name`, `run_id` (0 = operator sentinel), `role`, `model`, `session_id`, `status` (idle/busy/stopped/unknown), `context_tokens`; `UNIQUE(window_name, run_id)` |
| `messages` | The mailbox | `run_id`, `from_agent`, `to_agent`, `type`, `ref_id`, `body`, `title`, `options` (JSON, for QUESTION), `status` (pending/read/failed), `retry_count`, `next_retry_at` |
| `events` | Audit log of task_start/task_end/decision | `agent`, `type`, `summary`, `run_id` |
| `runs` | One team instance | `session` (tmux name), `goal`, `status` (running/completed/failed/aborted), `started_at`, `ended_at`, `session_killed_at` |

Addressing is by `window_name`; there is no separate agent id mapping. `run_id = 0`
is the sentinel for the `operator` pseudo-agent, which is shared across runs — that
is why operator is registered as a real row rather than special-cased.

## Message protocol

Four message types, routed hub-and-spoke through the manager:

- **`TASK`** — a work assignment; expects a `REPLY` closing it. A review request is
  also a `TASK` (coder → reviewer).
- **`QUESTION`** — blocking; halts the sender until answered. A QUESTION to
  `operator` **requires `--options`** (2–4 labels) because the UI card renders
  clickable choices and has no generic fallback.
- **`PROGRESS`** — one-way status ping, no reply expected. A non-manager agent may
  send `PROGRESS` directly to operator only as a lifecycle marker prefixed
  `[start]`/`[done]`/`[blocked]`/`[step]` (see `progress-direct-signal-spec.md`).
- **`REPLY`** — the answer / done-report that closes a `ref_id`.

`ref_id` is what makes the log traceable: a REPLY points back at the TASK it closes,
so a run is a tree of linked chains rather than a flat transcript. Code changes
generally require peer review (coder ↔ reviewer, direct), and the tester reports
pass/fail directly to the manager; everything else funnels operator ↔ manager.

## Key flows

**Start a run.** `synapse start --goal "…"` (or UI `/start`) reserves a run row →
creates tmux session + monitor window → launches the manager with initial prompt
`synapse pending manager` → starts the monitor → queues the goal as the root TASK →
marks the run `running`. The manager wakes, pulls the TASK, decomposes it, and
`synapse spawn`s coders/reviewers/testers as needed.

**Message delivery.** Agent A `synapse send`s to agent B → row lands `pending` →
B's tmux pane goes quiet → next monitor sweep sees B idle → (send-back check
passes) → monitor injects `synapse pending B` → B pulls the row, which flips to
`read` on read.

**Question to operator.** An agent sends a `QUESTION` with `--options` → UI renders
a card with clickable choices in the operator thread → operator clicks → UI `POST
/send` inserts the `REPLY` (with `ref_id`) → monitor delivers it back to the asker,
unblocking it.

**Finish / teardown.** `synapse done` (or UI `/finish-run`) writes the run's
terminal status and the final REPLY to operator. The monitor keeps the team
inspectable until the session is explicitly killed (UI `/kill-session` →
`disbandTeam`) or the 30-minute auto-teardown fires. The SQLite audit trail
survives teardown.

## Build, install, run

Bun + a Makefile. `make build` runs `scripts/gen-skills.ts` then
`bun build src/synapse.ts --compile --define SYNAPSE_VERSION=…` to produce
`bin/synapse`. `make install` symlinks it onto `PATH`. Tests: `make unit`
(`bun test` over `tests/*.test.ts`), `make smoke` (init + status against a temp DB),
`make e2e` (`tests/e2e-monitor.sh`); `make test` runs all three.

Runtime prerequisites: `bun`, `tmux`, `claude` (Claude Code CLI), `direnv`, and
(for `/focus-agent`'s terminal raise) macOS `osascript`.

## On-disk layout

```
.synapse/
  synapse.db                     shared SQLite mailbox (+ -wal, -shm)
  monitor-<session>.pid          monitor lockfile, one per session
  monitor.log                    monitor output (tee'd from tmux window 0)
  artifacts/run-<id>/            manager's specs, test plans, reviews (audit)
  workdirs/run-<id>/<agent>/     each agent's Claude Code cwd + generated CLAUDE.md
.synapse.vN.bak-<timestamp>/     data dir from a superseded schema (rebuild backup)
src/            synapse.ts · db.ts · commands.ts · monitor.ts · ui.ts · schema.sql
public/         index.html · styles.css · app.js   (operator web UI)
templates/      shared.md · role-<role>.md         (CLAUDE.md building blocks)
skills/         operator-facing skills → skills.generated.ts
docs/           this file, plus the design/spec history
```
