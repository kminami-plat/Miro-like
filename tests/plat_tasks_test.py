"""Unit tests for server/plat_tasks.py (the read-merge-write data layer). No network, no token.

Run: .venv/bin/python tests/plat_tasks_test.py   (also run by tests/run_e2e.sh)
"""
import copy
import os
import sys
import unittest

os.environ["WB_SKIP_ENV_FILE"] = "1"  # never pick up a real token from .env
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import plat_tasks as plat  # noqa: E402

TODAY = "2026-09-28"


class FakeKv:
    """In-memory stand-in for the Worker. `before_get` / `before_put` simulate other writers."""

    def __init__(self, value=None):
        self.data = {"k": copy.deepcopy(value)}
        self.puts = 0
        self.before_put = None
        self.fail_get = False
        self.fail_put = False

    def get(self, key):
        if self.fail_get:
            raise plat.KvError("down")
        return copy.deepcopy(self.data.get(key))

    def put(self, key, value):
        if self.before_put:
            self.before_put()
        if self.fail_put:
            raise plat.KvError("down")
        self.data[key] = copy.deepcopy(value)
        self.puts += 1
        return {"ok": True}


def base_doc():
    return {
        "tasks": [
            {"id": "a", "title": "既存A", "status": "未着手", "priority": "通常", "assignees": ["oda-kohei"],
             "workspace": "自主事業", "project": "その他", "start": None, "end": "2026-10-01", "done_at": None,
             "memo": "", "source": "手動", "programId": "jishu", "createdAt": "2026-08-05T02:14:49.458Z", "effort": 2},
            {"id": "b", "title": "既存B", "status": "完了", "priority": "重要", "assignees": [],
             "workspace": "その他", "project": "その他", "start": None, "end": None, "done_at": "2026-09-01",
             "memo": "", "source": "手動"},
        ],
        "suggestions": [{"title": "AI候補", "confidence": 0.8, "nested": {"x": [1, 2]}}],
        "futureTopLevel": {"keep": True},
    }


def store(value=None):
    kv = FakeKv(base_doc() if value is None else value)
    return plat.TaskStore(kv, "k"), kv


class MergeTests(unittest.TestCase):
    def test_save_keeps_task_added_by_someone_else_meanwhile(self):
        s, kv = store()
        # The other page adds a task after we loaded but before we save.
        s.load()
        kv.data["k"]["tasks"].append({"id": "other", "title": "他ユーザーの追加", "status": "未着手"})
        s.save_task({"id": "a", "status": "進行中"}, fields=["status"], today=TODAY)
        ids = [t["id"] for t in kv.data["k"]["tasks"]]
        self.assertEqual(ids, ["a", "b", "other"])

    def test_update_changes_only_given_fields(self):
        s, kv = store()
        # Someone edits A's memo on the other page; we then change A's status from a stale copy.
        kv.data["k"]["tasks"][0]["memo"] = "他ユーザーのメモ"
        s.apply([{"op": "save", "id": "a", "create": False, "changes": {"status": "進行中"}}], TODAY)
        a = kv.data["k"]["tasks"][0]
        self.assertEqual(a["status"], "進行中")
        self.assertEqual(a["memo"], "他ユーザーのメモ")

    def test_suggestions_and_unknown_fields_survive(self):
        s, kv = store()
        before = base_doc()
        s.save_task({"id": "a", "title": "改名"}, fields=["title"], today=TODAY)
        after = kv.data["k"]
        self.assertEqual(after["suggestions"], before["suggestions"])
        self.assertEqual(after["futureTopLevel"], before["futureTopLevel"])
        a = after["tasks"][0]
        for k in ("programId", "createdAt", "effort", "source"):
            self.assertEqual(a[k], before["tasks"][0][k], k)
        self.assertEqual(after["tasks"][1], before["tasks"][1])  # untouched task byte-for-byte equal

    def test_no_suggestions_key_is_not_invented(self):
        s, kv = store({"tasks": []})
        s.save_task({"title": "新規"}, today=TODAY)
        self.assertNotIn("suggestions", kv.data["k"])

    def test_create_sets_defaults_and_source(self):
        s, kv = store()
        doc, res = s.apply([{"op": "save", "id": "new-1", "create": True,
                              "changes": {"title": " 新しいカード ", "status": "進行中", "assignees": ["oda-kohei", "oda-kohei"]}}], TODAY)
        t = kv.data["k"]["tasks"][-1]
        self.assertTrue(res[0]["ok"])
        self.assertEqual((t["id"], t["title"], t["assignees"]), ("new-1", "新しいカード", ["oda-kohei"]))
        self.assertEqual((t["source"], t["created"], t["done_at"]), (plat.SOURCE, TODAY, None))

    def test_empty_card_is_never_saved(self):
        s, kv = store()
        _, res = s.apply([{"op": "save", "id": "x", "create": True, "changes": {"title": "   "}}], TODAY)
        self.assertFalse(res[0]["ok"])
        self.assertEqual(kv.puts, 0)
        with self.assertRaises(plat.KvError):
            s.save_task({"id": "a", "title": ""}, fields=["title"], today=TODAY)

    def test_retried_create_is_idempotent(self):
        s, kv = store()
        op = {"op": "save", "id": "n", "create": True, "changes": {"title": "一度だけ"}}
        s.apply([op], TODAY)
        s.apply([op], TODAY)  # e.g. the response was lost and the browser retried
        self.assertEqual([t["id"] for t in kv.data["k"]["tasks"]].count("n"), 1)

    def test_update_of_remotely_deleted_task_does_not_resurrect_it(self):
        s, kv = store()
        kv.data["k"]["tasks"] = [t for t in kv.data["k"]["tasks"] if t["id"] != "a"]
        _, res = s.apply([{"op": "save", "id": "a", "create": False, "changes": {"status": "進行中"}}], TODAY)
        self.assertFalse(res[0]["ok"])
        self.assertNotIn("a", [t["id"] for t in kv.data["k"]["tasks"]])

    def test_delete(self):
        s, kv = store()
        s.delete_task("a")
        self.assertEqual([t["id"] for t in kv.data["k"]["tasks"]], ["b"])
        self.assertEqual(kv.data["k"]["suggestions"], base_doc()["suggestions"])

    def test_failed_read_writes_nothing(self):
        s, kv = store()
        kv.fail_get = True
        with self.assertRaises(plat.KvError):
            s.save_task({"id": "a", "status": "完了"}, fields=["status"], today=TODAY)
        self.assertEqual(kv.puts, 0)

    def test_malformed_document_is_not_overwritten(self):
        s, kv = store({"tasks": "oops"})
        with self.assertRaises(plat.KvError):
            s.save_task({"title": "x"}, today=TODAY)
        self.assertEqual(kv.data["k"], {"tasks": "oops"})

    def test_empty_production_key_is_never_written(self):
        kv = FakeKv(None)
        kv.data[plat.PRODUCTION_KEY] = None
        s = plat.TaskStore(kv, plat.PRODUCTION_KEY)
        with self.assertRaises(plat.KvError):
            s.save_task({"title": "x"}, today=TODAY)
        self.assertEqual(kv.puts, 0)

    def test_failed_put_raises_so_the_client_keeps_it_queued(self):
        s, kv = store()
        kv.fail_put = True
        with self.assertRaises(plat.KvError):
            s.save_task({"id": "a", "status": "進行中"}, fields=["status"], today=TODAY)
        self.assertEqual(kv.data["k"], base_doc())

    def test_invalid_values_rejected(self):
        s, kv = store()
        _, res = s.apply([{"op": "save", "id": "a", "create": False, "changes": {"status": "やる"}},
                          {"op": "save", "id": "a", "create": False, "changes": {"end": "10/1"}}], TODAY)
        self.assertEqual([r["ok"] for r in res], [False, False])
        self.assertEqual(kv.puts, 0)


