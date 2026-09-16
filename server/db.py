"""SQLite persistence layer. Single file DB, WAL mode, thread-safe via one connection per call."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator

DB_PATH = os.environ.get("BOARD_DB", os.path.join(os.path.dirname(__file__), "..", "data", "boards.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',         -- 'admin' | 'member'
  color TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'team'
  team_permission TEXT NOT NULL DEFAULT 'edit', -- for team boards: 'view' | 'edit'
  description TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',          -- 'owner' | 'editor' | 'viewer'
  status TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'pending'
  invited_by TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view',      -- 'view' | 'edit'
  allow_guests INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  type TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  w REAL NOT NULL DEFAULT 200,
  h REAL NOT NULL DEFAULT 200,
  rotation REAL NOT NULL DEFAULT 0,
  z INTEGER NOT NULL DEFAULT 0,
  props TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  updated_by TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
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
"""


def init_db() -> None:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    with conn() as c:
        c.executescript(SCHEMA)


@contextmanager
def conn() -> Iterator[sqlite3.Connection]:
    c = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def now() -> float:
    return time.time()


def row_to_dict(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


def item_row(r: sqlite3.Row) -> dict[str, Any]:
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
