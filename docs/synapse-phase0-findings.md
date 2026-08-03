# Synapse — Phase 0 spike findings

Companion to `synapse-plan.md` §"Phase 0 — Spikes". Reports the results of
running S0.1–S0.6. All spikes were run in a throwaway scratch directory, per
the plan's instruction — nothing here is repo structure, and none of it is
kept.

Environment: `claude` 2.1.220, `bun` 1.3.10, macOS (darwin).

Verdict on the plan's own exit gates: **all clear, proceed to Phase 1.** See
"Verdict" at the end.

---

## S0.1 — `claude -p --session-id <uuid>` with tools, single invocation

**Pass condition:** edits a real file, runs a real tool loop, exits 0, in one
invocation.

**Result: PASS**, with a permission behavior that has to be built around.

First attempt — `claude -p --session-id <uuid> --output-format json "Create a
file named hello.txt containing: spike-s01-ok. Then cat it."` — exited **0**,
but `hello.txt` did not exist. The JSON result explained why:

```json
"permission_denials":[
  {"tool_name":"Write","tool_use_id":"...","tool_input":{"file_path":".../hello.txt","content":"spike-s01-ok"}},
  {"tool_name":"Write","tool_use_id":"...","tool_input":{...}}
],
"result":"Still awaiting approval for the write. Could you approve the permission prompt so I can create hello.txt?"
```

**Headless `-p` mode still enforces the permission system by default, and
exits 0 even when every tool call was denied.** A wrapper trusting exit code
alone would see success on a no-op run. `--dangerously-skip-permissions`
exists but was itself blocked by the *outer* session's auto-mode classifier
as too broad a capability to grant a nested call — a real spawn wrapper needs
to run outside a classifier-gated parent, or use scoped tool allowlisting.

Working invocation:

```bash
claude -p --session-id "$SID" --output-format json \
  --allowedTools="Write,Bash(cat *)" \
  -- "Create a file named hello.txt containing exactly: spike-s01-ok. Then run 'cat hello.txt' to verify."
```

Note the `=` form and the `--` separator: `--allowedTools "Write,Bash(cat *)"
"<prompt>"` (space-separated) silently swallowed the prompt as another value
of the multi-value flag and failed with `Input must be provided either
through stdin or as a prompt argument`. `--flag=value -- "prompt"` is the
reliable shape.

With that fixed: exit 0, `permission_denials: []`, `is_error: false`,
`num_turns: 3` (Write → Bash cat → final text), and `hello.txt` on disk
containing exactly `spike-s01-ok`, confirmed with `cat`.

**Implication for `spawn.ts`:** the wrapper must pass an explicit
`--allowedTools` (or equivalent) grant per role — it is part of the dispatch
contract, not an incidental flag — and must not trust exit code 0 alone as
proof of work. This is the same conclusion spec §4.5's three-layer guarantee
already assumes, now confirmed one level below it, at the tool-invocation
layer.

---

## S0.2 — `claude -p --resume <uuid>` on an exited session

**Pass condition:** rehydrates context, answers a follow-up that requires
memory of turn 1.

**Result: PASS.**

Resumed the S0.1 session (long exited) from a different working directory,
asked: *"Without re-reading hello.txt, tell me: what exact text did you write
into hello.txt earlier in this session?"*

```json
{"num_turns":1,"result":"`spike-s01-ok`","cache_read_input_tokens":26056,
 "is_error":false,"stop_reason":"end_turn"}
```

One turn, no Bash/Read tool call — the only cost was a cache read of the
prior transcript — and the answer was exactly the string written in turn 1.
`--resume` on a fully exited process reliably rehydrates full transcript
state from disk. This is the load-bearing assumption behind spec §4.9: the
manager is a persistent *session*, not a persistent *process*.

---

## S0.3 — Stop hook: exact JSON contract

**Pass condition:** fires on turn end; can block the stop and force another
turn; know the exact JSON contract.

**Result: PASS**, contract obtained empirically. (No bundled schema or docs
were found in the installed binary's share directory — it's a compiled
Mach-O with no accessible JS source — so this was captured by installing a
real hook and logging what it actually receives on stdin, not by reading
documentation.)

Registered via `.claude/settings.json`:

```json
{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"/path/to/hook.sh"}]}]}}
```

