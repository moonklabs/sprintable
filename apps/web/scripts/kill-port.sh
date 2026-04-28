#!/usr/bin/env bash
# Kill any process listening on the given TCP port. Safe no-op when nothing
# is bound. Used by `pnpm dev` to recover from a leftover Next.js dev server
# that survived a previous session and is still holding the port.
set -e

PORT="${1:-3108}"
# Only target the LISTENing socket — without this filter we'd also kill any
# client process that happens to have an open connection to the port (e.g. an
# attached browser tab), which has bitten us before.
PIDS=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  echo "[kill-port] freeing port $PORT — killing PID(s): $PIDS"
  kill -9 $PIDS 2>/dev/null || true
  # Give the kernel a beat to release the socket before the next bind.
  sleep 0.3
fi
