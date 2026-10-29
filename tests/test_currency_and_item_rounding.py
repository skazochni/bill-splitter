"""Проверка точного распределения суммы и поведения выбора валюты."""
import functools
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Error, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
failures = []

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


handler = functools.partial(QuietHandler, directory=str(ROOT))
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/index.html"

with sync_playwright() as playwright:
    try:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
    except Error:
        browser = playwright.chromium.launch(headless=True)

    context = browser.new_context(locale="ru-RU")
    page = context.new_page()
    page.goto(url)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_load_state("networkidle")

    for name in ["Анна", "Борис", "Вера"]:
        page.fill("#personName", name)
        page.click("#personForm button[type=submit]")
    page.fill("#itemName", "Общий десерт")
    page.fill("#itemAmount", "10")
    page.click("#itemSubmit")
    check("item rounding: remainder is assigned deterministically",
          page.locator("#summaryRows .sum-person-owed").all_inner_texts(),
          ["3,34 ₽", "3,33 ₽", "3,33 ₽"])

    page.locator("#itemsList .item .item-payer").select_option(label="Борис")
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#peopleList .chip", has_text="Борис").locator(".chip-remove").click()
    check("payer removal: remaining participant is reassigned as payer",
          page.locator("#summaryRows .sum-paid").all_inner_texts(),
          ["Оплачено 10,00 ₽", "Оплачено 0,00 ₽"])
    check("payer removal: removed participant is excluded",
          page.locator("#summaryRows .sum-person-name .name").all_inner_texts(),
          ["Анна", "Вера"])

    page.click("#tab-equal")
    page.fill("#equalTotal", "1050,25")
    page.locator("#currencySelect").select_option("USD")
    check("currency: rate warning is visible",
          page.locator("#currencyNote").inner_text(), "Курс не применяется при смене валюты")
    check("currency: same precision keeps entered numeric amount",
          page.locator("#grandTotal").inner_text(), "1 050,25 $")
    page.locator("#currencySelect").select_option("JPY")
    check("currency: zero-decimal currency rounds to whole units",
          page.locator("#grandTotal").inner_text(), "1 050 ¥")

    context.close()
    browser.close()

server.shutdown()

if failures:
    print("\nFAILED:", ", ".join(failures))
    sys.exit(1)

print("\nAll currency and rounding checks passed.")
