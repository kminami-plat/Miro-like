"""Second write client for Plat Yonezawa's shared task store (the "plat-kv" Cloudflare Worker).

The Worker keeps one JSON document per key and a PUT replaces the whole value, while the existing
plat-todo page (https://pm.plat-yonezawa.com/plat-todo/) edits the same document at the same time.
So every write here is read-merge-write: GET the latest document, apply only our change to it
(matched by task id), PUT it back. Everything we don't edit — other people's tasks, `suggestions`,
unknown top-level keys and unknown task fields — is carried over exactly as received.

This module has no FastAPI dependency so it can be reused (scripts, tests); the HTTP routes in
server/main.py are thin wrappers around `TaskStore` and `reference_data()`.

Configuration is read from the environment at call time (see `settings()`):
  PLAT_KV_URL          Worker base URL (default https://plat-kv.k-oda.workers.dev)
  PLAT_KV_TOKEN        write token, sent as X-Plat-Token. Unset = the grid is read-only.
  PLAT_LOCAL_ONLY      1 = edit without a token: writes go to data/plat/local_kv.json and never reach
                       the Worker (reads fall through to it until a key has been edited locally).
  PLAT_TASKS_KEY       storage key (default plat-todo-tasks-sandbox; production is plat-todo-tasks)
  PLAT_DATA_URL        where people/domains/projects JSON live (default https://pm.plat-yonezawa.com)
  PLAT_ACCESS_CLIENT_ID / PLAT_ACCESS_CLIENT_SECRET
                       Cloudflare Access service token for PLAT_DATA_URL (it sits behind Access)
  PLAT_LOCAL_DATA_DIR  fallback folder with people.json / domains.json / projects.json (default data/plat)
  PLAT_PROJECT_IDS     extra project ids whose `tasks-<id>` schedules should be shown (comma-separated)
"""
from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

PRODUCTION_KEY = "plat-todo-tasks"
SANDBOX_KEY = "plat-todo-tasks-sandbox"
SOURCE = "ホワイトボード"  # `source` written on tasks created by this client

STATUSES = ["未確定", "未着手", "進行中", "相手待ち", "完了"]
DONE = "完了"
PRIORITIES = ["通常", "重要", "今日やる"]
WORKSPACES = ["DMO事業", "自主事業", "全社・管理", "その他"]
HEAVY_EFFORTS = {"重い", "L", "M"}
# Fields this client may change on an existing task. Anything else is preserved untouched.
EDITABLE = ("title", "status", "priority", "assignees", "workspace", "project", "projectId", "start", "end", "memo")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
JST = timezone(timedelta(hours=9))  # Japan has no DST, so a fixed offset is exact


class KvError(Exception):
    """A read or write against the Worker failed. The message is shown to users (Japanese)."""


class ValidationError(ValueError):
    """A task payload from the browser is invalid. The message is shown to users (Japanese)."""


# ------------------------------------------------------------------ business rules (match plat-todo)

def today_jst() -> str:
    return datetime.now(JST).strftime("%Y-%m-%d")


def is_open(task: dict) -> bool:
    return task.get("status") != DONE


def is_overdue(task: dict, today: str) -> bool:
    """Open, has a due date (`end`), and that date is before today. Compared as YYYY-MM-DD strings."""
    end = task.get("end")
    return is_open(task) and bool(end) and str(end) < today


def is_heavy(task: dict) -> bool:
    return task.get("effort") in HEAVY_EFFORTS


def apply_done_at(task: dict, previous_status: Optional[str], today: str) -> None:
    """Set `done_at` when the task becomes 完了; clear it when it is anything else."""
    if task.get("status") == DONE:
        if previous_status != DONE or not task.get("done_at"):
            task["done_at"] = today
    else:
        task["done_at"] = None


# ------------------------------------------------------------------ settings

def settings() -> dict[str, Any]:
    here = os.path.dirname(__file__)
    return {
        "kv_url": os.environ.get("PLAT_KV_URL", "https://plat-kv.k-oda.workers.dev").rstrip("/"),
        "token": os.environ.get("PLAT_KV_TOKEN", "").strip(),
        "local_only": os.environ.get("PLAT_LOCAL_ONLY", "").strip().lower() in ("1", "true", "yes", "on"),
        "key": os.environ.get("PLAT_TASKS_KEY", SANDBOX_KEY).strip() or SANDBOX_KEY,
        "data_url": os.environ.get("PLAT_DATA_URL", "https://pm.plat-yonezawa.com").rstrip("/"),
        "access_id": os.environ.get("PLAT_ACCESS_CLIENT_ID", "").strip(),
        "access_secret": os.environ.get("PLAT_ACCESS_CLIENT_SECRET", "").strip(),
        "local_dir": os.environ.get("PLAT_LOCAL_DATA_DIR", os.path.join(here, "..", "data", "plat")),
        "project_ids": [p.strip() for p in os.environ.get("PLAT_PROJECT_IDS", "").split(",") if p.strip()],
    }


