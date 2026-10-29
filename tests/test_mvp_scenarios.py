"""Основные пользовательские сценарии MVP: поровну, разные доли и один плательщик."""
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
    if isinstance(text, list):
        return [norm(item) for item in text]
    return re.sub(r"[\s\u00a0\u202f]+", " ", str(text)).strip()


def check(label, actual, expected):
    ok = norm(actual) == norm(expected)
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f" | got: {actual!r} | want: {expected!r}"))
    if not ok:
        failures.append(label)


def contains(label, haystack, needle):
    ok = norm(needle) in norm(haystack)
    print(("PASS " if ok else "FAIL ") + label +
          ("" if ok else f" | got: {haystack!r} | want contains: {needle!r}"))
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


def add_people(page, names):
    for name in names:
        page.fill("#personName", name)
        page.click("#personForm button[type=submit]")


def add_item(page, name, amount):
    page.fill("#itemName", name)
    page.fill("#itemAmount", amount)
    page.click("#itemSubmit")


server, url = start_server()

with sync_playwright() as playwright:
    try:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
    except Error:
        browser = playwright.chromium.launch(headless=True)

    # Demo bill is available only for an empty draft and adapts to the selected currency.
    context, page = new_page(browser, url)
    check("demo: offered on an empty draft", page.is_visible("#demoCallout"), True)
    page.select_option("#currencySelect", "JPY")
    page.click("#loadDemoBtn")
    check("demo: adds participants", page.locator("#peopleList .chip-name").all_inner_texts(),
          ["Анна", "Борис", "Вера"])
    check("demo: adds multiple items", page.locator("#itemsList .item").count(), 3)
    check("demo: assigns different item payers",
          page.locator("#itemsList .item-payer option:checked").all_inner_texts(),
          ["Анна", "Борис", "Вера"])
    check("demo: includes selected participants per item",
          page.locator("#itemsList .item").nth(1)
              .locator(".person-toggle[aria-pressed='true']").all_inner_texts(),
          ["Борис", "Вера"])
    check("demo: preserves selected currency", page.input_value("#currencySelect"), "JPY")
    check("demo: uses selected currency precision", page.inner_text("#itemSubtotal"), "2 300 ¥")
    check("demo: calculates sample bill", page.inner_text("#grandTotal"), "2 623 ¥")
    check("demo: demonstrates percentage settings",
          [page.input_value("#discountInput"), page.input_value("#taxInput"), page.input_value("#tipInput")],
          ["5", "10", "10"])
    check("demo: announces successful loading", page.inner_text("#demoStatus"),
          "Пример загружен. Участников, позиции и суммы можно изменить.")
    check("demo: callout hides once the draft is populated", page.is_hidden("#demoCallout"), True)
    page.reload()
    page.wait_for_load_state("networkidle")
    check("demo: sample persists after reload", page.locator("#itemsList .item").count(), 3)
    check("demo: hidden after reload", page.is_hidden("#demoCallout"), True)
    page.once("dialog", lambda dialog: dialog.accept())
    page.click("#resetBtn")
    check("demo: reset clears success announcement", page.inner_text("#demoStatus"), "")
    check("demo: reset restores the empty-draft offer", page.is_visible("#demoCallout"), True)
    context.close()

    context, page = new_page(browser, url)
    add_people(page, ["Уже добавленный участник"])
    add_item(page, "Уже добавленная позиция", "123")
    check("demo: hidden for a non-empty draft", page.is_hidden("#demoCallout"), True)
    page.evaluate("document.getElementById('loadDemoBtn').click()")
    check("demo: cannot overwrite existing participants",
          page.locator("#peopleList .chip-name").all_inner_texts(), ["Уже добавленный участник"])
    check("demo: cannot overwrite existing items",
          page.locator("#itemsList .item-name").evaluate_all(
              "elements => elements.map(element => element.value)"), ["Уже добавленная позиция"])
    check("demo: existing total stays unchanged", page.inner_text("#grandTotal"), "123,00 ₽")
    context.close()

    # Equal split handles remainder cents deterministically.
    context, page = new_page(browser, url)
    add_people(page, ["Анна", "Борис", "Вера"])
    page.click("#tab-equal")
    page.fill("#equalTotal", "1000")
    check("equal: total", page.inner_text("#grandTotal"), "1 000,00 ₽")
    check("equal: per-person shares", page.locator("#summaryRows .sum-person-owed").all_inner_texts(),
          ["333,34 ₽", "333,33 ₽", "333,33 ₽"])
    check("equal: transfers", page.locator("#settleList").inner_text(),
          "Борис → Анна\n333,33 ₽\nВера → Анна\n333,33 ₽")
    context.close()

    # Items can have different participant sets and different payers.
    context, page = new_page(browser, url)
    add_people(page, ["Анна", "Борис", "Вера"])
    add_item(page, "Ужин", "900")
    page.locator("#itemsList .item").last.locator(".item-payer").select_option(label="Анна")
    page.locator("#itemsList .item").last.locator(".person-toggle", has_text="Вера").click()
    add_item(page, "Напитки", "300")
    page.locator("#itemsList .item").last.locator(".item-payer").select_option(label="Борис")
    check("items: total", page.inner_text("#grandTotal"), "1 200,00 ₽")
    check("items: owed by participant", page.locator("#summaryRows .sum-person-owed").all_inner_texts(),
          ["550,00 ₽", "550,00 ₽", "100,00 ₽"])
    check("items: paid by participant", page.locator("#summaryRows .sum-paid").all_inner_texts(),
          ["Оплачено 900,00 ₽", "Оплачено 300,00 ₽", "Оплачено 0,00 ₽"])
    check("items: transfers", page.locator("#settleList").inner_text(),
          "Борис → Анна\n250,00 ₽\nВера → Анна\n100,00 ₽")
    context.close()

    # One person can pay the whole shared bill and receive two settlements.
    context, page = new_page(browser, url)
    add_people(page, ["Анна", "Борис", "Вера"])
    add_item(page, "Общий счёт", "1200")
    check("single payer: totals owed", page.locator("#summaryRows .sum-person-owed").all_inner_texts(),
          ["400,00 ₽", "400,00 ₽", "400,00 ₽"])
    check("single payer: paid total", page.locator("#summaryRows .sum-paid").all_inner_texts(),
          ["Оплачено 1 200,00 ₽", "Оплачено 0,00 ₽", "Оплачено 0,00 ₽"])
    check("single payer: transfers", page.locator("#settleList").inner_text(),
          "Борис → Анна\n400,00 ₽\nВера → Анна\n400,00 ₽")
    context.close()

    # Discounts are allocated across items and applied before tax and tip.
    context, page = new_page(browser, url)
    add_people(page, ["Анна", "Борис"])
    add_item(page, "Ужин", "1000")
    add_item(page, "Напитки", "500")
    page.locator("#itemsList .item").last.locator(".person-toggle", has_text="Борис").click()
    page.fill("#discountInput", "10")
    page.fill("#taxInput", "10")
    page.fill("#tipInput", "5")
    check("discount: grand total after tax and tip", page.inner_text("#grandTotal"), "1 552,50 ₽")
    check("discount: summary includes deduction", page.inner_text("#summaryTotals"),
          "Позиции\n1 500,00 ₽\nСкидка · 10%\n-150,00 ₽\nНалог · 10%\n135,00 ₽\nЧаевые · 5%\n67,50 ₽\nВсего\n1 552,50 ₽")
    check("discount: amount owed by participants",
          page.locator("#summaryRows .sum-person-owed").all_inner_texts(), ["1 035,00 ₽", "517,50 ₽"])
    contains("discount: per-person breakdown mentions discount",
             page.locator("#summaryRows").inner_text(), "скидка −100,00 ₽")
    check("discount: payer's paid amount is net", page.locator("#summaryRows .sum-paid").all_inner_texts(),
          ["Оплачено 1 552,50 ₽", "Оплачено 0,00 ₽"])
    check("discount: settlement uses discounted total", page.inner_text("#settleList"),
          "Борис → Анна\n517,50 ₽")
    page.reload()
    page.wait_for_load_state("networkidle")
    check("discount: percentage persists", page.input_value("#discountInput"), "10")
    check("discount: total persists", page.inner_text("#grandTotal"), "1 552,50 ₽")
    page.fill("#discountInput", "101")
    check("discount: values above 100 are rejected",
          page.locator("#discountInput").get_attribute("aria-invalid"), "true")
    check("discount: invalid percentage does not change calculation",
          page.inner_text("#grandTotal"), "1 552,50 ₽")
    page.locator("#discountInput").blur()
    check("discount: invalid percentage resets to last valid value",
          page.input_value("#discountInput"), "10")
    page.fill("#discountInput", "100")
    check("discount: full discount reduces tax and tip bases to zero", page.inner_text("#grandTotal"), "0,00 ₽")
    check("discount: full discount creates no transfers", page.locator("#settleEmpty").inner_text(),
          "Все в расчёте — переводы не нужны.")
    context.close()

    # Invalid amounts are rejected without creating an item; mobile layout stays usable.
    context, page = new_page(browser, url)
    add_people(page, ["Анна"])
    page.fill("#itemName", "Пустая позиция")
    page.fill("#itemAmount", "0")
    page.click("#itemSubmit")
    check("validation: zero item amount is rejected", page.inner_text("#itemError"), "Введите сумму больше нуля.")
    check("validation: rejected item is not added", page.locator("#itemsList .item").count(), 0)
    check("validation: invalid field is marked", page.locator("#itemAmount").get_attribute("aria-invalid"), "true")
    check("validation: error is linked to invalid field",
          page.locator("#itemAmount").get_attribute("aria-describedby"), "itemError")
    page.set_viewport_size({"width": 375, "height": 812})
    no_horizontal_overflow = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    check("mobile: no horizontal overflow", no_horizontal_overflow, True)
    check("mobile: sticky total is visible", page.is_visible("#mobileTotal"), True)
    check("mobile: sticky total matches summary", page.inner_text("#mobileTotalAmount"),
          page.inner_text("#grandTotal"))
    page.click("#mobileTotal")
    page.wait_for_timeout(1000)
    summary_visible = page.evaluate(
        "document.querySelector('.summary-card').getBoundingClientRect().top < window.innerHeight"
    )
    check("mobile: sticky total jumps to summary", summary_visible, True)
    context.close()

    # Saved history is independent from the current draft and can restore or delete snapshots.
    context, page = new_page(browser, url)
    add_people(page, ["Анна", "Борис"])
    page.click("#tab-equal")
    page.fill("#equalTotal", "100")
    page.click("#historyBtn")
    page.fill("#historyName", "Обед")
    page.click("#historySave")
    check("history: saved count", page.inner_text("#historyCount"), "1")
    contains("history: saved title", page.inner_text("#historyList"), "Обед")
    contains("history: saved amount", page.inner_text("#historyList"), "100,00 ₽")
    page.reload()
    page.wait_for_load_state("networkidle")
    check("history: survives reload", page.inner_text("#historyCount"), "1")
    page.click("#historyBtn")
    page.click("#historyClose")
    page.fill("#equalTotal", "200")
    page.click("#historyBtn")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.locator("[data-history-open]").click()
    check("history: cancelled restore preserves current amount", page.inner_text("#grandTotal"), "200,00 ₽")
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("[data-history-open]").click()
    check("history: restores saved amount", page.inner_text("#grandTotal"), "100,00 ₽")
    page.click("#historyBtn")
    page.locator("[data-history-delete]").click()
    check("history: deletion updates count", page.inner_text("#historyCount"), "0")
    check("history: empty message shown", page.is_visible("#historyEmpty"), True)
    page.set_viewport_size({"width": 320, "height": 700})
    check("history: mobile layout has no horizontal overflow",
          page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), True)
    context.close()

    browser.close()

server.shutdown()

check("no browser errors", console_errors, [])
if console_errors:
    print("\n".join(console_errors))

if failures:
    print(f"\nFAILED: {len(failures)}")
    for failure in failures:
        print(" - " + failure)
    sys.exit(1)
print("\nAll MVP scenario checks passed.")
