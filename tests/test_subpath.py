"""Регрессия: работа приложения из подпапки (GitHub Pages /<repo>/)."""
import functools
import json
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
PARENT = PROJECT.parent
FOLDER = PROJECT.name  # "Bill spliter"

failures = []
console_errors = []

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = functools.partial(QuietHandler, directory=str(PARENT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/{urllib.parse.quote(FOLDER)}/index.html"


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
        page.wait_for_timeout(1000)

        # page works
        assert page.locator("#summaryTitle").is_visible()

        # manifest resolves relative to subpath
        manifest_href = page.evaluate("document.querySelector('link[rel=\"manifest\"]').getAttribute('href')")
        print("manifest href:", manifest_href)

        # sw registration
        reg_exists = False
        for _ in range(50):
            reg_exists = page.evaluate("() => navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then(r => !!r) : Promise.resolve(false)")
            if reg_exists:
                break
            page.wait_for_timeout(200)
        print("sw registration exists:", reg_exists)
        if not reg_exists:
            failures.append("service worker not registered in subpath")

        # offline calculation
        context.set_offline(True)
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(1000)
        page.fill("#personName", "Анна")
        page.click("#personForm button[type=submit]")
        page.wait_for_timeout(200)
        page.fill("#itemName", "Пицца")
        page.fill("#itemAmount", "100")
        page.click("#itemSubmit")
        page.wait_for_timeout(300)
        total = page.inner_text("#grandTotal")
        print("offline grandTotal (subpath):", total)
        if "100" not in total:
            failures.append(f"offline calculation failed in subpath: {total}")
        context.set_offline(False)
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
