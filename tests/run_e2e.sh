#!/usr/bin/env bash
# Runs the browser end-to-end suite against a fresh temporary database.
# Requires: .venv with requirements.txt + playwright, and Google Chrome installed.
#
# By default the project's env file is IGNORED (WB_SKIP_ENV_FILE=1) so the suite can never
# reach your production PostgreSQL: it registers users and deletes boards. To test against a
# real Postgres, pass the URL explicitly — use a Neon *branch*, not production:
#   DATABASE_URL="postgres://...@.../db?sslmode=require" ./tests/run_e2e.sh
set -e
set +m          # no "Terminated" job notices when we stop the background servers
cd "$(dirname "$0")/.."
PORT=8765
PORT2=8766

if [ -n "$DATABASE_URL" ]; then
  echo "!! Using the DATABASE_URL from your shell — this suite creates and deletes data."
  echo "!! Make sure it points at a test database or a Neon branch, not production."
  DB_ENV=(DATABASE_URL="$DATABASE_URL")
else
  DB_ENV=(BOARD_DB="$(mktemp -d)/e2e.db")
fi
# Never let the env file inject DATABASE_URL into a test run.
COMMON=(WB_SKIP_ENV_FILE=1 "${DB_ENV[@]}")

wait_up() { for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$1/api/health" >/dev/null && return 0; sleep 0.3; done; return 1; }

# ---- phase 1: full suite, registration open (no invite code configured)
env "${COMMON[@]}" .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port $PORT >/tmp/wb-e2e.log 2>&1 &
PID=$!
trap 'kill $PID $PID2 2>/dev/null' EXIT
wait_up $PORT || { echo "server did not start; see /tmp/wb-e2e.log"; exit 1; }
BASE_URL="http://127.0.0.1:$PORT" .venv/bin/python tests/e2e.py
kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true; PID=

# ---- phase 2: same code path with REGISTRATION_CODE set, on its own fresh database
if [ -z "$DATABASE_URL" ]; then
  env WB_SKIP_ENV_FILE=1 BOARD_DB="$(mktemp -d)/e2e-code.db" REGISTRATION_CODE="ゲート-2026" \
    .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port $PORT2 >/tmp/wb-e2e-code.log 2>&1 &
  PID2=$!
  wait_up $PORT2 || { echo "server did not start; see /tmp/wb-e2e-code.log"; exit 1; }
  BASE_URL="http://127.0.0.1:$PORT2" .venv/bin/python tests/registration_code.py
  kill $PID2 2>/dev/null || true; wait $PID2 2>/dev/null || true; PID2=
else
  echo "(skipping the invite-code phase: it needs its own database)"
fi

echo
echo "ALL TEST PHASES PASSED"
