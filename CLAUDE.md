# Synapse — working rules

Multi-agent coordination system. TypeScript on Bun. Spec-driven: the spec is the
design authority, not a description of the code.

## Documents

- `docs/synapse-spec.md` — design specification, rev 3. **Authoritative.**
- `docs/synapse-implementation-plan.md` — implementation plan (phases, exit criteria, spikes).
- `PHASE` — one line: the phase currently being built. Do not build ahead of it.

Authority order: **spec > plan > existing code.** If code contradicts the spec,
the code is wrong.

## The five rules

1. **Cite the spec.** Every source file opens with a comment naming the spec
   sections it implements (`// spec §2.3, §4.2`). Every commit message names them
   too. If you cannot name a section, you are building something the spec does
   not describe — stop and ask.

2. **Tests are named after spec §6 claims.** §6 is a list of checkable claims;
   each becomes a test whose name quotes it. Example:
   `test("a rev is assigned by worker/operator writes and not by manager writes")`.
   A phase is done when its mapped claims pass, not when the code looks finished.

3. **Never edit the spec silently.** If implementation reveals the spec is wrong
   or underspecified, stop. Propose the change as a diff plus a row for the §9
   change table, and wait for approval. Design decisions are not made in code.

4. **Ambiguity stops work.** Do not pick a reasonable interpretation and proceed.
   Ask. Spec §8 lists deliberately-open questions; anything resembling those is
   a stop, not a judgment call. One question at a time, with the two or three
   options and what each costs.

5. **Stay in phase.** `PHASE` says what is being built. Do not implement later
   phases' concerns "while you're in there" — the phase ordering exists so that
   plumbing failures and judgment failures stay distinguishable.

## Hard constraints

From spec §10 (D1–D6) and §4.10. These are settled; do not relitigate in code.

- **Bun + `bun:sqlite`, synchronous.** No ORM, no query builder, no async DB
  layer. Async transactions over SQLite interleave and corrupt reasoning about
  the rev counter.
- **`BEGIN IMMEDIATE` for every writing transaction.** Every rev-assigning path
  reads then writes; deferred transactions deadlock on lock upgrade and
  `busy_timeout` does not rescue it.
- **Pragmas on every open:** `journal_mode=WAL`, `busy_timeout=5000`,
  `foreign_keys=ON`.
- **Four tables only.** `runs`, `tasks`, `subtasks`, `messages`. No agents table,
  no roles table. Adding a table is a spec change (rule 3).
- **Rev is assigned only by writes the manager owes a reaction to** — worker
  replies, failures, cascades, operator messages. Never by manager writes, or the
  manager wakes itself in a loop.
- **Readiness is computed in SQL** (`json_each` over `depends_on`), not in TS. It
  must be recomputable from the tables alone after a context compaction.
- **Workers spawn into their own process group.** Cancellation kills the group.
- **No real model calls before Phase 4.** Phases 1–3 use the fakes in
  `tests/fakes/`.

## Banned

- The identifier `board` anywhere in code or command names. It is used once in
  spec §1 as pattern attribution and nowhere else. Reads (`queries.ts`) and
  writes (`subtasks.ts`) are named for what they do.
- A second read verb. `synapse status [--run R] [--json]` is the only one.
- Any approval flag on `tasks`. The answered QUESTION is the record (spec §4.11).
- Per-stage timestamp columns. `stage` is authoritative, `rev` drives the watcher.
- Retry loops around `SQLITE_BUSY`. Fix the transaction mode instead.

## Layout

```
src/
  schema.sql     # 4 tables + task_progress view + indexes
  db.ts          # open, pragmas, tx() [BEGIN IMMEDIATE], nextRev()
  subtasks.ts    # row lifecycle WRITES: create, dispatch, reply, fail, cancel
  queries.ts     # derived READS only: readiness, cascade candidates, rollup
  spawn.ts       # wrapper: session uuid, process group, guaranteed terminal write
  watcher.ts     # poll, cascade, sweep, wake
  cli.ts         # verb dispatch
  prompts/       # manager.md, coder.md, reviewer.md, tester.md, doc-writer.md
tests/
  fakes/         # fake workers + policy-manager stand-in
docs/
```

`queries.ts` never writes. Every rev-assigning write lives in `subtasks.ts` — one
file to audit for the rev and transaction rules.

## Definition of done for any change

1. The mapped §6 claims have tests and they pass.
2. `bun test` is green — the whole suite, not the new tests.
3. Every new file cites its spec sections.
4. No spec edits, or spec edits approved separately.

## Working style

Terse. No summaries of what you are about to do. Show the diff and the test
result. If something in the spec looks wrong, say so plainly and stop — that is
more useful than a workaround.
