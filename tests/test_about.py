"""Регрессия: окно «О приложении»."""
import functools
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
failures = []
console_errors = []

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html"


def new_page(browser, url):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ru-RU")
    page = context.new_page()
    page.on("console", lambda m: console_errors.append(f"console.{m.type}: {m.text}")
            if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
    page.goto(url)
    page.wait_for_load_state("networkidle")
    return context, page


server, url = start_server()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        context, page = new_page(browser, url)
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        # open
        page.click("#aboutBtn")
        page.wait_for_timeout(200)
        dialog = page.locator("#aboutDialog")
        print("dialog open:", dialog.is_visible() if hasattr(dialog, "is_visible") else "n/a")
        # showModal -> open attribute
        is_open = page.evaluate("document.getElementById('aboutDialog').hasAttribute('open')")
        print("dialog has open attr:", is_open)
        if not is_open:
            failures.append("dialog did not open")

        # text present
        body = page.inner_text("#aboutDialog")
        for needle in ("Chrome", "Safari", "Поделиться", "без интернета", "устройств"):
            if needle not in body:
                failures.append(f"about text missing: {needle}")
        print("about body contains install hints:", all(n in body for n in ("Chrome", "Safari")))

        # close by button
        page.click("#aboutClose")
        page.wait_for_timeout(200)
        is_open2 = page.evaluate("document.getElementById('aboutDialog').hasAttribute('open')")
        print("dialog closed by button:", not is_open2)
        if is_open2:
            failures.append("dialog not closed by button")
        focused = page.evaluate("document.activeElement && document.activeElement.id")
        print("focus returned to:", focused)
        if focused != "aboutBtn":
            failures.append(f"focus not returned: {focused}")

        # reopen and close by Esc
        page.click("#aboutBtn")
        page.wait_for_timeout(200)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        is_open3 = page.evaluate("document.getElementById('aboutDialog').hasAttribute('open')")
        print("dialog closed by Esc:", not is_open3)
        if is_open3:
            failures.append("dialog not closed by Esc")
        focused2 = page.evaluate("document.activeElement && document.activeElement.id")
        if focused2 != "aboutBtn":
            failures.append(f"focus not returned after Esc: {focused2}")

        context.close()
    finally:
        browser.close()

server.shutdown()

if console_errors:
    print("CONSOLE ERRORS:")
    for err in console_errors:
        print("  " + err)
    if any("pageerror" in e for e in console_errors):
        failures.append("page errors present")

if failures:
    print(f"\nRESULT: {len(failures)} failure(s): {failures}")
    sys.exit(1)
else:
    print("\nRESULT: all checks passed")
