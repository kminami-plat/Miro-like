"""Unit tests for server/archive.py: the Japanese business-day calendar and daily capture.

Run: .venv/bin/python tests/archive_test.py   (also run by tests/run_e2e.sh)
"""
import os
import sys
import tempfile
import unittest
from datetime import date, datetime

os.environ["WB_SKIP_ENV_FILE"] = "1"
os.environ["BOARD_DB"] = os.path.join(tempfile.mkdtemp(), "archive-test.db")
os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import archive, db  # noqa: E402
from server.plat_tasks import JST  # noqa: E402

db.init_db()


def at(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=JST)


class CalendarTests(unittest.TestCase):
    def test_2026_holidays(self):
        expected = {date(2026, m, d) for m, d in [
            (1, 1), (1, 12), (2, 11), (2, 23), (3, 20), (4, 29), (5, 3), (5, 4), (5, 5), (5, 6),
            (7, 20), (8, 11), (9, 21), (9, 22), (9, 23), (10, 12), (11, 3), (11, 23)]}
        self.assertEqual(set(archive.jp_holidays(2026)), expected)

    def test_substitute_holiday_2025(self):
        self.assertIn(date(2025, 11, 24), archive.jp_holidays(2025))  # 11/23 was a Sunday
        self.assertIn(date(2025, 5, 6), archive.jp_holidays(2025))   # 5/4 was a Sunday

    def test_business_days(self):
        self.assertTrue(archive.is_business_day(date(2026, 9, 24)))   # Thursday
        self.assertFalse(archive.is_business_day(date(2026, 9, 22)))  # 国民の休日
        self.assertFalse(archive.is_business_day(date(2026, 9, 26)))  # Saturday
        os.environ["ARCHIVE_EXTRA_HOLIDAYS"] = "2026-12-30, 2026-12-31"
        try:
            self.assertFalse(archive.is_business_day(date(2026, 12, 30)))
        finally:
            del os.environ["ARCHIVE_EXTRA_HOLIDAYS"]

    def test_due_day_default_midnight_cutoff(self):
        # Monday 2026-09-28 10:00: Friday 9/25 is the last closed business day (the weekend and 9/21-23 skipped)
        self.assertEqual(archive.due_day(at(2026, 9, 28, 10)), date(2026, 9, 25))
        self.assertEqual(archive.due_day(at(2026, 9, 29, 0, 0)), date(2026, 9, 28))
        self.assertEqual(archive.due_day(at(2026, 9, 24, 9)), date(2026, 9, 18))  # after the 9/19-23 run of days off

    def test_due_day_custom_cutoff(self):
        os.environ["ARCHIVE_CUTOFF"] = "18:00"
        try:
            self.assertEqual(archive.due_day(at(2026, 9, 28, 17, 59)), date(2026, 9, 25))
            self.assertEqual(archive.due_day(at(2026, 9, 28, 18, 0)), date(2026, 9, 28))
        finally:
            del os.environ["ARCHIVE_CUTOFF"]


class CaptureTests(unittest.TestCase):
    def setUp(self):
        with db.conn() as c:
            c.execute("DELETE FROM board_archives")

    def test_captures_once_and_flags_late(self):
        calls = []
        snap = lambda: calls.append(1) or {"tasks": [{"id": "a"}]}
        self.assertEqual(archive.ensure_captured(snap, at(2026, 9, 29, 0, 5)), "2026-09-28")
        self.assertIsNone(archive.ensure_captured(snap, at(2026, 9, 29, 9)))  # already there
        self.assertEqual(len(calls), 1)
        a = archive.read_archive("2026-09-28")
        self.assertFalse(a["late"])
        self.assertEqual(a["tasks"], [{"id": "a"}])
        archive.ensure_captured(snap, at(2026, 9, 30, 11))  # server slept until late morning
        self.assertTrue(archive.read_archive("2026-09-29")["late"])

    def test_failed_snapshot_stores_nothing(self):
        def boom():
            raise RuntimeError("kv down")
        with self.assertRaises(RuntimeError):
            archive.ensure_captured(boom, at(2026, 9, 29, 1))
        self.assertIsNone(archive.read_archive("2026-09-28"))

    def test_retention_and_listing(self):
        snap = lambda: {"tasks": []}
        archive.ensure_captured(snap, at(2026, 8, 20, 1))  # captures 8/19
        archive.ensure_captured(snap, at(2026, 9, 25, 1))  # captures 9/24
        archive.ensure_captured(snap, at(2026, 9, 29, 1))  # captures 9/28 and prunes > 31 days old
        self.assertIsNone(archive.read_archive("2026-08-19"))
        listing = archive.list_archives(at(2026, 9, 29, 10))
        days = [x["day"] for x in listing]
        self.assertEqual(days[0], "2026-09-29")
        self.assertEqual(listing[0]["state"], "open")      # today, not closed yet
        self.assertEqual(listing[1]["state"], "captured")  # 9/28
        self.assertEqual(listing[2]["state"], "missing")   # 9/25 fell between two archives: a real gap
        self.assertEqual(listing[-1]["state"], "before")   # before the first archive: not an error
        self.assertNotIn("2026-09-22", days)               # holidays are not listed


if __name__ == "__main__":
    unittest.main(verbosity=1)
