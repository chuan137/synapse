#!/usr/bin/env bash
set -e

SESSION="${TMUX_SESSION:-main}"
CLI="${SANDBOX_CLI:-claude}"
OUTPUT_LOG="/tmp/tty-output.log"

# Start tmux session (detached) running the target CLI
tmux new-session -d -s "$SESSION" -x 220 -y 50 "$CLI"

# Pipe all tmux pane output to the log file (appending)
tmux pipe-pane -t "$SESSION" -o "cat >> $OUTPUT_LOG"

# Keep container alive — tmux session drives the CLI
# When the CLI exits, tmux session ends and this loop exits too
while tmux has-session -t "$SESSION" 2>/dev/null; do
  sleep 1
done
