---
name: tool-lookup
description: Answer general developer-tooling and CLI syntax questions (gh, git, npm, docker, kubectl, jq, etc.). Use when the question is about how to use a tool, NOT about this repo's code or config.
---

# Tool Lookup

Answer general dev-tooling and CLI syntax questions inline without a worker round-trip.

## When to use

- "What's the `gh` flag to X" (approve PR, merge, list checks, etc.)
- "Right `git rebase` / `git log` / `git bisect` invocation for Y"
- "Does `jq` have a function for Z"
- "Idiomatic `kubectl` command for Z"
- General shell idioms: pipelines, redirects, process substitution
- Regex / glob syntax questions (POSIX ERE, Bash extglob, zsh glob)
- npm / yarn / pnpm / bun CLI flags
- `docker` / `docker compose` syntax
- `curl`, `sed`, `awk`, `xargs`, `find` usage

## When NOT to use

- The question requires reading a file in **this repo** — delegate to a worker instead.
- The question is about this project's own config, CI pipeline, deploy scripts, or internal tooling.
- The answer depends on a specific version installed locally — surface that uncertainty and suggest `man <tool>` or `<tool> --help`.
- The question is ambiguous enough that getting it wrong would waste a worker's time — escalate rather than guess.

## Answering style

- Lead with the exact command or flag the user wants. One line if possible.
- Cite the source: `man <tool>`, `<tool> --help`, or an official docs URL when known. If not known, say so.
- Note syntax that varies by version when relevant (e.g. `git switch` requires Git ≥ 2.23; `gh` added `--merge-method` in v2.x).
- For shell idioms, prefer POSIX-portable answers; flag bash/zsh-specific features explicitly.
- If unsure, say "verify with `man <tool>` or `<tool> --help`" — never fabricate a flag that sounds plausible.

## Examples

```
Q: "How do I approve a PR via gh?"
A: `gh pr review --approve <number>`  (see `gh pr review --help`)

Q: "Squash last 3 commits into one"
A: `git rebase -i HEAD~3` — in the editor, change `pick` to `squash` (or `s`) on commits 2 and 3, then save.  (man git-rebase)

Q: "Why is my zsh glob `*.{js,ts}` not matching?"
A: Brace expansion in zsh requires at least one match unless `setopt null_glob` is set.
   In bash you need `shopt -s extglob` for extended globs; brace expansion itself is built-in.  (zsh manual: filename generation)

Q: "Extract the `.name` field from every element of a JSON array with jq"
A: `jq '.[].name'` or `jq '[.[].name]'` to collect into an array.  (jq manual: https://jqlang.org/manual/)
```

## Confidence and escalation

> If the question turns out to be about **this project's** code, config, or workflow
> (e.g. "how do we deploy here", "where is X configured in our setup"),
> **STOP** and route back to the orchestrator for delegation.
> This skill is for general tooling knowledge only.
