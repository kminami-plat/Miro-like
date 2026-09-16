"""Persistence layer.

Two backends behind one tiny interface:
  * SQLite (default)   — zero setup, single file at BOARD_DB (data/boards.db).
  * PostgreSQL         — set DATABASE_URL=postgres://... (Neon / Supabase / Railway etc.).
                         Needed on hosts without persistent disks (Render free tier, Vercel-style PaaS).

Both use the same SQL. Placeholders are written as `?` and translated to `%s` for Postgres.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator

DATABASE_URL = os.environ.get("DATABASE_URL", "")
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
DB_PATH = os.environ.get("BOARD_DB", os.path.join(os.path.dirname(__file__), "..", "data", "boards.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  team_permission TEXT NOT NULL DEFAULT 'edit',
  description TEXT NOT NULL DEFAULT '',
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  status TEXT NOT NULL DEFAULT 'active',
  invited_by TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view',
  allow_guests INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  type TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  y DOUBLE PRECISION NOT NULL DEFAULT 0,
  w DOUBLE PRECISION NOT NULL DEFAULT 200,
  h DOUBLE PRECISION NOT NULL DEFAULT 200,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  z INTEGER NOT NULL DEFAULT 0,
  props TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  updated_by TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_board ON items(board_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON board_members(user_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_favorites (
  user_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  PRIMARY KEY (user_id, board_id)
);
CREATE TABLE IF NOT EXISTS board_snapshots (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'auto',
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_board ON board_snapshots(board_id, created_at);
CREATE TABLE IF NOT EXISTS guests (
  token TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL,
  boards TEXT NOT NULL DEFAULT '{}',
  via TEXT NOT NULL DEFAULT '{}',
  created_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL
);
"""


class DB:
    """Minimal uniform wrapper over sqlite3 / psycopg connections."""

    def __init__(self, raw: Any):
        self.raw = raw

    @staticmethod
    def _sql(sql: str) -> str:
        return sql.replace("?", "%s") if IS_PG else sql

    def execute(self, sql: str, params: tuple | list = ()):
        if IS_PG:
            return self.raw.execute(self._sql(sql), params)
        return self.raw.execute(sql, params)

    def executemany(self, sql: str, seq: list[tuple]):
        if IS_PG:
            with self.raw.cursor() as cur:
                cur.executemany(self._sql(sql), seq)
            return None
        return self.raw.executemany(sql, seq)


_pool = None


def _pg_pool():
    global _pool
    if _pool is None:
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool
        _pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=8, kwargs={"row_factory": dict_row}, open=True)
    return _pool


def init_db() -> None:
    if IS_PG:
        with conn() as c:
            for stmt in SCHEMA.split(";"):
                if stmt.strip():
                    c.execute(stmt)
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))")
    else:
        os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
        with conn() as c:
            c.raw.executescript(SCHEMA)
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))")


@contextmanager
def conn() -> Iterator[DB]:
    if IS_PG:
        with _pg_pool().connection() as raw:
            yield DB(raw)  # pool commits on clean exit, rolls back on exception
        return
    raw = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA journal_mode=WAL")
    raw.execute("PRAGMA busy_timeout=5000")
    try:
        yield DB(raw)
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


def backend_name() -> str:
    return "postgresql" if IS_PG else f"sqlite ({os.path.abspath(DB_PATH)})"


def now() -> float:
    return time.time()


def row_to_dict(r) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


def item_row(r) -> dict[str, Any]:
    d = dict(r)
    d["props"] = json.loads(d.get("props") or "{}")
    return d


def get_setting(key: str, default: str) -> str:
    with conn() as c:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r["value"] if r else default


def set_setting(key: str, value: str) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
