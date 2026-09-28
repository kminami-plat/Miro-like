"""Browser test for today's board (/) and the daily archives, against tests/fake_kv.py (never the real Worker).

Started by tests/run_e2e.sh with BASE_URL (whiteboard) and KV_URL (fake Worker).
"""
import asyncio, json, os, sys, urllib.error, urllib.request
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8768")
KV = os.environ.get("KV_URL", "http://127.0.0.1:8767")
KEY = "plat-todo-tasks-sandbox"
SHOT = os.environ.get("SHOT_DIR", os.path.join(os.path.dirname(__file__), "screenshots")); os.makedirs(SHOT, exist_ok=True)
TODAY = date.today()
PAST = (TODAY - timedelta(days=3)).isoformat()
FUTURE = (TODAY + timedelta(days=10)).isoformat()
errors = []


def kv(method, path, body=None):
    req = urllib.request.Request(KV + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "X-Plat-Token": "test-token"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def doc():
    return kv("GET", f"/kv/{KEY}")["value"]


def task(title):
    return next((t for t in doc()["tasks"] if t["title"] == title), None)


SEED = {
    "tasks": [
        {"id": "t1", "title": "期限切れの仕事", "status": "進行中", "priority": "重要", "assignees": ["oda-kohei"],
         "workspace": "自主事業", "project": "観光ダッシュボード", "projectId": "p1", "start": None, "end": PAST,
         "done_at": None, "effort": "重い", "memo": "元のメモ", "source": "手動", "milestoneId": "ms-1"},
        {"id": "t2", "title": "二人の仕事", "status": "未着手", "priority": "通常", "assignees": ["inoue-yohei", "takahashi-kokoro"],
         "workspace": "全社・管理", "project": "採用", "start": None, "end": FUTURE, "done_at": None, "memo": "", "source": "手動"},
        {"id": "t3", "title": "新人の仕事", "status": "未確定", "priority": "", "assignees": ["new-hire"],
         "workspace": "その他", "project": "その他", "start": None, "end": None, "done_at": None, "memo": "", "source": "手動"},
    ] + [
        {"id": f"d{i}", "title": f"完了{i}", "status": "完了", "priority": "通常", "assignees": ["oda-kohei"], "workspace": "その他",
         "project": "その他", "start": None, "end": None, "done_at": f"2026-09-0{i}", "memo": "", "source": "手動"}
        for i in range(1, 8)
    ],
    "suggestions": [{"title": "AIの候補", "why": "会議メモから"}],
    "someFutureField": 42,
}


def track(page, name):
    page.on("console", lambda m: errors.append(f"[{name}] console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[{name}] pageerror: {e}"))


def cell(row, status):
    return f".tg-cell[data-row='{row}'][data-status='{status}']"


async def wait_saved(page, check, what, timeout=10):
    for _ in range(timeout * 5):
        if check():
            return
        await page.wait_for_timeout(200)
    raise AssertionError(f"not saved to the fake KV: {what}")


async def main():
    kv("PUT", f"/kv/{KEY}", SEED)
    kv("PUT", "/kv/tasks-p1", {"nodes": {"2026-10-01": [{"title": "日程タスク", "assignees": ["inoue-yohei"], "due": FUTURE, "status": "未着手"}]}})
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})
        A = await ctx.new_page(); track(A, "A")
        await A.goto(BASE)
        await A.click("#sw")
        await A.fill("input[name=username]", "grid.user")
        await A.fill("input[name=display_name]", "Grid User")
        await A.fill("input[name=password]", "secret123")
        await A.click("button[type=submit]")
        # Log in -> straight onto today's board; the old dashboard and board creation are switched off
        await A.wait_for_selector(".tg-row-h")
        await A.wait_for_selector(".tcard[data-id=t1]")
        assert await A.locator("#new").count() == 0 and "今日のボード" in await A.inner_text(".tg-bar h1")
        status = await A.evaluate("fetch('/api/boards', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}).then(r => r.status)")
        assert status == 403, status
        await A.goto(BASE + "/b/anything"); await A.wait_for_selector(".tg-row-h")
        assert A.url.rstrip("/") == BASE, A.url
        print("login lands on today's board; board creation disabled")

        # rows: roster order, then IDs missing from the roster (new hires), then 担当なし
        names = await A.locator(".tg-row-h .rn").all_inner_texts()
        assert names == ["小田", "井上", "高橋", "new-hire", "担当なし"], names
        assert "サンドボックス" in await A.inner_text("#tg-key")
        print("rows OK:", names)

        # admins name / add / hide rows (e.g. a new hire before people.json knows them)
        await A.click("#tg-rows")
        await A.fill("#r-list tr:has-text('new-hire') [data-f=name]", "山田")
        await A.fill("#r-id", "sato-hanako"); await A.fill("#r-name", "佐藤"); await A.click("#r-add")
        await A.uncheck("#r-list tr:has-text('takahashi-kokoro') [data-f=shown]")  # hidden, but still shown: has cards
        await A.click("#r-save")
        await A.wait_for_selector(".tg-row-h .rn:text-is('佐藤')")
        names = await A.locator(".tg-row-h .rn").all_inner_texts()
        assert names == ["小田", "井上", "高橋", "山田", "佐藤", "担当なし"], names
        print("row editing OK:", names)

        # cards land in person × status; a two-person task appears in both rows
        assert await A.locator(f"{cell('oda-kohei', '進行中')} .tcard[data-id=t1]").count() == 1
        assert await A.locator(".tcard[data-id=t2]").count() == 2
        assert await A.locator(f"{cell('new-hire', '未確定')} .tcard[data-id=t3]").count() == 1
        t1 = await A.inner_text(".tcard[data-id=t1]")
        assert "⚠" in t1 and "重要" in t1 and "観光ダッシュボード" in t1, t1
        # row summary for 小田: 1 open, 1 heavy, 1 overdue
        oda = await A.locator(".tg-row-h").nth(0).inner_text()
        assert "未完了 1" in oda and "重い 1" in oda and "期限切れ 1" in oda, oda
        # 完了 is collapsed to the 5 most recent
        assert await A.locator(f"{cell('oda-kohei', '完了')} .tcard").count() == 5
        assert await A.locator(f"{cell('oda-kohei', '完了')} .tcard").first.get_attribute("data-id") == "d7"
        await A.click(f"{cell('oda-kohei', '完了')} [data-more]")
        assert await A.locator(f"{cell('oda-kohei', '完了')} .tcard").count() == 7
        await A.click("#tg-done")
        # project schedule task: read-only card with a link
        sch = A.locator(f"{cell('inoue-yohei', '未着手')} a.tcard.schedule")
        assert await sch.count() == 1 and "project.html?id=p1" in await sch.get_attribute("href")
        print("grid layout, summaries, collapse, schedule cards OK")

        # business rules in the browser match the server's
        rules = await A.evaluate("""() => { const R = PlatTaskStore.rules, t = R.today();
          return [R.isOverdue({status:'進行中', end:'2000-01-01'}), R.isOverdue({status:'進行中', end:t}), R.isOverdue({status:'完了', end:'2000-01-01'}),
                  R.isOverdue({status:'進行中', end:null}), R.isOpen({status:'相手待ち'}), R.isOpen({status:'完了'}),
                  R.isHeavy({effort:'重い'}), R.isHeavy({effort:'L'}), R.isHeavy({effort:'M'}), R.isHeavy({effort:'軽い'}), R.isHeavy({effort:2})]; }""")
        assert rules == [True, False, False, False, True, False, True, True, True, False, False], rules

        # inline card: Enter adds it and opens the next blank card; an empty card is never saved
        puts0 = kv("GET", "/__stats")["puts"]
        target = cell("takahashi-kokoro", "未着手")
        await A.hover(target); await A.click(f"{target} [data-add]")
        await A.fill(f"{target} .tcard.new textarea", "付箋から追加")
        await A.keyboard.press("Enter")
        await A.wait_for_selector(f"{target} .tcard.new textarea")
        await A.keyboard.press("Escape")  # the second, empty card is discarded
        await A.hover(cell("inoue-yohei", "相手待ち")); await A.click(f"{cell('inoue-yohei', '相手待ち')} [data-add]")
        await A.click("h1")  # blur the empty card
        await wait_saved(A, lambda: task("付箋から追加") is not None, "inline card")
        new = task("付箋から追加")
        assert new["assignees"] == ["takahashi-kokoro"] and new["status"] == "未着手" and new["source"] == "ホワイトボード", new
        assert kv("GET", "/__stats")["puts"] == puts0 + 1, "empty cards must not cause writes"
        assert len(doc()["tasks"]) == len(SEED["tasks"]) + 1
        print("inline create OK; empty cards ignored")

        # someone edits on the other page meanwhile: adds a task and changes t1's memo
        d = doc(); d["tasks"].append({"id": "ext", "title": "他ページで追加", "status": "未着手", "assignees": []})
        next(t for t in d["tasks"] if t["id"] == "t1")["memo"] = "他ページのメモ"
        kv("PUT", f"/kv/{KEY}", d)
        # drag t1 to another column (status) ...
        await A.drag_and_drop(".tcard[data-id=t1]", cell("oda-kohei", "相手待ち"))
        await A.wait_for_selector(f"{cell('oda-kohei', '相手待ち')} .tcard[data-id=t1].pending")
        await wait_saved(A, lambda: task("期限切れの仕事")["status"] == "相手待ち", "drag status")
        d = doc()
        t = task("期限切れの仕事")
        assert t["memo"] == "他ページのメモ" and t["milestoneId"] == "ms-1" and t["effort"] == "重い", t
        assert task("他ページで追加") is not None, "a concurrent add was lost"
        assert d["suggestions"] == SEED["suggestions"] and d["someFutureField"] == 42, "suggestions / unknown fields lost"
        print("drag → status OK; concurrent add, memo, suggestions and unknown fields survived")

        # ... and to another row (reassign): 井上 → 小田, keeping 高橋
        await A.drag_and_drop(f"{cell('inoue-yohei', '未着手')} .tcard[data-id=t2]", cell("oda-kohei", "進行中"))
        await wait_saved(A, lambda: task("二人の仕事")["status"] == "進行中", "drag reassign")
        assert task("二人の仕事")["assignees"] == ["takahashi-kokoro", "oda-kohei"], task("二人の仕事")
        print("drag → reassign OK")

        # 完了 sets done_at; moving back clears it
        await A.drag_and_drop(".tcard[data-id=t1]", cell("oda-kohei", "完了"))
        await wait_saved(A, lambda: task("期限切れの仕事")["status"] == "完了", "done")
        assert task("期限切れの仕事")["done_at"] == TODAY.isoformat()
        await A.click("#tg-done")
        await A.drag_and_drop(".tcard[data-id=t1]", cell("oda-kohei", "進行中"))
        await wait_saved(A, lambda: task("期限切れの仕事")["status"] == "進行中", "undone")
        assert task("期限切れの仕事")["done_at"] is None
        await A.click("#tg-done")
        print("done_at set / cleared OK")

        # writing on a card: click it, type, Enter
        await A.click(".tcard[data-id=t2] >> nth=0")
        await A.fill(".t-edit", "二人の仕事（書き換え）")
        await A.keyboard.press("Enter")
        await wait_saved(A, lambda: task("二人の仕事（書き換え）") is not None, "inline text edit")
        assert task("二人の仕事（書き換え）")["assignees"] == ["takahashi-kokoro", "oda-kohei"]
        print("inline card text edit OK")

        # a failed save stays queued, is shown, and is retried
        kv("POST", "/__fail?n=1")
        await A.hover(".tcard[data-id=t3]"); await A.click(".tcard[data-id=t3] [data-detail]")
        await A.fill("#m-title", "新人の仕事（改）")
        await A.fill("#m-end", FUTURE)
        await A.click("#m-save")
        await A.wait_for_selector(".tg-save.error", timeout=6000)
        assert task("新人の仕事") is not None, "the failed PUT must not have been applied"
        await wait_saved(A, lambda: task("新人の仕事（改）") is not None, "retry after failure", timeout=15)
        assert task("新人の仕事（改）")["end"] == FUTURE
        await A.wait_for_selector(".tg-save.saved")
        print("failed save queued, reported and retried OK")

        # modal create + delete
        await A.click("#tg-new")
        await A.fill("#m-title", "モーダルから追加")
        await A.click("#m-people label:has-text('井上')")
        await A.click("#m-save")
        await wait_saved(A, lambda: task("モーダルから追加") is not None, "modal create")
        assert task("モーダルから追加")["assignees"] == ["inoue-yohei"]
        mid = task("モーダルから追加")["id"]
        await A.hover(f".tcard[data-id='{mid}']"); await A.click(f".tcard[data-id='{mid}'] [data-detail]")
        await A.click("#m-del")
        await A.click(".modal #ok")
        await wait_saved(A, lambda: task("モーダルから追加") is None, "delete")
        assert task("他ページで追加") is not None and doc()["suggestions"] == SEED["suggestions"]
        print("modal create / delete OK")

        # filters
        await A.check("#f-od")
        await A.wait_for_timeout(100)
        ids = set(await A.locator(".tcard").evaluate_all("els => els.map(e => e.dataset.id || 'schedule')"))
        assert ids == {"t1"}, ids  # back in 進行中 with a past due date
        await A.uncheck("#f-od")
        await A.select_option("#f-ws", "全社・管理")
        ids = set(await A.locator(".tcard[data-id]").evaluate_all("els => els.map(e => e.dataset.id)"))
        assert ids == {"t2"}, ids
        await A.select_option("#f-ws", "")
        await A.select_option("#f-pj", "観光ダッシュボード")
        ids = set(await A.locator(".tcard[data-id]").evaluate_all("els => els.map(e => e.dataset.id)"))
        assert ids == {"t1"}, ids
        await A.select_option("#f-pj", "")
        print("filters OK")

        # a change made elsewhere shows up on window focus
        d = doc(); next(t for t in d["tasks"] if t["id"] == "t2")["title"] = "他ページで改名"
        kv("PUT", f"/kv/{KEY}", d)
        await A.evaluate("window.dispatchEvent(new Event('focus'))")
        await A.wait_for_selector(".tcard[data-id=t2]:has-text('他ページで改名')")
        print("refresh on focus OK")
        await A.screenshot(path=os.path.join(SHOT, "tasks-grid.png"), full_page=True)

        # end-of-day archive. The previous business day was frozen by today's first edit, *before* that
        # edit was applied — so the archive holds the seed state, and the cron call finds nothing to do.
        req = urllib.request.Request(BASE + "/api/archive/run", method="POST", headers={"X-Archive-Secret": "test-secret"})
        with urllib.request.urlopen(req) as r:
            run = json.loads(r.read())
        assert run["captured"] is None, run
        day = run["due"]
        await A.click("a[href='/archive']")
        await A.wait_for_selector(f".arc-day.ok[data-day='{day}']")
        await A.screenshot(path=os.path.join(SHOT, "archive-calendar.png"), full_page=True)
        # the live board changes afterwards; the archive must not
        d = doc(); next(t for t in d["tasks"] if t["id"] == "t2")["title"] = "記録後に改名"
        kv("PUT", f"/kv/{KEY}", d)
        await A.click(f".arc-day.ok[data-day='{day}']")
        await A.wait_for_selector(".tg.frozen .tcard[data-id=t2]")
        assert await A.locator(".tcard[data-id=t2]:has-text('二人の仕事')").count() == 2
        assert await A.locator(f"{cell('inoue-yohei', '未着手')} .tcard[data-id=t2]").count() == 1  # before the reassign
        assert await A.locator(".tcard:has-text('付箋から追加'), .tcard:has-text('記録後に改名')").count() == 0
        assert await A.locator("[data-add], [draggable=true], #tg-new, #tg-save").count() == 0, "archive must be read-only"
        names = await A.locator(".tg-row-h .rn").all_inner_texts()
        assert "山田" in names, names  # the roster as it was that day
        await A.click(".tcard[data-id=t1]")  # opens details read-only
        await A.wait_for_selector(".modal #m-title[disabled]")
        assert await A.locator("#m-save").count() == 0
        await A.keyboard.press("Escape")
        await A.screenshot(path=os.path.join(SHOT, "archive-day.png"), full_page=True)
        await A.click("a.active[href='/archive']")
        await A.wait_for_selector(".arc-cal")
        # the cron endpoint refuses callers without the secret
        try:
            urllib.request.urlopen(urllib.request.Request(BASE + "/api/archive/run", method="POST"))
            raise AssertionError("archive/run accepted a request without the secret")
        except urllib.error.HTTPError as e:
            assert e.code == 401, e.code
        print("archive capture, calendar and frozen read-only view OK")
        await browser.close()

    # Two failed requests are deliberate: the simulated Worker failure (502) and the board-creation probe (403).
    expected = [e for e in errors if "status of 502" in e or "status of 403" in e]
    rest = [e for e in errors if e not in expected]
    if rest or len(expected) != 2:
        print("\n".join(errors)); sys.exit(1)
    print("\nBOARD & ARCHIVE TESTS PASSED")


asyncio.run(main())
