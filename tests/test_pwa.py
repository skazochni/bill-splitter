"""Регрессия: PWA-манифест и service worker, офлайн-работа."""
import functools
import json
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
        page.wait_for_timeout(1000)

        # manifest link present
        manifest_href = page.evaluate("document.querySelector('link[rel=\"manifest\"]')?.getAttribute('href')")
        print("manifest href:", manifest_href)
        if manifest_href != "manifest.webmanifest":
            failures.append("manifest link missing/wrong")

        # fetch and validate manifest
        manifest_text = page.evaluate("() => fetch('manifest.webmanifest').then(r => r.text())")
        try:
            manifest = json.loads(manifest_text)
        except Exception as e:
            failures.append("manifest not valid JSON")
            manifest = {}
        for field in ("name", "short_name", "lang", "start_url", "display", "background_color", "theme_color", "icons"):
            if field not in manifest:
                failures.append(f"manifest missing field: {field}")
        if manifest.get("lang") != "ru":
            failures.append("manifest lang != ru")
        if manifest.get("display") != "standalone":
            failures.append("manifest display != standalone")
        for icon in manifest.get("icons", []):
            icon_url = icon.get("src")
            exists = page.evaluate("(u) => fetch(u).then(r => r.ok).catch(() => false)", icon_url)
            if not exists:
                failures.append(f"icon file missing: {icon_url}")
        print("manifest icons:", [i.get('src') for i in manifest.get('icons', [])])

        # service worker registration
        sw_registered = False
        for _ in range(50):
            sw_registered = page.evaluate("() => navigator.serviceWorker && navigator.serviceWorker.controller !== null")
            if sw_registered:
                break
            page.wait_for_timeout(200)
        # also check registration exists even if not controlling yet
        reg_exists = page.evaluate("() => navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then(r => !!r) : Promise.resolve(false)")
        print("sw controller:", sw_registered, "registration exists:", reg_exists)
        if not (sw_registered or reg_exists):
            failures.append("service worker not registered")

        # offline: context.set_offline, calculation works
        context.set_offline(True)
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(1000)
        # add a person and item offline
        page.fill("#personName", "Анна")
        page.click("#personForm button[type=submit]")
        page.wait_for_timeout(200)
        page.fill("#itemName", "Пицца")
        page.fill("#itemAmount", "100")
        page.click("#itemSubmit")
        page.wait_for_timeout(300)
        total = page.inner_text("#grandTotal")
        print("offline grandTotal:", total)
        if "100" not in total:
            failures.append(f"offline calculation failed: {total}")
        context.set_offline(False)
        context.close()
    finally:
        browser.close()

server.shutdown()

if console_errors:
    print("CONSOLE ERRORS:")
    for err in console_errors:
        print("  " + err)
    # sw registration may log; only fail on pageerror or unexpected
    if any("pageerror" in e for e in console_errors):
        failures.append("page errors present")

if failures:
    print(f"\nRESULT: {len(failures)} failure(s): {failures}")
    sys.exit(1)
else:
    print("\nRESULT: all checks passed")
