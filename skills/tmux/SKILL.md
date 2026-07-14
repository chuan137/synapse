---
name: tmux
description: Operate a tmux pane belonging to a Synapse team — send keystrokes, capture pane output, or clear a pane. Use when the user asks to peek at, type into, or clear a specific agent's tmux window (e.g. "check on coder-1", "what is the monitor doing", "send Enter to reviewer"), or names a session:window target directly.
---

# tmux

Interact with a tmux pane directly: send keystrokes, read captured output, or
clear it. This is the escape hatch for watching or nudging a Synapse agent
window by hand, outside the `synapse send` / `synapse pending` message bus —
useful when an agent looks stuck, a window needs a manual keystroke, or you
just want to see what's on screen right now.

## Finding the target

A pane target is `session:window`. In a Synapse project:

- Session name: run `synapse runs` (or `synapse status`) — the `SESSION`
  column gives the tmux session for a run (e.g. `-syn-a1b2-3`).
- Window name: the agent's name (`manager`, `coder-1`, `reviewer`, ...) or
  `monitor` for the monitor process's own window.

If unsure, list windows first: `tmux list-windows -t <session>`.

## Actions

**send** — type keys into a pane, then press Enter
```bash
tmux send-keys -t <session>:<window> -l -- "<text>" Enter
```
`-l` sends the text literally (no key-name interpretation), so it's safe for
arbitrary strings including `synapse` commands with flags.

**read** — capture pane output (last N lines, default 50)
```bash
tmux capture-pane -t <session>:<window> -p -S -50
```
Pass a different `-S -<N>` to see more or less history.

**clear** — interrupt then clear the pane
```bash
tmux send-keys -t <session>:<window> C-c
tmux send-keys -t <session>:<window> "clear" Enter
```

## Instructions

1. Resolve `session` and `window` (see "Finding the target" above) if not
   given explicitly.
2. Run the matching `tmux` command via Bash.
3. For `read`, show the captured output directly — don't summarize it away,
   the point is usually to see the raw pane state.
4. For `send`, confirm what was sent and to which target.
5. If the target doesn't exist, run `tmux list-windows -t <session>` and
   show the caller what's actually available instead of failing silently.

## Notes

- Sending keys into an agent's pane bypasses the message bus (no
  `messages` row is created, no `ref_id`, nothing for `manager` to see) —
  prefer `synapse send` for anything that should be part of the team's
  recorded conversation. Reach for this skill for out-of-band inspection or
  a genuinely manual nudge (e.g. clearing a stuck pane), not for task
  assignment.
- The `monitor` window's pane is the monitor process's own stdout — reading
  it is a fast way to check delivery activity without tailing
  `.synapse/monitor.log` from a shell.