**Observed stdin payload on a normal (non-blocked) stop, quoted verbatim:**

```json
{"session_id":"838215ce-...","transcript_path":"/Users/.../838215ce-....jsonl",
 "cwd":"/private/tmp/.../s03","prompt_id":"026abb16-...",
 "permission_mode":"default","effort":{"level":"high"},
 "hook_event_name":"Stop","stop_hook_active":false,
 "last_assistant_message":"Hello!","background_tasks":[],"session_crons":[]}
```

Key fields for a Synapse Stop hook: `hook_event_name` (`"Stop"`),
`stop_hook_active` (boolean — `false` on the model's natural stop attempt,
`true` on every subsequent forced re-invocation caused by a prior block; this
is the field to check to avoid an infinite forced-turn loop),
`last_assistant_message`, `transcript_path`, `session_id`, `cwd`.

**Blocking test:** hook returns on stdout

```json
{"decision":"block","reason":"you have not called synapse reply for subtask N (spike test)"}
```

exit 0. Result: the hook fired **10 times** in a row (`stop_hook_active`
`false` → `true` × 9), each time injecting the exact reason string into the
transcript as an automated system message, forcing another model turn each
time — confirmed by grepping the reason string 10 times out of the session's
`.jsonl` transcript. **Then the CLI gave up and returned success anyway:**

```json
{"is_error":false,"num_turns":12,"stop_reason":"end_turn",
 "result":"","terminal_reason":"completed","subtype":"success"}
```

Exit code 0, empty `result`, no error field set. **There is an internal cap
(~10 forced stops) after which the CLI silently stops honoring `block` and
returns success with an empty result, not a failure.** A wrapper that trusts
exit-code-0 or `is_error:false` would treat this as a completed turn even
though the model never called `synapse reply`, and the hook was actively
saying so on every one of the last 10 turns.

**Implication for spec §4.5:** this is exactly why the wrapper (layer 2) and
pid sweep (layer 3) are unconditional and don't trust the hook (layer 1) or
the CLI's own exit code. The hook alone is not sufficient even in its
intended role — a sufficiently stuck model can exhaust the hook's
forced-retry budget and still exit "successfully" with nothing written to its
row. The spec's three-layer design is validated as-is (the wrapper still
catches this case; no reply landed, so it still writes `failed`), but §4.5's
description of layer 1's scope — "does not fire on OOM, non-zero exit, kill,
or context-limit abort" — is now known to be incomplete: it also does not
survive a model that keeps getting blocked and eventually has the block
silently stop being honored. This is a rule-3 case (spec underspecified,
found during implementation) — flagged for a spec diff, not fixed silently.

---

## S0.4 — `Bun.spawn` process-group kill semantics

**Pass condition:** spawn a worker in its own process group; `kill -9` the
group mid-tool-call; parent observes exit, tool subprocesses die too, no
orphans on the worktree.

**Result: PASS.**

`Bun.spawn(["bash", worker.sh], { detached: true, ... })` accepted the option
with no error. `worker.sh` spawned a background subshell (simulating a tool
subprocess) that `sleep 300`s; both logged their own pid/pgid via `ps -o
pgid=`.

```
worker.log: worker pid=78494 pgid=78494
child.log:  child pid=78494 pgid=78494
```

Worker is its own process group leader (`pgid == pid`); the child subprocess
inherited the same pgid, as expected for a bash job spawned without its own
`setsid`.

```
wrapper: worker pgid (via ps) = 78494
wrapper: sending kill -9 to process group -78494
wrapper: kill exit code= 0
wrapper: proc.exited resolved, exitCode= 137 proc.killed= true proc.signalCode= SIGKILL
wrapper: child still alive? kill -0 exit code= 1 (0=alive, nonzero=dead)
wrapper: ps -p childPid output: (empty — no process found)
```

`proc.exited` resolved correctly with `exitCode=137` (128+SIGKILL) and
`signalCode="SIGKILL"`. Sending `kill -9` to the **negative** pgid (group
kill, not just the top pid) killed both the worker and its child subprocess —
confirmed dead by both `kill -0` (exit 1) and `ps -p` (no rows). No orphan.

`Bun.spawn`'s `detached: true` is sufficient for D1/§4.7's process-group
requirement; no `setsid` shim or Node `child_process` fallback is needed.

