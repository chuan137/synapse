# Claude Team Synapse — Design Spec

Status: draft, no implementation yet.

## Goal

Run multiple Claude Code agents as a coordinated team, each in its own tmux
window, exchanging messages through a shared SQLite mailbox. A monitor
process watches each agent for idleness and delivers queued messages by
injecting keystrokes into its pane. A separate audit pipeline tails each
agent's session transcript and produces human-readable activity summaries.

## Components

### 1. tmux layout

- One tmux session per team (e.g. `team`), one window per agent.
- Window naming convention encodes role and instance: `planner`,
  `coder-1`, `coder-2`, `reviewer`. The monitor and message bus use this
  name as the agent's address — no separate ID mapping needed.
- Each window launches `claude` (or `claude --resume <session-id>`) in a
  working directory specific to that agent's role.
- A window's Claude Code session ID is needed by the monitor (see
  Idle Detection). Captured either by parsing it from the session-start
  banner in the pane, or by having the launch wrapper write it to a known
  location (e.g. `.synapse/<window-name>.session-id`) right after start.

### 2. Message bus (SQLite)

One DB file shared by all agents and the monitor, with two tables: an
`agents` registry (so the session-id and status of every window is looked
up, not scraped) and a `messages` mailbox.

```sql
CREATE TABLE agents (
  window_name TEXT PRIMARY KEY,    -- tmux window name == agent address
  role        TEXT NOT NULL,       -- planner | coder | reviewer | ...
  session_id  TEXT,                -- Claude Code session id, for jsonl path
  status      TEXT NOT NULL DEFAULT 'unknown',  -- idle | busy | unknown
  last_seen_at TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,       -- references agents.window_name, or 'broadcast'
  type       TEXT NOT NULL DEFAULT 'INFO',  -- TASK | STATUS | REVIEW | ACK | INFO
  ref_id     INTEGER,             -- id of the message this one replies to/closes
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | read | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
```

`ref_id` is what makes the team's interactions traceable: a `STATUS`
message sets `ref_id` to the `TASK` it's closing out, a `REVIEW`'s
follow-up `STATUS` points back to the `REVIEW`. Without it, the message
log is just a flat chat transcript with no way to tell which task a given
status report belongs to.

**Session id.** Each agent registers itself in `agents` right after start
(a `synapse-register <window-name> <role> <session-id>` call from the launch
wrapper, or from the agent itself on its first turn). This replaces
parsing the session-start banner out of the pane — the monitor and the
audit pipeline both just read `agents.session_id` to find the right jsonl
file. The monitor updates `agents.status`/`last_seen_at` as it observes
idle/busy transitions (see Idle Detection), so `agents` doubles as a live
status board for the team.

**Message type.** `type` is a required, small closed vocabulary rather
than free text, so the monitor/audit can route and log meaningfully
without parsing message bodies:
- `TASK` — assignment of work, expects eventual `STATUS`.
- `STATUS` — progress/completion report on a previously assigned task.
- `REVIEW` — request for another agent (typically reviewer role) to look
  at something.
- `ACK` — lightweight acknowledgment, no reply expected.
- `INFO` — anything else (FYI, broadcast notices, etc.).

- Agents don't touch SQLite directly — they call a small CLI
  (`synapse-send <to> <type> "<message>"`) exposed as a tool/skill, which
  inserts a row. This keeps the write path uniform and avoids giving every
  agent raw DB access.
- The monitor is the only reader/writer that transitions `pending` →
  `delivered`. WAL mode recommended for concurrent access from many
  agent-side CLI invocations plus the monitor.
- `broadcast` as `to_agent` value fans out to all windows except sender;
  monitor expands this at delivery time rather than storing N rows.

### 3. Idle detection

Detection is event-driven off the Claude Code session transcript
(`~/.claude/projects/<project-slug>/<session-id>.jsonl`), not pane-text
polling.

- Tail the jsonl per agent (`tail -f` or inotify watch).
- Each `assistant` entry has `message.stop_reason`:
  - `tool_use` → turn continues automatically, agent is busy.
  - `end_turn` → agent has finished its turn and is sitting at the prompt.
