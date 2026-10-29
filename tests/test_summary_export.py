"""Проверка копирования расчёта и печатного вида сводки."""
import functools
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Error, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
failures = []
console_errors = []

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def norm(text):
    return re.sub(r"[\s\u00a0\u202f]+", " ", str(text)).strip()


def check(label, actual, expected):
    ok = norm(actual) == norm(expected)
    print(("PASS " if ok else "FAIL ") + label +
          ("" if ok else f" | got: {actual!r} | want: {expected!r}"))
    if not ok:
        failures.append(label)


def contains(label, haystack, needle):
    ok = norm(needle) in norm(haystack)
    print(("PASS " if ok else "FAIL ") + label +
          ("" if ok else f" | got: {haystack!r} | want contains: {needle!r}"))
    if not ok:
        failures.append(label)


handler = functools.partial(QuietHandler, directory=str(ROOT))
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/index.html"

with sync_playwright() as playwright:
    try:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
    except Error:
        browser = playwright.chromium.launch(headless=True)

    context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ru-RU")
    context.grant_permissions(["clipboard-read", "clipboard-write"])
    page = context.new_page()
    page.on("console", lambda message: console_errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(f"pageerror: {error}"))
    page.goto(url)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_load_state("networkidle")
    check("export disabled without bill data", page.locator("#printSummary").is_disabled(), True)
    check("disabled export looks disabled", page.locator("#printSummary").evaluate(
        "(button) => getComputedStyle(button).cursor"), "not-allowed")
    check("disabled export explains required input", page.inner_text("#exportHelp"),
          "Добавьте участников и укажите сумму счёта, чтобы включить экспорт.")

    for name in ["Анна", "Борис"]:
        page.fill("#personName", name)
        page.click("#personForm button[type=submit]")
    page.click("#tab-equal")
    page.fill("#equalTotal", "1000")

    page.click("#copySummary")
    check("copy: confirmation", page.inner_text("#exportStatus"),
          "Расчёт скопирован — его можно отправить в чат.")
    copied_text = page.evaluate("navigator.clipboard.readText()")
    contains("copy: total", copied_text, "Итого: 1 000,00 ₽")
    contains("copy: participant amounts", copied_text, "Анна — к оплате 500,00 ₽, оплачено 1 000,00 ₽")
    contains("copy: transfer", copied_text, "Борис → Анна: 500,00 ₽")
    check("export enabled with bill data", page.locator("#printSummary").is_enabled(), True)
    check("enabled export hides prerequisite hint", page.locator("#exportHelp").is_hidden(), True)

    page.evaluate("window.__printCalled = false; window.print = () => { window.__printCalled = true; }")
    page.click("#printSummary")
    check("print button invokes browser print", page.evaluate("window.__printCalled"), True)
    check("print gives fallback instructions immediately", page.inner_text("#exportStatus"),
          "Если окно печати не появилось, нажмите Ctrl+P или откройте меню браузера и выберите «Печать».")
    page.evaluate("window.dispatchEvent(new Event('afterprint'))")
    check("print gives PDF instructions after dialog closes", page.inner_text("#exportStatus"),
          "Окно печати закрыто. Для PDF в нём выберите «Сохранить как PDF».")
    page.evaluate("window.print = undefined")
    page.click("#printSummary")
    check("print errors are reported", page.inner_text("#exportStatus"),
          "Печать не поддерживается этим браузером. Используйте Ctrl+P или меню браузера.")

    page.set_viewport_size({"width": 390, "height": 844})
    check("mobile: no horizontal overflow", page.evaluate("document.documentElement.scrollWidth"), 390)

    page.emulate_media(media="print")
    check("print: summary visible", page.locator(".summary-card").is_visible(), True)
    check("print: title visible", page.locator("#summaryTitle").is_visible(), True)
    check("print: inputs hidden", page.locator("#personName").is_visible(), False)
    check("print: export controls hidden", page.locator("#exportActions").is_visible(), False)
    page.emulate_media(media="screen")

    check("no browser errors", console_errors, [])
    context.close()
    browser.close()

server.shutdown()

if failures:
    print("\nFAILED:", ", ".join(failures))
    sys.exit(1)

print("\nAll summary export checks passed.")