---

## S0.5 — `bun:sqlite` WAL, 4 read-then-write writers + 1 reader

**Pass condition:** with `BEGIN IMMEDIATE` + `busy_timeout=5000`, no
`SQLITE_BUSY` escapes and no deadlock; reader never blocked. Also confirm the
deferred-transaction version *does* fail, proving the pragma matters.

**Result: PASS on both halves.**

Setup: WAL mode, `busy_timeout=5000`, `foreign_keys=ON`. Each writer runs N
iterations of: `BEGIN [IMMEDIATE]` → `SELECT value FROM counters WHERE id=1`
→ busy-wait 5ms (widens the race window) → `UPDATE ... SET value = old+1` →
`COMMIT`. This is the exact read-then-write shape `nextRev()` will use.

**`BEGIN IMMEDIATE` variant**, 4 concurrent writers × 40 iterations each, 1
concurrent reader running for the same 3-second window:

```
{"writerId":"w1","mode":"immediate","iterations":40,"ok":40,"busyErrors":0,"otherErrors":0}
{"writerId":"w2","mode":"immediate","iterations":40,"ok":40,"busyErrors":0,"otherErrors":0}
{"writerId":"w3","mode":"immediate","iterations":40,"ok":40,"busyErrors":0,"otherErrors":0}
{"writerId":"w4","mode":"immediate","iterations":40,"ok":40,"busyErrors":0,"otherErrors":0}
reader: {"reads":2483649,"errors":0,"maxLatencyMs":6.23,"avgLatencyMs":0.00116}
final counter value: 160  (= 4 × 40, exactly — no lost updates)
```

All 160 writes succeeded, zero `SQLITE_BUSY`, zero deadlocks, final value
exact. Reader did 2.48M reads with 0 errors in the same window; worst-case
single-read latency 6.2ms, average ~1μs — never meaningfully blocked by the
writers holding `IMMEDIATE` locks.

**Deferred `BEGIN` variant** (same shape, `BEGIN` instead of `BEGIN
IMMEDIATE`), same 4×40 writers:

```
{"writerId":"w1","mode":"deferred","iterations":40,"ok":0, "busyErrors":40,"otherErrors":0}
{"writerId":"w2","mode":"deferred","iterations":40,"ok":40,"busyErrors":0, "otherErrors":0}
{"writerId":"w3","mode":"deferred","iterations":40,"ok":0, "busyErrors":40,"otherErrors":0}
{"writerId":"w4","mode":"deferred","iterations":40,"ok":0, "busyErrors":40,"otherErrors":0}
final counter value: 40   (120 of 160 writes silently lost)
```

Three of four writers got `SQLITE_BUSY` on **every single one** of their 40
attempts; `busy_timeout=5000` did not rescue any of them. Confirmed the exact
exception directly:

```
EXACT ERROR MESSAGE: "database is locked"
ERROR NAME: SQLiteError
ERROR CODE: SQLITE_BUSY
```

This matches spec §4.10's claim precisely: a deferred transaction that reads
then writes must upgrade its lock; `busy_timeout` does not apply to a lock
*upgrade* (only to initial lock *acquisition*), so two deferred
read-then-write transactions racing each other get an immediate
`SQLITE_BUSY`, not a retried wait. The pragma is load-bearing, confirmed by
making the failure happen.

---

## S0.6 — Transcript growth: turn latency and cost

**Pass condition:** measure turn latency and cost at ~10 and ~50 manager
turns; establish the verbosity budget.

**Result: measured, no cliff observed through 55 turns.**

Method: one session, 55 sequential `claude -p --resume` turns, each prompted
with a trivial fixed-shape instruction ("reply with exactly: turn N ack",
`--allowedTools="Bash(echo *)"`) to isolate transcript-size effects from
task-complexity effects. `total_cost_usd`, `duration_api_ms`, and
`cache_read_input_tokens` read from each turn's JSON result.

| turn | api_ms | cost (USD) | cache_read tokens |
|---|---|---|---|
| 2  | 2229 | 0.00804 | 25,559 |
| 10 | 1613 | 0.00814 | 25,871 |
| 30 | 2064 | 0.01037 | 30,301 |
| 50 | 2865 | 0.01175 | 34,933 |
| 55 | 2026 | 0.01261 | 35,893 |

