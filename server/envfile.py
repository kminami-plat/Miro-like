"""Load key=value pairs from the project's .env file into os.environ.

Imported from server/__init__.py so it runs before any module reads its settings
(server/db.py decides SQLite vs PostgreSQL at import time).

Rules:
  * Real environment variables always win — the file only fills in what is missing,
    so `DATABASE_URL=... ./run.sh` and hosting dashboards (Render, Fly) still override it.
  * Set WB_SKIP_ENV_FILE=1 to ignore the file entirely (the e2e runner does this so tests
    never reach the production database by accident).
  * No dependency on python-dotenv; this parses the handful of forms we actually use.
"""
from __future__ import annotations

import os

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")


def _unquote(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v.split(" #", 1)[0].rstrip()  # allow a trailing comment on unquoted values


def load(path: str = ENV_PATH) -> list[str]:
    """Populate os.environ from `path`. Returns the names that were set (never the values)."""
    if os.environ.get("WB_SKIP_ENV_FILE") == "1":
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except (OSError, UnicodeDecodeError):
        return []  # no file (normal in Docker/Render, where real env vars are used)
    loaded = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:  # real env vars win
            continue
        os.environ[key] = _unquote(value)
        loaded.append(key)
    return loaded
