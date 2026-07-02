# Changelog

## v0.0.3

**S-Deck UI**
- Show manager decisions and agent delegation inline in the run thread
- Add message highlights: inline `code` spans and bold semantic colors (green/red/accent)
- Stop duplicating reply text in resolved QUESTION cards
- Fix QUESTION reply not persisting across page reload
- Escape angle brackets in messages; remove Idle/Busy labels; disable Stop Run while agents are busy
- Add Stop Run button in thread header for running runs; fix it being hidden on page load
- Exclude operator from agents strip; show Idle/Busy badge for running runs

**CLI**
- Add `--dev` flag and title/goal separator to `synapse start`
- Move `public/` to repo root
- Require `--options` on QUESTION-to-operator; drop Yes/No/OK fallback
- Lint: reject long message bodies with enumerated list markers but no real line breaks
- Fix `--body-file` flag

**Protocol**
- Tell manager to format multi-point STATUS/INFO bodies as Markdown
- Document `--options` and `--title` flags for QUESTION messages
- Add language rule: English or Chinese only (no Korean or Japanese)

**Infrastructure**
- Scope tmux session name to project; defer run commit
- Replace ack-run with explicit kill-session flow
- Make agent delivery pull-based
- Harden command monitor sweep handling; consolidate command modules
- Refactor DB migration into db module
- Enforce reviewed task completion and unify UI run start
- Fix unit tests: update hardcoded session name to slug-hash-id format
