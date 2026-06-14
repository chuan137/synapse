#!/usr/bin/env bash
# run-sandbox.sh — build image, start container, launch wrapper
#
# First-time setup (interactive login inside container):
#   bash sandbox/run-sandbox.sh --setup
#
# Normal run:
#   bash sandbox/run-sandbox.sh
set -e

CONTAINER="${SANDBOX_CONTAINER:-sandbox-agent}"
IMAGE="${SANDBOX_IMAGE:-sandbox-agent:latest}"
CLI="${SANDBOX_CLI:-claude}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Isolated auth directory — never touches ~/.claude on the host
AUTH_DIR="${SCRIPT_DIR}/.sandbox-auth"

if [[ "$1" == "--rebuild" ]] || ! docker image inspect "$IMAGE" &>/dev/null; then
  echo "[run] Building image $IMAGE ..."
  docker build -t "$IMAGE" "$SCRIPT_DIR"
else
  echo "[run] Image $IMAGE already exists, skipping build. Use --rebuild to force."
fi

docker rm -f "$CONTAINER" 2>/dev/null || true

if [[ "$1" == "--setup" ]]; then
  echo "[run] Setup mode: starting container for interactive login ..."
  echo "[run] Steps: 1) login  2) select theme  3) type /exit to quit"
  mkdir -p "$AUTH_DIR"
  # Run CLI directly in an interactive TTY so OAuth/login flow works
  docker run -it --rm \
    --name "${CONTAINER}-setup" \
    --env SANDBOX_CLI="$CLI" \
    --volume "$AUTH_DIR:/root/.claude" \
    --entrypoint "$CLI" \
    "$IMAGE"
  echo "[run] Login complete. Auth saved to: $AUTH_DIR"
  echo "[run] Run without --setup to start normally."
  exit 0
fi

if [[ ! -d "$AUTH_DIR" ]]; then
  echo "[error] No auth found. Run with --setup first:"
  echo "  bash sandbox/run-sandbox.sh --setup"
  exit 1
fi

echo "[run] Starting container $CONTAINER (CLI=$CLI) ..."
docker run -d \
  --name "$CONTAINER" \
  --env SANDBOX_CLI="$CLI" \
  --volume "$AUTH_DIR:/root/.claude" \
  "$IMAGE"

echo "[run] Container started. Launching wrapper..."
SANDBOX_CONTAINER="$CONTAINER" node "$SCRIPT_DIR/sandbox-wrapper.mjs"
