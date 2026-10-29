"""Регрессия: результат compute() совпадает с golden-снимком до рефакторинга."""
import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "compute_golden.json"

failures = []
console_errors = []

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def norm(text):
    return str(text).replace("\u00a0", " ").replace("\u202f", " ").strip()


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
golden = json.loads(GOLDEN.read_text(encoding="utf-8"))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for label, case in golden.items():
            context, page = new_page(browser, url)
            page.evaluate("localStorage.setItem('billSplitter.v1', " + json.dumps(json.dumps(case["input"])) + ")")
            page.reload()
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(200)
            actual = page.evaluate("window.BillCalc.compute()")
            if actual != case["result"]:
                failures.append(label)
                print(f"FAIL golden: {label}")
                print("  expected:", json.dumps(case["result"], ensure_ascii=False))
                print("  actual  :", json.dumps(actual, ensure_ascii=False))
            else:
                print(f"PASS golden: {label}")
            context.close()
    finally:
        browser.close()

server.shutdown()

if console_errors:
    print("CONSOLE ERRORS:")
    for err in console_errors:
        print("  " + err)
    failures.append("console errors present")

if failures:
    print(f"\nRESULT: {len(failures)} failure(s): {failures}")
    sys.exit(1)
else:
    print("\nRESULT: all checks passed")
