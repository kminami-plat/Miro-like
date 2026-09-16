#!/usr/bin/env bash
# Runs the browser end-to-end suite against a fresh temporary database.
# Requires: .venv with requirements.txt + playwright, and Google Chrome installed.
set -e
cd "$(dirname "$0")/.."
PORT=8765
DB=$(mktemp -d)/e2e.db
BOARD_DB="$DB" .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port $PORT >/tmp/wb-e2e.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT/api/auth/me" >/dev/null && break; sleep 0.3; done
BASE_URL="http://127.0.0.1:$PORT" .venv/bin/python tests/e2e.py