class DoneAtTests(unittest.TestCase):
    def test_done_sets_done_at_and_moving_back_clears_it(self):
        s, kv = store()
        s.save_task({"id": "a", "status": "完了"}, fields=["status"], today=TODAY)
        self.assertEqual(kv.data["k"]["tasks"][0]["done_at"], TODAY)
        s.save_task({"id": "a", "status": "進行中"}, fields=["status"], today=TODAY)
        self.assertIsNone(kv.data["k"]["tasks"][0]["done_at"])

    def test_done_task_keeps_its_original_done_at(self):
        s, kv = store()
        s.save_task({"id": "b", "status": "完了", "title": "既存B改"}, fields=["status", "title"], today=TODAY)
        self.assertEqual(kv.data["k"]["tasks"][1]["done_at"], "2026-09-01")

    def test_non_status_edit_does_not_touch_done_at(self):
        s, kv = store()
        s.save_task({"id": "b", "memo": "追記"}, fields=["memo"], today=TODAY)
        self.assertEqual(kv.data["k"]["tasks"][1]["done_at"], "2026-09-01")

    def test_created_as_done(self):
        s, kv = store()
        s.save_task({"title": "最初から完了", "status": "完了"}, today=TODAY)
        self.assertEqual(kv.data["k"]["tasks"][-1]["done_at"], TODAY)


class RuleTests(unittest.TestCase):
    def test_open(self):
        self.assertTrue(plat.is_open({"status": "進行中"}))
        self.assertTrue(plat.is_open({"status": "未確定"}))
        self.assertFalse(plat.is_open({"status": "完了"}))

    def test_overdue(self):
        self.assertTrue(plat.is_overdue({"status": "進行中", "end": "2026-09-27"}, TODAY))
        self.assertFalse(plat.is_overdue({"status": "進行中", "end": TODAY}, TODAY))  # due today is not late
        self.assertFalse(plat.is_overdue({"status": "完了", "end": "2026-01-01"}, TODAY))
        self.assertFalse(plat.is_overdue({"status": "進行中", "end": None}, TODAY))  # no due date: never overdue
        self.assertFalse(plat.is_overdue({"status": "進行中"}, TODAY))

    def test_heavy(self):
        for e in ("重い", "L", "M"):
            self.assertTrue(plat.is_heavy({"effort": e}), e)
        for e in ("軽い", "S", None, 1, 2):
            self.assertFalse(plat.is_heavy({"effort": e}), e)


class ProjectTaskTests(unittest.TestCase):
    def test_flattens_nodes_read_only(self):
        kv = FakeKv()
        kv.data["tasks-p1"] = {"nodes": {"2026-10-01": [{"title": "日程A", "assignees": ["oda-kohei"], "due": "2026-10-01", "status": "未着手"}],
                                         "2026-11-01": []}, "updatedAt": "x"}
        rows = plat.project_tasks(kv, ["p1", "missing"])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["projectId"], rows[0]["end"], rows[0]["node"]), ("p1", "2026-10-01", "2026-10-01"))
        self.assertEqual(kv.puts, 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
