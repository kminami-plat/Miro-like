"""Daily board archives: one frozen copy of the task board per Japanese business day, kept for a month.

The board itself lives in plat-kv (see plat_tasks.py) and can also be edited from the plat-todo page,
so an archive is only exact if it is taken at the cutoff. Three things trigger a capture, and each
one simply calls `ensure_captured()`, which is idempotent:
  * a background loop in the server (every minute),
  * every write from this app, *before* the write is applied (so our own edits after the cutoff
    never leak into the previous day's archive),
  * POST /api/archive/run with ARCHIVE_CRON_SECRET, for an external cron (Render's free plan sleeps).
When the capture happens late, the archive records when it was actually taken and the UI says so.

Settings (read at call time):
  ARCHIVE_CUTOFF          "HH:MM" in JST when a business day closes (default 24:00 = midnight)
  ARCHIVE_DAYS            how many days of archives to keep (default 31)
  ARCHIVE_EXTRA_HOLIDAYS  company days off, comma-separated YYYY-MM-DD (e.g. year-end closure)
  ARCHIVE_AUTO            0 disables the background loop (tests)
"""
from __future__ import annotations

import json
import os
import threading
from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import Any, Callable, Optional

from . import db
from .plat_tasks import JST

LATE_AFTER = 30 * 60  # a capture more than 30 min after the cutoff is flagged as late
_lock = threading.Lock()


# ------------------------------------------------------------------ Japanese national holidays

def _nth_monday(year: int, month: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(7 - d.weekday()) % 7)  # first Monday
    return d + timedelta(weeks=n - 1)


def _equinox(year: int, base: float) -> int:
    # Standard approximation used for the official calendar; valid 1980-2099.
    return int(base + 0.242194 * (year - 1980) - (year - 1980) // 4)


@lru_cache(maxsize=64)
def jp_holidays(year: int) -> frozenset[date]:
    """National holidays under the current law (valid 2022-2099), including 振替休日 and 国民の休日."""
    base = {
        date(year, 1, 1), _nth_monday(year, 1, 2), date(year, 2, 11), date(year, 2, 23),
        date(year, 3, _equinox(year, 20.8431)), date(year, 4, 29), date(year, 5, 3), date(year, 5, 4),
        date(year, 5, 5), _nth_monday(year, 7, 3), date(year, 8, 11), _nth_monday(year, 9, 3),
        date(year, 9, _equinox(year, 23.2488)), _nth_monday(year, 10, 2), date(year, 11, 3), date(year, 11, 23),
    }
    days = set(base)
    # 国民の休日: an ordinary day sandwiched between two holidays (e.g. 2026-09-22).
    for d in base:
        mid = d + timedelta(days=1)
        if mid not in base and mid + timedelta(days=1) in base and mid.weekday() != 6:
            days.add(mid)
    # 振替休日: a holiday on Sunday moves to the next day that is not already a holiday.
    for d in sorted(base):
        if d.weekday() == 6:
            sub = d + timedelta(days=1)
            while sub in days:
                sub += timedelta(days=1)
            days.add(sub)
    return frozenset(days)


def extra_holidays() -> set[date]:
    out = set()
    for s in os.environ.get("ARCHIVE_EXTRA_HOLIDAYS", "").split(","):
        try:
            out.add(date.fromisoformat(s.strip()))
        except ValueError:
            pass
    return out


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in jp_holidays(d.year) and d not in extra_holidays()


# ------------------------------------------------------------------ when is a day due

def cutoff_of(d: date) -> datetime:
    """The moment business day `d` closes, in JST."""
    raw = os.environ.get("ARCHIVE_CUTOFF", "24:00").strip() or "24:00"
    try:
        h, m = (int(x) for x in raw.split(":"))
        if not (0 <= h <= 24 and 0 <= m < 60) or (h == 24 and m):
            raise ValueError
    except ValueError:
        h, m = 24, 0
    return datetime(d.year, d.month, d.day, tzinfo=JST) + timedelta(hours=h, minutes=m)


def due_day(now: datetime) -> date:
    """The most recent business day whose cutoff has passed."""
    d = now.astimezone(JST).date()
    while not (is_business_day(d) and cutoff_of(d) <= now):
        d -= timedelta(days=1)
    return d


def keep_days() -> int:
    try:
        return max(1, int(os.environ.get("ARCHIVE_DAYS", "31")))
    except ValueError:
        return 31


# ------------------------------------------------------------------ storage

def ensure_captured(snapshot: Callable[[], dict[str, Any]], now: Optional[datetime] = None) -> Optional[str]:
    """Capture the most recent closed business day if it has no archive yet. Returns the day captured.

    `snapshot()` returns the board state to freeze; if it raises (e.g. plat-kv is down) nothing is
    stored and the next trigger tries again.
    """
    now = now or datetime.now(JST)
    day = due_day(now).isoformat()
    with _lock:
        with db.conn() as c:
            if c.execute("SELECT 1 FROM board_archives WHERE day=?", (day,)).fetchone():
                return None
        data = snapshot()
        t = now.timestamp()
        late = 1 if t - cutoff_of(date.fromisoformat(day)).timestamp() > LATE_AFTER else 0
        tasks = data.get("tasks") or []
        with db.conn() as c:
            c.execute(
                "INSERT INTO board_archives(day,captured_at,late,task_count,data) VALUES(?,?,?,?,?) ON CONFLICT(day) DO NOTHING",
                (day, t, late, len(tasks), json.dumps(data, ensure_ascii=False)),
            )
            oldest = (now.astimezone(JST).date() - timedelta(days=keep_days())).isoformat()
            c.execute("DELETE FROM board_archives WHERE day<?", (oldest,))
    print(f"[archive] {day} を記録しました（タスク {len(tasks)} 件{'、遅延' if late else ''}）")
    return day


def list_archives(now: Optional[datetime] = None) -> list[dict[str, Any]]:
    """Every business day in the retention window, newest first, with its archive if one exists."""
    now = now or datetime.now(JST)
    today = now.astimezone(JST).date()
    with db.conn() as c:
        rows = {r["day"]: dict(r) for r in c.execute("SELECT day,captured_at,late,task_count FROM board_archives")}
    first = min(rows) if rows else None  # days before the first archive were never going to have one
    out = []
    for i in range(keep_days() + 1):
        d = today - timedelta(days=i)
        if not is_business_day(d):
            continue
        r = rows.get(d.isoformat())
        if r:
            state = "captured"
        elif cutoff_of(d) > now:
            state = "open"
        else:
            state = "missing" if first and d.isoformat() > first else "before"

        out.append({"day": d.isoformat(), "weekday": d.weekday(), "state": state, "cutoff": cutoff_of(d).timestamp(),
                    **({"captured_at": r["captured_at"], "late": bool(r["late"]), "task_count": r["task_count"]} if r else {})})
    return out


def read_archive(day: str) -> Optional[dict[str, Any]]:
    with db.conn() as c:
        r = c.execute("SELECT * FROM board_archives WHERE day=?", (day,)).fetchone()
    if not r:
        return None
    return {"day": r["day"], "captured_at": r["captured_at"], "late": bool(r["late"]),
            "cutoff": cutoff_of(date.fromisoformat(r["day"])).timestamp(), **json.loads(r["data"])}