- Idle = last assistant entry has `stop_reason: "end_turn"` AND no new
  jsonl lines for a short debounce window (e.g. 2s), to avoid acting on a
  transient end_turn that's immediately followed by more activity (rare,
  but a debounce removes the race instead of reasoning about why it could
  occur).
- No reliance on parsing rendered terminal output — avoids spinner frames,
  ANSI codes, line-wrap, and other rendering noise that plagues pane
  scraping.
- Open question: confirm there's no simpler explicit "turn boundary" event
  already emitted (e.g. via a hook) before building the jsonl-diffing
  logic — worth a short investigation before implementation.

### 4. Message delivery

- When the monitor sees an agent go idle AND there's a `pending` message
  addressed to it, it delivers via:
  `tmux send-keys -t team:<window-name> "<message>" Enter`
- Multiple pending messages for the same agent: deliver oldest first,
  one at a time, re-checking idle state between deliveries (the agent's
  next turn may itself produce `tool_use` activity before reading further
  messages).
- Mark row `delivered` immediately after the send-keys call succeeds;
  `read` status is aspirational (would require the agent to ack — out of
  scope for v1, see Open Questions).
- Failure handling: if `send-keys` targets a dead/closed window, mark the
  row with an error state rather than silently dropping it (exact column
  TBD — maybe reuse `status = 'failed'`).

### 5. Audit pipeline

Two complementary mechanisms, not one — self-reported events for the
"why," and external transcript summarization for the "what happened"
fallback/detail. They answer different questions and are built in two
phases, not in parallel:

- **Phase 1: self-reported events.** Build this first. It reuses the same
  CLI-call shape as `synapse-send`, requires no transcript parsing, and
  captures intent directly ("I chose X over Y because Z") instead of it
  being inferred after the fact. Sufficient for "give a readable
  narrative of what the team did."
- **Phase 2: transcript tailing.** Add later, specifically when
  independence from the agent's own cooperation starts to matter — e.g.
  once the team runs with less supervision and "the agent said it was
  done" isn't good enough on its own. Self-reported events can be
  skipped or — for a decision an agent would rather not surface —
  selectively omitted; the transcript can't be, since it captures every
  tool call regardless of whether the agent thought it worth reporting.
  This is also the harder build (jsonl schema stability, summarization
  cost over large/noisy tool payloads), which is a second reason to defer
  it rather than build both at once.

**Self-reported events (Phase 1, agent-initiated).** The agent itself
calls a `synapse-log <type> "<summary>"` skill/CLI at meaningful lifecycle
points: starting a task, closing a task, making a notable decision. This
is the agent narrating its own intent in its own words, at the moment it
matters, rather than an external process inferring intent after the fact.

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  type       TEXT NOT NULL,   -- task_start | task_end | decision
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- Requires each role's instructions (CLAUDE.md / system prompt) to
  explicitly call out when to log: e.g. "call synapse-log task_start before
  beginning assigned work, task_end when done, decision whenever you
  choose between two reasonable approaches."
- This is opt-in/best-effort by the agent — it can be skipped or
  forgotten, which is why it's paired with the passive mechanism below
  rather than relied on alone.

**Transcript summarization (Phase 2, external, comprehensive).** Same
jsonl tail used for idle detection feeds a second consumer: a periodic
(or triggered-on-idle) summarization pass over the raw transcript,
producing a rolling activity digest per agent (tool calls made, messages
sent/received, outcome) — this catches everything the self-reported
events might have missed or glossed over.

- Digests written to a per-agent audit log (e.g.
  `.synapse/audit/<window-name>.md`), appended incrementally rather than
  regenerated from scratch each time, to keep cost bounded as sessions
  grow long. Self-reported `events` rows can be interleaved into the same
  digest by timestamp for a combined narrative.
- Audit is read-only / observational — neither mechanism feeds back into
  the agent's own context or influences delivery logic, to keep the audit
  trail trustworthy as an independent record.

### 6. Team management

#### 6.1 Defining a team

A team is declared in a config file (e.g. `team.yaml`), not assembled by
hand:

```yaml
session: team
agents:
  - name: planner
    role: planner
    cwd: ./planner
  - name: coder-1
    role: coder
    cwd: ./coder-1
  - name: coder-2
    role: coder
    cwd: ./coder-2
  - name: reviewer
    role: reviewer
    cwd: ./reviewer
```

