"""Регрессия: добавление участника не захватывает исключённые позиции; единое правило исключения."""
import functools
import json
import re
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


def norm(text):
    if isinstance(text, list):
        return [norm(item) for item in text]
    return re.sub(r"[\s\u00a0\u202f]+", " ", str(text)).strip()


def check(label, actual, expected):
    ok = norm(actual) == norm(expected)
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f" | got: {actual!r} | want: {expected!r}"))
    if not ok:
        failures.append(label)


def start_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html"


def new_page(browser, url):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ru-RU")
    page = context.new_page()
    page.on("console", lambda message: console_errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(f"pageerror: {error}"))
    page.goto(url)
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_load_state("networkidle")
    return context, page


server, url = start_server()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel="msedge") if False else playwright.chromium.launch(headless=True)
    try:
        # A. добавление первого участника не меняет sharedBy пустых позиций
        context, page = new_page(browser, url)
        state = {
            "version": 1, "mode": "itemized", "currency": "RUB", "people": [], "items": [
                {"id": "i1", "name": "Пицца", "amount": 10000, "payerId": None, "sharedBy": []}
            ],
            "taxPct": 0, "tipPct": 0, "discountPct": 0, "equalTotal": 0,
            "equalPayerId": None, "lastItemPayerId": None
        }
        page.evaluate("localStorage.setItem('billSplitter.v1', " + json.dumps(json.dumps(state)) + ")")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.fill("#personName", "Анна")
        page.click("#personForm button[type=submit]")
        page.wait_for_timeout(200)
        check("A: позиция остаётся исключённой", page.locator("#itemsExcluded").is_visible(), True)
        check("A: итог не включает исключённую позицию", page.inner_text("#grandTotal"), "0,00 ₽")
        context.close()

        # B. исключение определяется только отсутствием участников
        context, page = new_page(browser, url)
        page.fill("#personName", "Анна")
        page.click("#personForm button[type=submit]")
        page.fill("#itemName", "Пицца")
        page.fill("#itemAmount", "100")
        page.click("#itemSubmit")
        page.wait_for_timeout(200)
        # снять участника -> позиция исключена
        page.locator(".person-toggle").first.click()
        page.wait_for_timeout(200)
        check("B: пустой sharedBy -> предупреждение", page.locator("#itemsExcluded").is_visible(), True)
        # вернуть участника при нулевой сумме -> не считается исключённой
        page.locator(".person-toggle").first.click()
        page.wait_for_timeout(100)
        field = page.locator(".item-money input").first
        field.fill("")
        field.dispatch_event("input")
        page.wait_for_timeout(200)
        check("B: с участниками даже при 0 не исключена", page.locator("#itemsExcluded").is_hidden(), True)
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
