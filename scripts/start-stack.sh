#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f "apps/dashboard/dist/index.html" ]]; then
  echo "[start-stack] dashboard dist missing; building once..."
  bun run --filter dashboard build
fi

echo "[start-stack] starting API (serves dashboard) and worker..."
bun --env-file=.env run --filter @squidward/api start &
api_pid=$!
bun run --filter @squidward/worker start &
worker_pid=$!

cleanup() {
  echo
  echo "[start-stack] shutting down..."
  kill "$api_pid" "$worker_pid" 2>/dev/null || true
  wait "$api_pid" "$worker_pid" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$api_pid" 2>/dev/null; then
  echo "[start-stack] API exited."
fi
if ! kill -0 "$worker_pid" 2>/dev/null; then
  echo "[start-stack] worker exited."
fi