Each `cwd` has its own `CLAUDE.md` describing that role's responsibilities
and, critically, the Synapse conventions it must follow: when to call
`synapse-send` (and with which `type`), when to call `synapse-log`, and who it
typically reports to. Role behavior lives entirely in these files — the
bus and monitor have no concept of "planner" vs "coder," only of message
types and idle/busy state.

#### 6.2 Starting the team

A single `synapse-start team.yaml` does, in order:

1. Create the tmux session (`team`), one window per config entry.
2. In each window: `cd <cwd> && claude`, then capture the new session id
   and call `synapse-register <name> <role> <session-id>` to populate
   `agents`.
3. Start the monitor (idle detection + delivery) as its own process —
   either a background process or its own tmux window (e.g. `monitor`),
   so it's inspectable the same way agent windows are.
4. Register the human operator as a pseudo-agent (`operator`) in `agents`
   so the initial goal and any later interjections are just ordinary
   messages, not a special-cased channel.
5. Send the initial goal as a `TASK` message from `operator` to `planner`
   — this is what actually kicks the team into motion; nothing runs
   before this message is delivered.

#### 6.3 Assigning tasks

- The human operator's `TASK` to `planner` carries the overall goal in
  free text (`ref_id` null — it's a root task).
- `planner` decomposes the goal and sends one `TASK` message per subtask
  to the relevant coder window(s), `ref_id` null (new tasks) but the body
  should include enough acceptance criteria that the coder can self-judge
  "done."
- When a coder finishes (or gets blocked), it sends `STATUS` back to
  `planner` with `ref_id` set to the originating `TASK`'s id. `planner`
  uses `ref_id` to track which subtasks are outstanding rather than
  keeping that state only in its own context window — the DB is the
  source of truth for "what's still open," not the planner's memory.
- `planner` only considers the root goal complete once all subtasks it
  issued have a terminal `STATUS` (done or explicitly abandoned).

#### 6.4 How agents interact

Default topology is hub-and-spoke through `planner` for task
assignment and status, with one explicit exception for review:

```
operator --TASK--> planner --TASK--> coder-1
                       ^                |
                       |             REVIEW
                    STATUS              v
                       |             reviewer
                       +----STATUS-----+
```

- `TASK` / `STATUS` always flow through `planner` — it's the only agent
  that hands out work and the only one that needs the full picture to
  decide what's next.
- `REVIEW` is peer-to-peer (coder → reviewer directly) rather than routed
  through `planner`, since planner doesn't need to be in the loop for
  every review round-trip — only the final `STATUS` (review passed/failed)
  needs to reach planner, with `ref_id` chasing back to the original
  `TASK`.
- `ACK` is used for low-stakes "got it, working on it" replies that don't
  need a `STATUS` round-trip later.
- This keeps `planner` from being a bottleneck on review iteration while
  still giving it a single, complete view of task lifecycle via `ref_id`
  chains.

#### 6.5 Stopping / lifecycle control

- `synapse-stop <name>` kills that window and sets `agents.status` to
  `stopped` — distinguishes "intentionally shut down" from "looks idle"
  in monitor/audit views.
- Full teardown kills the tmux session; the SQLite DB and audit logs are
  not deleted, so a finished or aborted run can be inspected after the
  fact.
- Staleness (an agent with a `TASK` outstanding but no `STATUS` and no
  `last_seen_at` update past some timeout) is surfaced to `planner` (and/or
  the human operator) as a notice, not auto-resolved — the monitor stays
  mechanical (idle detection + delivery) and leaves judgment calls
  ("reassign? nudge? escalate to human?") to the agents themselves.

#### 6.6 Operator interaction

The human operator already has a CLI by construction — `agents` includes
`operator` as a row, and sending a message is the same
`synapse-send <to> <type> "<message>"` call any agent uses. The remaining
question is what else the operator needs: a way to see status, and a way
to intervene directly. Three tiers, in increasing cost:

- **Direct tmux attach (free).** Every agent is a real, ordinary tmux
  window — `tmux attach -t team:coder-1` lets the operator watch or type
  into any agent exactly as the monitor's send-keys does. Nothing to
  build; this exists purely because of how the substrate is built, and
  it's the escape hatch for debugging or hands-on intervention when
  messaging through the bus isn't enough.
- **`synapse` CLI subcommands (cheap, recommended for v1).** Thin wrappers
  over the SQLite tables already speced — no new infrastructure, just
  read/write access to tables that exist for other reasons:
  - `synapse send <to> <type> "<msg>"` — same path agents use.
  - `synapse status` — table of `agents`: role, idle/busy, `last_seen_at`,
    outstanding `ref_id`(s).
  - `synapse log <agent>` — tail that agent's audit digest/events.
  - `synapse attach <agent>` — friendlier wrapper around `tmux attach`.
- **A live status view ("UI"), built from the CLI, not a separate app.**
  Run `watch -n2 synapse status` in its own tmux pane in the same session —
  a continuously-refreshing dashboard with no web server, no GUI, no
  second surface to maintain. It's the same CLI, rendered live, inside
  the environment everything else already lives in.

Recommendation: no standalone UI/web app for v1. A dedicated GUI would be
a second surface — a different process presenting the same SQLite state
a different way — which cuts against the single-host, tmux-resident
design assumed elsewhere in this spec (see Out of scope). The CLI plus a
`watch`'d status pane covers visibility; direct tmux attach covers
hands-on intervention. Between the two there isn't a gap a GUI would
close for v1 — revisit only if status/history needs outgrow what fits in
a terminal pane.

## Bootstrap modes

Section 6.2 assumes a human runs `synapse-start team.yaml` before any agent
exists. A second, equally valid entry point: the human just opens one
interactive Claude CLI session and prompts it directly ("set up a team to
do X"). That collapses "write a YAML file" into "describe what you want,"
but it forks into two materially different architectures depending on
whether the resulting team members end up as separate processes or not.

### Mode A — prompted, separate windows (still tmux + SQLite)

The session the human is talking to plays `planner`. Instead of an
external script performing bootstrap, `planner` does it itself,
reactively, using its own Bash access:

- decides team composition from the prompt (how many coders, is a
  reviewer needed) instead of reading it from a YAML — team shape is
  improvised at prompt time, not declared upfront,
- creates the tmux windows and runs `cd <dir> && claude` in each,
- captures each new session id and calls `synapse-register` itself,
- then proceeds exactly as in 6.3 — sends `TASK` messages to the windows
  it just created.

Everything in sections 2–6 (SQLite bus, jsonl idle detection, send-keys
delivery, audit) applies unchanged — the only things that moved are *who*
performs the bootstrap step (the planner agent itself, not a pre-run
script) and *when* team shape gets decided (at prompt time, not config
time). This is the natural mode for ad hoc or one-off teams where writing
a YAML first is more overhead than it's worth.

### Mode B — prompted, in-process (no separate windows at all)

Alternatively, `planner` doesn't spin up other tmux windows/CLI processes
at all. It dispatches coder/reviewer work as sub-agent calls within its
own process and gets the result back inline, synchronously, as a return
value — no second process, no second tmux window.

This is a fork in the whole architecture, not just a startup detail:

- No separate tmux window, no separate Claude CLI session, no jsonl
  transcript per role — so idle detection (3), send-keys delivery (4),
  and the `agents` session-id registry (2) don't apply at all. There's
  nothing to poll for idleness; the call blocks until the sub-agent
  returns.
- No SQLite mailbox needed either — `planner` gets the sub-agent's result
  directly as the call's return value, not as a `STATUS` row it has to
  notice later via polling.
- Loses: persistence (a sub-agent call isn't a resumable session you can
  message again later), standing concurrency (several sub-agents can be
  dispatched in one turn for parallel work, but each is a self-contained
  call-and-return, not a process that stays around to receive a second
  message), and the live status-board property of `agents` (nothing to
  show as "currently idle" since nothing is ever idle — it's either
  running or finished).
- Gains: far less infrastructure — no `team.yaml`, no bus, no monitor
  process to keep alive, no audit pipeline to wire up. Good fit for
  shorter, more supervised tasks where the human is actively driving the
  one open session.
- Audit, if wanted here, reduces to "log the dispatch prompt and the
  returned result" — there's no transcript to tail, since a sub-agent's
  intermediate steps aren't independently observable the way a full
  Claude CLI session's jsonl is.

### Which mode this spec targets

Sections 1–6 are written for Mode A (and the originally-scripted variant)
— they assume persistent, independently addressable agents that can
receive a second message after finishing their first task, which is what
makes the mailbox/idle-detection/audit machinery worth building at all.
Mode B is a legitimate alternative but a meaningfully simpler system with
none of that machinery; worth naming explicitly so it's a deliberate
choice rather than something this spec quietly forecloses.

## Execution plan

Ordered so each phase validates the riskiest/cheapest-to-test part of the
next phase before more is built on top of it — same logic already
applied to the audit-pipeline ordering above.

**Phase 0 — Foundations.** SQLite schema (`agents`, `messages`, `events`,
WAL mode) and the `synapse` CLI skeleton: `synapse-register`, `synapse-send`,
`synapse-log`, `synapse status`. No tmux automation yet — just confirm the
schema and CLI ergonomics are right, since everything else builds on
this.

**Phase 1 — Manual single-agent loop.** One tmux window running `claude`,
registered by hand. Send it a `TASK` via `synapse-send` and deliver it by
manually running `tmux send-keys` — no monitor process yet. Purpose: this
is the smallest possible thing that exercises the actual message format
end to end, before automating delivery makes mistakes harder to see.

**Phase 2 — Idle detection + monitor, two agents.** Build the jsonl
tailer (assistant `stop_reason: end_turn` + debounce) and the monitor
loop (poll `pending` rows for idle agents, deliver, mark `delivered`).
Test with exactly two windows — `planner` and one `coder` — running a
real `TASK` → `STATUS` round trip with no human pressing send-keys by
hand. This is the riskiest unverified piece (jsonl schema assumptions
from section 3), so it's isolated here before scaling to a full team.

**Phase 3 — Full team + bootstrap (Mode A).** `team.yaml` format and
`synapse-start`; scale to the full role set (planner, 2 coders, reviewer);
implement the `REVIEW` peer-to-peer path and `ref_id` correlation across
multi-step task chains (6.3/6.4). Mode B (in-process sub-agents) is not
built in this plan — it's a different, simpler system, noted but
deliberately out of scope here.

**Phase 4 — Self-audit.** `synapse-log` + `events` table, and role
`CLAUDE.md` templates updated to call it at task_start/task_end/decision.
Deferred to after Phase 3 rather than built earlier, since it needs a
real multi-agent run to be worth evaluating against.

**Phase 5 — Operator tooling.** `synapse status` / `synapse log` /
`synapse attach` subcommands, plus the `watch`-based live status pane
(6.6). No new state — purely a presentation layer over what Phases 0–4
already produce.

**Deferred / explicitly not in this plan:** transcript-tailing audit
(audit Phase 2, section 5), staleness/reassignment policy, and
`--resume` re-registration semantics — all still open questions below,
and each is more productively settled by running Phases 1–5 first.

## Open questions

- Which mode (A: prompted-but-still-tmux, or B: in-process sub-agents) is
  actually in scope for v1 — the rest of this spec only makes sense for A.
- Should there be an explicit `read` acknowledgment step (an `ACK`
  message back), or is `delivered` status sufficient for v1?
- Self-reported events rely on each role's instructions actually telling
  it to call `synapse-log` — how is that enforced/checked, if at all,
  beyond "it's in the CLAUDE.md"?
- On `--resume`, does the agent re-register (new row write) or update its
  existing `agents` row in place? Affects whether `agents.session_id`
  history is preserved or overwritten.
- Reassignment policy when a coder stalls (6.5 says it's surfaced, not
  auto-resolved) — does `planner` get a fixed playbook (e.g. nudge once,
  then reassign), or is that left entirely to its judgment per situation?
- Multiple coders, one subtask each is assumed in 6.3 — not specified:
  can `planner` split a single subtask across two coders, and if so how
  do their `STATUS` replies merge under one `ref_id`?
- Backpressure: what happens if an agent is flooded with messages faster
  than it can act on them between idle windows?

## Out of scope (for now)

- Authentication/access control on the SQLite mailbox (single-user,
  single-machine assumption).
- Cross-machine deployments (tmux + local SQLite implies single host).
- Automatic recovery/restart of crashed agent windows.