# ------------------------------------------------------------------ Worker client

class KvClient:
    """Minimal client for GET/PUT /kv/<key>. Uses urllib so the server needs no extra dependency."""

    def __init__(self, base_url: str, token: str = "", timeout: float = 12.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _call(self, method: str, key: str, body: Any = None) -> dict:
        url = f"{self.base_url}/kv/{urllib.request.quote(key, safe='')}"
        headers = {"Accept": "application/json", "User-Agent": "whiteboard-plat-client/1"}
        data = None
        if method == "GET":
            url += f"?t={int(time.time() * 1000)}"  # the Worker's cache-buster convention
            headers["Cache-Control"] = "no-store"
        else:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
            if self.token:
                headers["X-Plat-Token"] = self.token
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                payload = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise KvError("タスクストアへの書き込みが拒否されました（トークンが無効です）") from e
            raise KvError(f"タスクストアがエラーを返しました（HTTP {e.code}）") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise KvError("タスクストアに接続できません。時間をおいて再試行します") from e
        except ValueError as e:
            raise KvError("タスクストアの応答を読み取れませんでした") from e
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise KvError(f"タスクストアがエラーを返しました（{(payload or {}).get('error', '不明')}）")
        return payload

    def get(self, key: str) -> Any:
        return self._call("GET", key).get("value")

    def put(self, key: str, value: Any) -> dict:
        if not self.token:
            raise KvError("書き込み用トークン（PLAT_KV_TOKEN）が設定されていません")
        return self._call("PUT", key, value)


class LocalKv:
    """Overlay store for PLAT_LOCAL_ONLY: put() writes a local JSON file, get() prefers it and
    otherwise reads through to `remote`. Nothing is ever PUT to the Worker."""

    def __init__(self, remote: Any, path: str):
        self.remote = remote
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self, key: str) -> Any:
        with self._lock:
            local = self._read()
        return local[key] if key in local else self.remote.get(key)

    def put(self, key: str, value: Any) -> dict:
        with self._lock:
            local = self._read()
            local[key] = value
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(local, fh, ensure_ascii=False)
            os.replace(tmp, self.path)
        return {"ok": True}


# ------------------------------------------------------------------ validation

def _clean_date(v: Any, label: str) -> Optional[str]:
    if v in (None, ""):
        return None
    if not isinstance(v, str) or not DATE_RE.match(v):
        raise ValidationError(f"{label}は YYYY-MM-DD 形式で入力してください")
    return v


def _clean_str(v: Any, limit: int) -> str:
    return (v if isinstance(v, str) else "" if v is None else str(v)).strip()[:limit]


