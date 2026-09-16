#!/usr/bin/env bash
# Start the whiteboard server. Usage: ./run.sh [port]
set -e
cd "$(dirname "$0")"
PORT="${1:-${PORT:-8000}}"
if [ ! -x .venv/bin/python ]; then
  echo "Creating virtualenv..."
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv --python 3.11 && uv pip install --python .venv/bin/python -r requirements.txt
  else
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  fi
fi
echo "Whiteboard running at http://0.0.0.0:${PORT}  (open http://localhost:${PORT})"
exec .venv/bin/python -m uvicorn server.main:app --host 0.0.0.0 --port "${PORT}"
