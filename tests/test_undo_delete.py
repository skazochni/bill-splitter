"""Регрессия: удаление позиций/участников с уведомлением «Удалено. Отменить» и откатом."""
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


def norm(text):
    if isinstance(text, list):
        return [norm(item) for item in text]
    return str(text).replace("\u00a0", " ").replace("\u202f", " ").strip()


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


def add_person_and_item(page):
    page.fill("#personName", "Анна")
    page.click("#personForm button[type=submit]")
    page.wait_for_timeout(200)
    page.fill("#itemName", "Пицца")
    page.fill("#itemAmount", "100")
    page.click("#itemSubmit")
    page.wait_for_timeout(300)


server, url = start_server()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        # A. удаление позиции -> уведомление -> отмена -> итог восстанавливается
        context, page = new_page(browser, url)
        add_person_and_item(page)
        check("undo: итог до удаления позиции", page.inner_text("#grandTotal"), "100,00 ₽")

        page.locator(".item-delete").first.click()
        page.wait_for_timeout(300)
        check("undo: уведомление об удалении позиции видно", page.locator("#itemUndo").is_visible(), True)
        check("undo: итог после удаления", page.inner_text("#grandTotal"), "0,00 ₽")

        page.locator("#itemUndoCancel").click()
        page.wait_for_timeout(300)
        check("undo: позиция восстановлена", page.locator("#itemsList .item").count(), 1)
        check("undo: итог после отката совпадает с исходным", page.inner_text("#grandTotal"), "100,00 ₽")
        context.close()

        # B. удаление участника -> уведомление -> отмена -> участник и сумма на месте
        context, page = new_page(browser, url)
        add_person_and_item(page)
        check("undo: участник добавлен", page.locator("#peopleList .chip", has_text="Анна").count(), 1)
        check("undo: позиция добавлена", page.locator("#itemsList .item").count(), 1)

        page.locator("#peopleList .chip", has_text="Анна").locator(".chip-remove").click()
        page.wait_for_timeout(300)
        check("undo: уведомление об удалении участника видно", page.locator("#personUndo").is_visible(), True)
        check("undo: позиция без участников исключена", page.locator("#itemsExcluded").is_visible(), True)

        page.locator("#personUndoCancel").click()
        page.wait_for_timeout(300)
        check("undo: участник восстановлен", page.locator("#peopleList .chip", has_text="Анна").count(), 1)
        check("undo: позиция снова участвует", page.locator("#itemsExcluded").is_hidden(), True)
        check("undo: итог после отката совпадает с исходным", page.inner_text("#grandTotal"), "100,00 ₽")
        context.close()

        # C. после истечения окна undo недоступен
        context, page = new_page(browser, url)
        add_person_and_item(page)
        page.locator(".item-delete").first.click()
        page.wait_for_timeout(300)
        check("undo: уведомление видно до истечения окна", page.locator("#itemUndo").is_visible(), True)
        page.wait_for_timeout(6500)
        check("undo: уведомление скрыто после окна", page.locator("#itemUndo").is_hidden(), True)
        check("undo: кнопка отмены скрыта после окна", page.locator("#itemUndoCancel").is_hidden(), True)
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