def clean_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Validate the editable fields present in `fields`; unknown keys are dropped."""
    out: dict[str, Any] = {}
    for k in EDITABLE:
        if k not in fields:
            continue
        v = fields[k]
        if k == "title":
            v = _clean_str(v, 500)
            if not v:
                raise ValidationError("タイトルが空のタスクは保存できません")
        elif k == "status":
            if v not in STATUSES:
                raise ValidationError("ステータスの値が不正です")
        elif k == "priority":
            if v not in PRIORITIES and v != "":
                raise ValidationError("優先度の値が不正です")
        elif k == "assignees":
            if not isinstance(v, list):
                raise ValidationError("担当者の値が不正です")
            seen: list[str] = []
            for a in v:
                a = _clean_str(a, 80)
                if a and a not in seen:
                    seen.append(a)
            v = seen[:30]
        elif k in ("workspace", "project"):
            v = _clean_str(v, 120) or "その他"
        elif k == "projectId":
            v = _clean_str(v, 120) or None
        elif k in ("start", "end"):
            v = _clean_date(v, "開始日" if k == "start" else "期限")
        elif k == "memo":
            v = _clean_str(v, 10000)
        out[k] = v
    return out


def new_task(fields: dict[str, Any], today: str, task_id: Optional[str] = None) -> dict[str, Any]:
    f = clean_fields(fields)
    if not f.get("title"):
        raise ValidationError("タイトルが空のタスクは保存できません")
    task = {
        "id": _clean_str(task_id, 80) or str(uuid.uuid4()),
        "title": f["title"],
        "status": f.get("status", "未着手"),
        "priority": f.get("priority", "通常"),
        "assignees": f.get("assignees", []),
        "workspace": f.get("workspace", "その他"),
        "project": f.get("project", "その他"),
        "start": f.get("start"),
        "end": f.get("end"),
        "done_at": None,
        "memo": f.get("memo", ""),
        "source": SOURCE,
        "created": today,
    }
    if f.get("projectId"):
        task["projectId"] = f["projectId"]
    apply_done_at(task, None, today)
    return task


# ------------------------------------------------------------------ the store

class TaskStore:
    """Read-merge-write access to one plat-todo tasks key.

    `kv` is anything with get(key) / put(key, value) — a KvClient in production, a fake in tests.
    Writes from this process are serialised with a lock, so two whiteboard users never race each
    other; the remaining race is with the plat-todo page itself (see docs/plat-tasks/DESIGN.md).
    """

    def __init__(self, kv: Any, key: str):
        self.kv = kv
        self.key = key
        self._lock = threading.Lock()

    # -- reads
    def load(self) -> dict[str, Any]:
        """Return the whole document ({tasks, suggestions, ...}); an empty key reads as no tasks."""
        return self._validated(self.kv.get(self.key), for_write=False)

    def _validated(self, value: Any, for_write: bool) -> dict[str, Any]:
        if value is None:
            if for_write and self.key == PRODUCTION_KEY:
                # An empty production key almost certainly means a bad read; writing would wipe it.
                raise KvError("本番のタスクデータが空で返ってきたため、安全のため保存を中止しました")
            return {"tasks": []}
        if not isinstance(value, dict) or not isinstance(value.get("tasks"), list):
            raise KvError("タスクデータの形式が想定と異なるため、保存を中止しました")
        return value

    # -- writes
    def save_task(self, task: dict[str, Any], fields: Optional[list[str]] = None, today: Optional[str] = None) -> dict[str, Any]:
        """Create or update one task. With `fields`, only those keys of `task` are applied."""
        changes = {k: task[k] for k in (fields or EDITABLE) if k in task}
        doc, results = self.apply([{"op": "save", "id": task.get("id"), "changes": changes}], today)
        if not results[0]["ok"]:
            raise KvError(results[0]["error"])
        return doc

    def delete_task(self, task_id: str) -> dict[str, Any]:
        doc, _ = self.apply([{"op": "delete", "id": task_id}])
        return doc

    def apply(self, ops: list[dict[str, Any]], today: Optional[str] = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Apply a batch of ops to a freshly read document and write it back once.

        ops: {"op": "save", "id", "changes"} (creates the task when the id is unknown)
             {"op": "delete", "id"}
        Returns (document as written, one result per op). A failed read or write raises KvError
        and nothing is written; the caller keeps its ops queued and retries.
        """
        today = today if isinstance(today, str) and DATE_RE.match(today) else today_jst()
        with self._lock:
            doc = copy.deepcopy(self._validated(self.kv.get(self.key), for_write=True))
            tasks: list[Any] = doc["tasks"]
            results: list[dict[str, Any]] = []
            changed = False
            for op in ops[:200]:
                tid = _clean_str(op.get("id"), 80)
                idx = next((i for i, t in enumerate(tasks) if isinstance(t, dict) and t.get("id") == tid), None) if tid else None
                try:
                    if op.get("op") == "delete":
                        if idx is not None:
                            tasks.pop(idx)
                            changed = True
                        results.append({"id": tid, "ok": True})
                    elif op.get("op") == "save":
                        changes = op.get("changes") or {}
                        if idx is None:
                            if op.get("create") is False:
                                # An update for a task someone deleted meanwhile: don't resurrect it.
                                results.append({"id": tid, "ok": False, "error": "このタスクは他の人によって削除されていました"})
                                continue
                            t = new_task(changes, today, tid)
                            tasks.append(t)
                            results.append({"id": t["id"], "ok": True, "created": True})
                        else:
                            t = tasks[idx]
                            before = t.get("status")
                            f = clean_fields(changes)
                            if not f:
                                results.append({"id": tid, "ok": True})
                                continue
                            t.update(f)
                            if "status" in f:
                                apply_done_at(t, before, today)
                            results.append({"id": tid, "ok": True})
                        changed = True
                    else:
                        results.append({"id": tid, "ok": False, "error": "不明な操作です"})
                except ValidationError as e:
                    results.append({"id": tid, "ok": False, "error": str(e)})
            if changed:
                self.kv.put(self.key, doc)
            return doc, results


# ------------------------------------------------------------------ project schedule tasks (read-only)

def project_tasks(kv: Any, project_ids: list[str]) -> list[dict[str, Any]]:
    """Flatten `tasks-<projectId>` documents into rows for the grid. Unreadable keys are skipped."""

    def one(pid: str) -> list[dict[str, Any]]:
        try:
            v = kv.get(f"tasks-{pid}")
        except KvError:
            return []
        nodes = v.get("nodes") if isinstance(v, dict) else None
        out = []
        for node, items in (nodes or {}).items():
            for i, t in enumerate(items if isinstance(items, list) else []):
                if isinstance(t, dict) and t.get("title"):
                    out.append({
                        "projectId": pid, "node": node, "index": i, "title": t.get("title"),
                        "assignees": [a for a in (t.get("assignees") or []) if isinstance(a, str)],
                        "start": t.get("start"), "end": t.get("due"), "status": t.get("status") or "未着手",
                        "effort": t.get("effort"), "memo": t.get("memo") or "",
                    })
        return out

    ids = list(dict.fromkeys(project_ids))[:60]
    if not ids:
        return []
    with ThreadPoolExecutor(max_workers=min(8, len(ids))) as pool:
        return [t for chunk in pool.map(one, ids) for t in chunk]


