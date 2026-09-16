#!/usr/bin/env python3
"""Consistent copy of the SQLite database (safe while the server runs). Keeps the last N copies.
Usage: python scripts/backup_sqlite.py [dest_dir] [keep]
Cron example (daily 03:00):  0 3 * * * cd /path/to/Miro-like && .venv/bin/python scripts/backup_sqlite.py backups 14
"""
import os, sqlite3, sys, time
src = os.environ.get("BOARD_DB", os.path.join(os.path.dirname(__file__), "..", "data", "boards.db"))
dest_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(src), "backups")
keep = int(sys.argv[2]) if len(sys.argv) > 2 else 14
os.makedirs(dest_dir, exist_ok=True)
dest = os.path.join(dest_dir, time.strftime("boards-%Y%m%d-%H%M%S.db"))
with sqlite3.connect(src) as s, sqlite3.connect(dest) as d:
    s.backup(d)
print("backup written:", dest)
olds = sorted(f for f in os.listdir(dest_dir) if f.startswith("boards-") and f.endswith(".db"))
for f in olds[:-keep]:
    os.remove(os.path.join(dest_dir, f)); print("removed old backup:", f)