Turn 1 was an outlier (4076ms api, $0.064 — cold cache creation, not
representative). Averages excluding turn 1:

- api latency, turns 2–10: **1890ms avg** vs turns 41–50: **2130ms avg** —
  roughly a 13% increase, not a cliff.
- cost, turns 2–10: **$0.0081 avg** vs turns 41–50: **$0.0116 avg** — roughly
  43% increase over 40 turns, driven by `cache_read_input_tokens` growing
  from ~25.9k to ~34.9k (linear-looking growth, ~9k tokens over 40 turns ≈
  225 tokens/turn added to the transcript, consistent with these being
  minimal fixed-content turns).
- Total cost across all 55 turns: **$0.623**.

At this trivial-content turn shape, growth through turn 55 is linear and
mild — no discontinuity, no runaway latency, no error. This does **not**
validate the manager's real workload: real manager turns carry `synapse
status --json` output plus judgment reasoning, which will be far larger
per-turn than these fixed "ack" turns, so the *slope* here is a floor, not a
representative number. It does confirm the mechanism (resumed session,
growing cache-read) behaves predictably and without cliffs over this range —
which is what spec §4.9's "manager verbosity is a real budget" is warning
about. The trend is real and monotonic, consistent with the spec's framing,
just not yet steep at 55 trivial turns.

---

## Summary table

| Spike | Result |
|---|---|
| S0.1 | PASS — headless `-p` still enforces permissions; exit 0 does not imply the tool loop succeeded; found the correct `--allowedTools=... -- "prompt"` invocation shape |
| S0.2 | PASS — resume on exited session rehydrates fully, answers from memory with no re-read |
| S0.3 | PASS — contract captured verbatim; `stop_hook_active` is the loop-guard field; found an internal ~10-forced-stop cap after which the CLI exits "successfully" with an empty result despite an active block |
| S0.4 | PASS — `detached: true` gives real process-group semantics; negative-pgid `kill -9` kills worker + subprocess with no orphan |
| S0.5 | PASS both directions — `BEGIN IMMEDIATE` + `busy_timeout=5000`: 160/160 writes, 0 busy errors, reader unblocked (2.48M reads, 0 errors); deferred `BEGIN`: 120/160 writes silently lost to immediate `SQLITE_BUSY` on lock upgrade |
| S0.6 | Measured — mild, roughly linear growth in latency (+13%) and cost (+43%) from turn ~10 to ~50 on minimal-content turns; no cliff in this range, but this floor is not representative of real manager-turn content size |

---

## Verdict against the plan's exit gates

Plan's stated gates (`synapse-plan.md` §"Phase 0 — Spikes"):

> **Exit:** S0.1–S0.3 pass. If S0.2 fails, the whole persistent-manager
> design is wrong...
> **Stop if:** S0.1 fails. There is no system without it.
> **Reconsider D1 if:** S0.4 shows `Bun.spawn` cannot manage process groups
> cleanly.

All gates clear:

- S0.1–S0.3 pass → Phase 0 exit criterion met.
- S0.1 did not fail → no stop condition triggered.
- S0.4 shows clean process-group control → no reconsideration of D1 needed.
- S0.5 passes both required directions.
- S0.6 shows no cliff through 55 turns (with the caveat above that this
  floor understates real manager-turn size).

**The design survives. Proceed to Phase 1.**

Two findings surface real gaps in the spec's own documentation, not in the
design — flagged per rule 3 (spec underspecified, found during
implementation) rather than fixed silently:

1. **S0.1** — the spec does not currently say what a worker is allowed to
   touch (`--allowedTools` scope per role). This is a gap in §4.5/§10, not a
   flaw in the guarantee itself — the wrapper layer still catches a denied
   tool call the same way it catches a silent exit.
2. **S0.3** — §4.5's description of the Stop hook's scope ("does not fire on
   OOM, non-zero exit, kill, or context-limit abort") is incomplete: it also
   does not survive a model that gets blocked repeatedly enough to exhaust an
   internal retry cap (~10), after which the CLI reports success with an
   empty result. The wrapper still covers this case as designed; the spec
   text just doesn't currently say so.

Both are proposed as small additive clauses to spec §4.5, pending approval,
per rule 3 — not applied to `synapse-implementation-spec.md` in this pass.
