FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Install claude and codex CLIs globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Pipe output file — wrapper tails this
RUN touch /tmp/tty-output.log

ENV TMUX_SESSION=main

ENTRYPOINT ["/entrypoint.sh"]
