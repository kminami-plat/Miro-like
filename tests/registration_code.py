"""Checks the REGISTRATION_CODE gate. Run by tests/run_e2e.sh against a server started
with REGISTRATION_CODE set (see that script); the code below must match it.

Covers the case the main suite cannot: the code is read from the environment, so it is fixed
for the lifetime of the server process and needs its own instance.
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8766")
CODE = "ゲート-2026"  # matches tests/run_e2e.sh
SHOT = os.path.join(os.path.dirname(__file__), "screenshots")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await browser.new_context(viewport={"width": 1200, "height": 900})
        page = await ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        # The settings endpoint advertises that a code is needed, but never leaks the code itself.
        r = await ctx.request.get(f"{BASE}/api/auth/me")
        settings = (await r.json())["settings"]
        assert settings["registration_code_required"] is True, settings
        assert CODE not in await r.text(), "the invite code must never be sent to the browser"
        print("settings advertise the gate without leaking the code")

        # No code / wrong code are refused; the right code is accepted.
        r = await ctx.request.post(f"{BASE}/api/auth/register", data={"username": "nocode", "password": "abcd1234"})
        assert r.status == 403, r.status
        r = await ctx.request.post(f"{BASE}/api/auth/register", data={"username": "nocode", "password": "abcd1234", "code": "wrong"})
        assert r.status == 403, r.status
        r = await ctx.request.post(f"{BASE}/api/auth/register", data={"username": "nocode", "password": "abcd1234", "code": CODE + "x"})
        assert r.status == 403, r.status
        print("missing / wrong / near-miss codes rejected (403)")

        # The register card shows the code field, and a real person can sign up through it.
        await page.goto(BASE)
        await page.wait_for_selector("form#f")
        await page.click("#sw")
        await page.wait_for_selector("input[name=code]")
        await page.fill("input[name=username]", "k.minami")
        await page.fill("input[name=display_name]", "Kaito Minami")
        await page.fill("input[name=password]", "secret123")
        await page.fill("input[name=code]", CODE)
        await page.screenshot(path=f"{SHOT}/shot_register_code.png")
        await page.click("button[type=submit]")
        await page.wait_for_selector("#new")
        print("registered through the UI with the code; first account is admin")

        # That first account is admin, and the admin panel reports the gate as read-only text.
        r = await ctx.request.get(f"{BASE}/api/auth/me")
        assert (await r.json())["user"]["role"] == "admin"
        r = await ctx.request.get(f"{BASE}/api/admin/settings")
        body = await r.json()
        assert body["registration_code_required"] is True and "registration_code" not in body, body
        await page.goto(BASE + "/admin")
        await page.click(".tabs button[data-tab=settings]")
        await page.wait_for_selector("#regcode")
        assert "設定済み" in await page.inner_text("#regcode")
        assert await page.locator("#savecode").count() == 0, "the code must not be editable from the UI"
        print("admin panel shows the gate as read-only")

        # A wrong code still fails from the browser, with the Japanese message.
        ctx2 = await browser.new_context()
        page2 = await ctx2.new_page()
        await page2.goto(BASE)
        await page2.wait_for_selector("form#f")
        await page2.click("#sw")
        await page2.fill("input[name=username]", "t.suzuki")
        await page2.fill("input[name=password]", "pass1234")
        await page2.fill("input[name=code]", "dame")
        await page2.click("button[type=submit]")
        await page2.wait_for_selector("#err:not(:empty)")
        assert "招待コード" in await page2.inner_text("#err"), await page2.inner_text("#err")
        print("browser shows the Japanese error for a wrong code")

        if errors:
            print("BROWSER ERRORS:", errors)
            sys.exit(1)
        await browser.close()
    print("\nREGISTRATION CODE CHECKS PASSED")


asyncio.run(main())