# ------------------------------------------------------------------ reference data (people, areas, projects)

_REF_CACHE: dict[str, tuple[float, Any, str]] = {}
REF_TTL = 600
REF_PATHS = {
    "people": "/plat-todo/data/people.json",
    "domains": "/dashboard/data/domains.json",
    "projects": "/dashboard/data/projects.json",
}


def _fetch_remote_json(url: str, cfg: dict[str, Any]) -> Any:
    headers = {"Accept": "application/json", "User-Agent": "whiteboard-plat-client/1",
               "CF-Access-Client-Id": cfg["access_id"], "CF-Access-Client-Secret": cfg["access_secret"]}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        if "json" not in (r.headers.get("Content-Type") or ""):
            raise ValueError("not JSON (probably the Cloudflare Access login page)")
        return json.loads(r.read().decode("utf-8"))


def reference_data(name: str, fetch: Optional[Callable[[str, dict], Any]] = None) -> tuple[Any, str]:
    """Return (data, source) for people/domains/projects. Never writes anything.

    pm.plat-yonezawa.com is behind Cloudflare Access, so the remote copy is only tried when a
    service token is configured. Otherwise a local copy in PLAT_LOCAL_DATA_DIR is used, and if
    that is missing too the caller derives what it can from the tasks (source "none").
    """
    cfg = settings()
    hit = _REF_CACHE.get(name)
    if hit and time.time() - hit[0] < REF_TTL:
        return hit[1], hit[2]
    data, source = None, "none"
    if cfg["access_id"] and cfg["access_secret"]:
        try:
            data, source = (fetch or _fetch_remote_json)(cfg["data_url"] + REF_PATHS[name], cfg), "remote"
        except Exception as e:  # fall back to the local copy; log once per refresh
            print(f"[plat] {name}.json を取得できませんでした: {e}")
    if data is None:
        try:
            with open(os.path.join(cfg["local_dir"], f"{name}.json"), encoding="utf-8") as fh:
                data, source = json.load(fh), "file"
        except (OSError, ValueError):
            pass
    _REF_CACHE[name] = (time.time(), data, source)
    return data, source


def _as_list(data: Any, *keys: str) -> list[dict]:
    if isinstance(data, dict):
        for k in keys:
            if isinstance(data.get(k), list):
                data = data[k]
                break
    return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []


def normalized_reference() -> dict[str, Any]:
    """People, workspaces and projects in the shape the grid uses, plus where each came from."""
    people_raw, people_src = reference_data("people")
    domains_raw, domains_src = reference_data("domains")
    projects_raw, projects_src = reference_data("projects")
    people = [
        {"id": str(p["id"]), "name": str(p.get("name") or p["id"]), "initials": str(p.get("initials") or ""),
         "color": str(p.get("color") or ""), "role": str(p.get("role") or "")}
        for p in _as_list(people_raw, "people", "members") if p.get("id")
    ]
    workspaces = [str(d.get("label") or d.get("name") or d.get("title") or d.get("id"))
                  for d in _as_list(domains_raw, "domains", "areas") if d.get("label") or d.get("name") or d.get("title") or d.get("id")]
    projects = []
    for p in _as_list(projects_raw, "projects"):
        label = p.get("label") or p.get("name") or p.get("title")
        if p.get("id") and label:
            projects.append({"id": str(p["id"]), "label": str(label),
                             "workspace": str(p.get("workspace") or p.get("domain") or p.get("area") or "")})
    return {
        "people": people,
        "workspaces": list(dict.fromkeys(workspaces or WORKSPACES)),
        "projects": projects,
        "sources": {"people": people_src, "domains": domains_src, "projects": projects_src},
    }


_STORE: dict[tuple, TaskStore] = {}


def get_store() -> TaskStore:
    """One TaskStore per (url, key, token) so the write lock is shared by every request."""
    cfg = settings()
    k = (cfg["kv_url"], cfg["key"], cfg["token"], cfg["local_only"])
    if k not in _STORE:
        kv: Any = KvClient(cfg["kv_url"], cfg["token"])
        if cfg["local_only"]:
            kv = LocalKv(kv, os.path.join(cfg["local_dir"], "local_kv.json"))
        _STORE[k] = TaskStore(kv, cfg["key"])
    return _STORE[k]
