#!/usr/bin/env bash
# Start the whiteboard server. Usage: ./run.sh [port]
# Env: BOARD_DB=path/to/sqlite.db  or  DATABASE_URL=postgres://...   PORT=8000
set -e
cd "$(dirname "$0")"
PORT="${1:-${PORT:-8000}}"
# Tip: if this folder is synced by iCloud/Dropbox/OneDrive, keep the venv elsewhere:
#   VENV_DIR=~/.venvs/whiteboard ./run.sh     (a .venv symlink to it also works)
VENV_DIR="${VENV_DIR:-.venv}"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "Creating virtualenv in $VENV_DIR..."
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV_DIR" --python 3.11 --seed && uv pip install --python "$VENV_DIR/bin/python" -r requirements.txt
  else
    python3 -m venv "$VENV_DIR" && "$VENV_DIR/bin/pip" install -r requirements.txt
  fi
fi
echo "Whiteboard running at http://0.0.0.0:${PORT}  (open http://localhost:${PORT})"
exec "$VENV_DIR/bin/python" -m uvicorn server.main:app --host 0.0.0.0 --port "${PORT}" --proxy-headers --forwarded-allow-ips='*'
