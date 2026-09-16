import asyncio, json, sys, os
from playwright.async_api import async_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8765")
SHOT = os.environ.get("SHOT_DIR", os.path.join(os.path.dirname(__file__), "screenshots")); os.makedirs(SHOT, exist_ok=True)
errors = []

def track(page, name):
    page.on("console", lambda m: errors.append(f"[{name}] console.{m.type}: {m.text}") if m.type in ("error",) else None)
    page.on("pageerror", lambda e: errors.append(f"[{name}] pageerror: {e}"))

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        # ---- user A: admin setup
        ctxA = await browser.new_context(viewport={"width": 1400, "height": 900})
        A = await ctxA.new_page(); track(A, "A")
        await A.goto(BASE)
        await A.wait_for_selector("form#f")
        assert "administrator" in await A.inner_text(".auth-card"), "setup text missing"
        await A.fill("input[name=username]", "k.minami")
        await A.fill("input[name=display_name]", "Kaito Minami")
        await A.fill("input[name=password]", "secret123")
        await A.click("button[type=submit]")
        await A.wait_for_selector("#new")
        print("A registered as admin; dashboard visible")
        # create board
        await A.click("#new")
        await A.fill("#name", "Q4 Brainstorm")
        await A.click("#ok")
        await A.wait_for_selector("#canvas")
        await A.wait_for_selector(".status-dot.on", timeout=5000)
        print("Board created & websocket connected")
        # add sticky via tool
        await A.keyboard.press("n")
        await A.mouse.click(700, 450)
        await A.wait_for_selector(".item.sticky .txt[contenteditable=true]")
        await A.keyboard.type("Hello from A")
        await A.keyboard.press("Escape")
        await A.wait_for_timeout(300)
        n = await A.locator(".item.sticky").count(); assert n == 1, f"sticky count {n}"
        txt = await A.inner_text(".item.sticky .txt"); assert "Hello from A" in txt, txt
        # change color via propbar
        await A.click(".item.sticky")
        await A.wait_for_selector(".propbar:not(.hidden)")
        await A.locator(".propbar .sw").nth(5).click()
        await A.wait_for_timeout(200)
        bg = await A.eval_on_selector(".item.sticky", "e => getComputedStyle(e).backgroundColor")
        print("sticky color now", bg); assert bg == "rgb(144, 202, 249)", bg
        # arrow tool drag
        await A.keyboard.press("Escape"); await A.keyboard.press("a")
        await A.mouse.move(300, 300); await A.mouse.down(); await A.mouse.move(500, 380, steps=5); await A.mouse.up()
        await A.wait_for_timeout(200)
        assert await A.locator("g.item-svg").count() == 1, "line not created"
        # text tool
        await A.keyboard.press("Escape"); await A.keyboard.press("t")
        await A.mouse.click(300, 200)
        await A.keyboard.type("Category: Ideas"); await A.keyboard.press("Escape")
        await A.wait_for_timeout(200)
        assert await A.locator(".item.text").count() == 1
        # frame drag
        await A.keyboard.press("f")
        await A.mouse.move(900, 200); await A.mouse.down(); await A.mouse.move(1200, 500, steps=5); await A.mouse.up()
        await A.wait_for_timeout(200); await A.keyboard.press("Escape")
        assert await A.locator(".item.frame").count() == 1
        # pen
        await A.keyboard.press("p")
        await A.mouse.move(400, 700); await A.mouse.down()
        for i in range(10): await A.mouse.move(400 + i * 20, 700 + (i % 2) * 15)
        await A.mouse.up(); await A.wait_for_timeout(200)
        assert await A.locator("g.item-svg").count() == 2, "draw not created"
        # undo removes drawing
        await A.keyboard.press("Escape")
        await A.keyboard.press("Meta+z"); await A.wait_for_timeout(200)
        assert await A.locator("g.item-svg").count() == 1, "undo failed"
        await A.keyboard.press("Meta+Shift+z"); await A.wait_for_timeout(200)
        assert await A.locator("g.item-svg").count() == 2, "redo failed"
        # move sticky by drag
        box = await A.locator(".item.sticky").bounding_box()
        before = await A.evaluate("() => { const it=[...document.querySelectorAll('.item.sticky')][0]; return it.style.transform }")
        await A.mouse.move(box["x"] + 50, box["y"] + 50); await A.mouse.down(); await A.mouse.move(box["x"] + 250, box["y"] + 150, steps=8); await A.mouse.up()
        await A.wait_for_timeout(200)
        after = await A.evaluate("() => { const it=[...document.querySelectorAll('.item.sticky')][0]; return it.style.transform }")
        assert before != after, "sticky did not move"
        # persistence check via API
        r = await ctxA.request.get(BASE + "/api/boards")
        boards = (await r.json())["owned"]; bid = boards[0]["id"]
        r = await ctxA.request.get(f"{BASE}/api/boards/{bid}")
        items = (await r.json())["items"]; print("persisted items:", sorted(i["type"] for i in items))
        assert len(items) == 5, len(items)
        await A.screenshot(path=f"{SHOT}/shot_board_A.png")

        # ---- user B: register (self-registration) in second context
        ctxB = await browser.new_context(viewport={"width": 1300, "height": 850})
        B = await ctxB.new_page(); track(B, "B")
        await B.goto(BASE); await B.wait_for_selector("#sw"); await B.click("#sw")
        await B.fill("input[name=username]", "t.suzuki"); await B.fill("input[name=display_name]", "Taro Suzuki"); await B.fill("input[name=password]", "pass1234")
        await B.click("button[type=submit]"); await B.wait_for_selector("#new")
        # B cannot access A's private board
        r = await ctxB.request.get(f"{BASE}/api/boards/{bid}"); assert r.status == 403, r.status
        print("B blocked from private board (403)")
        # A invites B as viewer via share modal
        await A.click("button.btn.primary.sm:has-text('Share')")
        await A.wait_for_selector("#inv-user"); await A.fill("#inv-user", "t.suzuki"); await A.select_option("#inv-role", "viewer"); await A.click("#inv")
        await A.wait_for_selector(".pill.amber")
        print("invite sent (pending)")
        await A.screenshot(path=f"{SHOT}/shot_share_modal.png")
        await A.keyboard.press("Escape")
        # B sees invitation on dashboard and accepts
        await B.reload(); await B.wait_for_selector("[data-accept]"); await B.click("[data-accept]")
        await B.wait_for_selector("#canvas"); await B.wait_for_selector(".status-dot.on")
        assert await B.locator(".viewonly:not(.hidden)").count() == 1, "view-only banner missing"
        assert await B.locator(".item.sticky").count() == 1
        print("B accepted invite, sees board view-only")
        # B tries to add sticky -> should not be allowed (tool disabled)
        await B.keyboard.press("n"); await B.mouse.click(600, 400); await B.wait_for_timeout(300)
        assert await B.locator(".item.sticky").count() == 1, "viewer could create"
        # A upgrades B to editor -> B gets perm message live
        await A.click("button.btn.primary.sm:has-text('Share')"); await A.wait_for_selector("select[data-role]")
        await A.select_option("select[data-role]", "editor"); await A.wait_for_timeout(500); await A.keyboard.press("Escape")
        await B.wait_for_selector(".viewonly.hidden", state="attached", timeout=5000)
        print("B upgraded to editor live")
        # B adds sticky; A sees it in realtime
        await B.keyboard.press("n"); await B.mouse.click(600, 600)
        await B.wait_for_selector(".item.sticky .txt[contenteditable=true]"); await B.keyboard.type("Hi from B"); await B.keyboard.press("Escape")
        await A.wait_for_function("() => document.querySelectorAll('.item.sticky').length === 2", timeout=5000)
        assert "Hi from B" in await A.inner_text(".item.sticky:last-child .txt") or "Hi from B" in " ".join(await A.locator(".item.sticky .txt").all_inner_texts())
        print("Realtime sync A<-B works")
        # presence: A sees 2 avatars, B's cursor appears on A after movement
        await B.mouse.move(500, 500); await B.mouse.move(520, 520)
        await A.wait_for_function("() => document.querySelectorAll('.presence .avatar').length === 2", timeout=5000)
        await A.wait_for_selector(".cursor", timeout=5000)
        print("Presence + live cursors OK")
        # B deletes a sticky, A sees removal
        await B.keyboard.press("Escape"); await B.click(".item.sticky >> nth=0"); await B.keyboard.press("Delete")
        await A.wait_for_function("() => document.querySelectorAll('.item.sticky').length === 1", timeout=5000)
        print("Realtime delete OK")

        # ---- share link + guest
        r = await ctxA.request.post(f"{BASE}/api/boards/{bid}/links", data={"permission": "edit", "allow_guests": True})
        link = (await r.json())["links"][0]; token = link["token"]
        ctxG = await browser.new_context(viewport={"width": 1200, "height": 800})
        G = await ctxG.new_page(); track(G, "G")
        await G.goto(f"{BASE}/s/{token}"); await G.wait_for_selector("#gname")
        await G.fill("#gname", "Visitor Hanako"); await G.click("#guest")
        await G.wait_for_selector("#canvas"); await G.wait_for_selector(".status-dot.on")
        assert await G.locator(".viewonly.hidden").count() == 1
        await G.keyboard.press("n"); await G.mouse.click(500, 500)
        await G.wait_for_selector(".item.sticky .txt[contenteditable=true]"); await G.keyboard.type("Guest note"); await G.keyboard.press("Escape")
        await A.wait_for_function("() => document.querySelectorAll('.item.sticky').length === 2", timeout=5000)
        await A.wait_for_function("() => document.querySelectorAll('.presence .avatar').length === 3", timeout=5000)
        print("Guest via share link can edit; A sees guest")
        await G.screenshot(path=f"{SHOT}/shot_guest.png")
        # revoke link -> guest kicked
        r = await ctxA.request.delete(f"{BASE}/api/boards/{bid}/links/{token}"); assert r.status == 200
        await G.wait_for_selector("#new, form#f, .auth-card", timeout=5000)
        print("Guest kicked after link revoked")
        # ---- version history: manual save, mutate, restore, live "items" broadcast to B
        r = await ctxA.request.post(f"{BASE}/api/boards/{bid}/snapshots", data={"label": "before cleanup"}); assert r.status == 200
        snaps = (await r.json())["snapshots"]; assert snaps and snaps[0]["label"] == "before cleanup", snaps
        n_before = snaps[0]["item_count"]
        await A.goto(f"{BASE}/b/{bid}"); await A.wait_for_selector(".status-dot.on")
        await A.keyboard.press("Meta+a"); await A.keyboard.press("Delete"); await A.wait_for_timeout(400)
        assert await A.locator(".item").count() == 0, "select-all delete failed"
        await B.goto(f"{BASE}/b/{bid}"); await B.wait_for_selector(".status-dot.on")
        r = await ctxA.request.post(f"{BASE}/api/boards/{bid}/snapshots/{snaps[0]['id']}/restore"); assert r.status == 200
        restored = (await r.json())["items"]; assert len(restored) == n_before, (len(restored), n_before)
        await A.wait_for_function(f"() => document.querySelectorAll('.item, .item-svg').length === {n_before}", timeout=5000)
        await B.wait_for_function(f"() => document.querySelectorAll('.item, .item-svg').length === {n_before}", timeout=5000)
        r = await ctxA.request.get(f"{BASE}/api/boards/{bid}/snapshots"); kinds = [x["kind"] for x in (await r.json())["snapshots"]]
        assert "auto" in kinds and kinds.count("manual") >= 2, kinds
        # guest session survives (stored in DB): re-open guest board via cookie
        print("Version history: save/restore/live-broadcast OK; kinds:", kinds)
        # ---- team board visibility
        r = await ctxA.request.post(f"{BASE}/api/boards", data={"name": "Team wall", "visibility": "team", "team_permission": "view"})
        tb = (await r.json())["board"]
        r = await ctxB.request.get(f"{BASE}/api/boards"); d = await r.json()
        assert any(b["id"] == tb["id"] for b in d["team"]), "team board not listed"
        r = await ctxB.request.get(f"{BASE}/api/boards/{tb['id']}"); assert (await r.json())["permission"] == "view"
        print("Team board visible to B as view")
        # ---- admin panel
        await A.goto(BASE + "/admin"); await A.wait_for_selector("#users tr[data-id]")
        rows = await A.locator("#users tr[data-id]").count(); assert rows == 2, rows
        await A.click("#adduser"); await A.fill("#u", "y.sato"); await A.fill("#d", "Yuki Sato"); await A.click("#ok")
        await A.wait_for_function("() => document.querySelectorAll('#users tr[data-id]').length === 3")
        await A.click(".tabs button[data-tab=settings]"); await A.wait_for_selector("#org")
        # Self-registration is always open: anyone can create their own account.
        r = await ctxG.request.post(f"{BASE}/api/auth/register", data={"username": "zzz", "password": "abcd1234"}); assert r.status == 200, r.status
        r = await ctxG.request.get(f"{BASE}/api/auth/me"); assert (await r.json())["user"]["role"] == "member"
        assert "#reg" not in await A.content() and "Allow anyone to create" not in await A.inner_text("#tab-settings")
        print("Admin: add member OK, self-registration always open (no disable switch)")
        await A.screenshot(path=f"{SHOT}/shot_admin.png")
        # export
        r = await ctxA.request.get(f"{BASE}/api/boards/{bid}/export"); ex = await r.json(); assert ex["format"] == "whiteboard/v1" and len(ex["items"]) >= 2
        # B can't delete A's board
        r = await ctxB.request.delete(f"{BASE}/api/boards/{bid}"); assert r.status == 403
        # dashboard screenshot
        await A.goto(BASE)
        try:
            await A.wait_for_selector(".board-card", timeout=10000)
        except Exception:
            print("DASHBOARD HTML:", (await A.inner_text("#app"))[:800]); print("ERRORS:", errors); raise
        await A.screenshot(path=f"{SHOT}/shot_dash.png")
        await browser.close()
    print("\nALL E2E CHECKS PASSED")
    if errors:
        print("Console/page errors:"); [print(" ", e) for e in errors]
        sys.exit(2)

asyncio.run(main())
