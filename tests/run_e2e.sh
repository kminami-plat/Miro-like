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
PORT_KV=8767
PORT3=8768

if [ -n "$DATABASE_URL" ]; then
  echo "!! Using the DATABASE_URL from your shell — this suite creates and deletes data."
  echo "!! Make sure it points at a test database or a Neon branch, not production."
  DB_ENV=(DATABASE_URL="$DATABASE_URL")
else
  DB_ENV=(BOARD_DB="$(mktemp -d)/e2e.db")
fi
# Never let the env file inject DATABASE_URL into a test run. Phases 1-2 exercise the old canvas
# boards, which are switched off by default, so they run with LEGACY_BOARDS=1.
COMMON=(WB_SKIP_ENV_FILE=1 LEGACY_BOARDS=1 ARCHIVE_AUTO=0 "${DB_ENV[@]}")

wait_up() { for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$1/api/health" >/dev/null && return 0; sleep 0.3; done; return 1; }

# ---- phase 0: unit tests — plat-todo read-merge-write, business-day calendar & archives (no network)
.venv/bin/python tests/plat_tasks_test.py
.venv/bin/python tests/archive_test.py

# ---- phase 1: full suite, registration open (no invite code configured)
env "${COMMON[@]}" .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port $PORT >/tmp/wb-e2e.log 2>&1 &
PID=$!
trap 'kill $PID $PID2 $PID3 $PIDKV 2>/dev/null' EXIT
wait_up $PORT || { echo "server did not start; see /tmp/wb-e2e.log"; exit 1; }
BASE_URL="http://127.0.0.1:$PORT" .venv/bin/python tests/e2e.py
kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true; PID=

# ---- phase 2: same code path with REGISTRATION_CODE set, on its own fresh database
if [ -z "$DATABASE_URL" ]; then
  env WB_SKIP_ENV_FILE=1 LEGACY_BOARDS=1 ARCHIVE_AUTO=0 BOARD_DB="$(mktemp -d)/e2e-code.db" REGISTRATION_CODE="ゲート-2026" \
    .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port $PORT2 >/tmp/wb-e2e-code.log 2>&1 &
  PID2=$!
  wait_up $PORT2 || { echo "server did not start; see /tmp/wb-e2e-code.log"; exit 1; }
  BASE_URL="http://127.0.0.1:$PORT2" .venv/bin/python tests/registration_code.py
  kill $PID2 2>/dev/null || true; wait $PID2 2>/dev/null || true; PID2=
else
  echo "(skipping the invite-code phase: it needs its own database)"
fi

# ---- phase 3: today's board + archives (default mode, no legacy boards) against a fake plat-kv Worker
#      (never the real one), on its own SQLite file. The archive loop is off; the test triggers it.
.venv/bin/python tests/fake_kv.py $PORT_KV &
PIDKV=$!
env WB_SKIP_ENV_FILE=1 BOARD_DB="$(mktemp -d)/e2e-tasks.db" PLAT_KV_URL="http://127.0.0.1:$PORT_KV" PLAT_KV_TOKEN=test-token PLAT_TASKS_KEY=plat-todo-tasks-sandbox \
  PLAT_LOCAL_DATA_DIR=tests/fixtures/plat PLAT_ACCESS_CLIENT_ID= PLAT_ACCESS_CLIENT_SECRET= \
  LEGACY_BOARDS= ARCHIVE_AUTO=0 ARCHIVE_CRON_SECRET=test-secret \
  .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port $PORT3 >/tmp/wb-e2e-tasks.log 2>&1 &
PID3=$!
wait_up $PORT3 || { echo "server did not start; see /tmp/wb-e2e-tasks.log"; exit 1; }
BASE_URL="http://127.0.0.1:$PORT3" KV_URL="http://127.0.0.1:$PORT_KV" .venv/bin/python tests/tasks_grid.py
kill $PID3 $PIDKV 2>/dev/null || true; wait $PID3 $PIDKV 2>/dev/null || true; PID3=; PIDKV=

echo
echo "ALL TEST PHASES PASSED"
