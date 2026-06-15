---
name: progress
description: Maintain .synapse/progress.md (Open / Backlog / Stopped) and weekly done/<MONDAY>.md archives. Subcommands: archive, rotate, move, new-topic.
---

# /progress

Manage `.synapse/progress.md` and weekly done archives at `.synapse/done/<MONDAY>.md`.

## Files

| File | Purpose |
|---|---|
| `.synapse/progress.md` | Live work tracker. Three blocks: **Open**, **Backlog**, **Stopped/Rejected**. Items grouped by `### Topic` headers. |
| `.synapse/done/<MONDAY>.md` | Weekly archive. One file per ISO week, named by that Monday (`YYYY-MM-DD`). |

**Monday date computation:**
```sh
python3 -c "import datetime; d=datetime.date.today(); print((d - datetime.timedelta(days=d.weekday())).isoformat())"
```

**Commit date lookup:**
```sh
git log -1 --format="%ci" <sha>   # → "2026-06-15 14:23:11 +0800"
```

---

## Subcommand: `/progress archive [<sha>...]`

Move completed commit(s) from progress notes into the correct `done/<week>.md`.

### Default (no args)

1. Find the most recent commit already archived in any `done/*.md` file. Scan only bullet-start lines matching `^- \`[0-9a-f]{7,40}\`` — do not pick up SHA mentions in paragraph body text. Find the latest by commit date.
2. Run `git log --oneline <last-archived-sha>..HEAD` to get unarchived commits.
3. Archive each one (see Per-commit steps below).

### With `<sha>...` args

Archive only those specific commits.

### Per-commit steps

1. Get commit date: `git log -1 --format="%ci" <sha>`.
2. Compute Monday of that week.
3. Open or create `.synapse/done/<MONDAY>.md` (create with header `# Done — Week of <MONDAY>` if absent).
4. Choose topic:
   - Prefer a `## Topic` heading in that done file that fits the commit.
   - Else use the matching `### Topic` from `progress.md`'s Open block.
   - Else ask the operator which topic to use (don't create silently).
5. Append bullet: `` - `<short_sha>` <commit subject>. <one-paragraph what+why+impact (infer from commit body, message thread, or diff)> ``
6. If this commit completes a `### Topic` block in `progress.md` (all bullets resolved), remove that topic from Open — or move to Stopped if it was a rejection.

### Idempotence

If the SHA is already present in any `done/*.md`, skip it and note: `<sha> already archived in done/<date>.md`.

### Example

```
/progress archive a721abc
```

Result: opens `.synapse/done/2026-06-08.md`, appends under `## MCP Protocol`:
```markdown
- `a721abc` feat(mcp): move source_msg_id from delegate_task to start_task. Moved the root-cause msg id field to task creation time rather than delegation, so self-driven tasks can now carry it too. db.ts already supported the 4th arg.
```

---

## Subcommand: `/progress rotate`

Ensure the current week's done file exists and is correctly initialized.

1. Compute this Monday's date.
2. If `.synapse/done/<MONDAY>.md` doesn't exist, create it with:
   ```markdown
   # Done — Week of <MONDAY>
   ```
3. Validate `progress.md` has no stray "Done" sections: grep for `^## Done` in the file; if any match found, report the offending line and stop.
4. Confirm: "Week of <MONDAY> ready. Previous week sealed."

Idempotent — safe to run multiple times.

---

## Subcommand: `/progress move <topic-name> --to {open|backlog|stopped} [--reason "<one line>"]`

Move an entire `### Topic` block between the three blocks in `progress.md`.

1. Find the `### <topic-name>` heading (case-insensitive substring match if exact not found; error if ambiguous).
2. Extract the full block: the heading + all bullets until the next `###` or `##`.
3. Remove it from its current block.
4. Insert it under the target `## Block` heading.
5. If `--to stopped`, prepend a `- Reason: <reason>` bullet (prompt operator for reason if not supplied via `--reason`).

### Example

```
/progress move "Stub stdio MCP" --to stopped --reason "MCP name collision; isolated DB approach used instead"
```

---

## Subcommand: `/progress new-topic <name> [--block {open|backlog|stopped}] [--note "<first bullet>"]`

Add a new `### <name>` placeholder to `progress.md`.

1. Default block: `open`.
2. Reject if a `### <name>` heading already exists (case-insensitive) in the target block — report "topic already exists" and stop.
3. Insert `### <name>` under the specified `## Block` heading (append at end of that block's topics).
4. If `--note` supplied, add it as the first bullet.
5. Else add a placeholder: `- _(no items yet)_`

### Example

```
/progress new-topic "Worker health metrics" --block open --note "Decide fields: turn count, token estimate, cache age."
```

---

## File structure reference

### progress.md

```markdown
# Synapse Progress

## Open

### Topic A
- action item or decision needed
- another bullet

### Topic B
- …

## Backlog

### Topic C
- work identified, not scheduled

## Stopped / Rejected

### Approach D
- Reason: <why abandoned>
```

### done/<MONDAY>.md

```markdown
# Done — Week of 2026-06-15

## Topic A

- `abc1234` feat(x): subject. One paragraph: what changed, why it was needed, what it unblocks.
- `def5678` fix(y): subject. One paragraph.

## Topic B

- `ghi9012` …
```

---

## Edge cases

- **Missing `done/` dir**: create it (`mkdir -p .synapse/done/`).
- **Missing `progress.md`**: error and stop; don't auto-create — content would be empty and misleading.
- **Ambiguous topic match**: list candidates, ask operator which to use.
- **Commit spans multiple topics**: pick the primary topic; note the others in the paragraph.
- **Multi-week batch archive**: creates multiple `done/` files as needed.
- **Commit message too sparse to write a paragraph**: use the commit subject + whatever can be inferred from context; keep the paragraph short rather than padding.
