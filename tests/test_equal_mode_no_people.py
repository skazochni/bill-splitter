"""Регрессия: режим «Поровну» без участников.

Проверяет, что сумма счёта не показывается как итог, если участников нет:
удаление последнего участника очищает черновик суммы, состояние сохраняется,
перезагрузка и повторное добавление участника остаются согласованными.
Заодно проверяется, что режим «По позициям» работает как прежде.

Запуск из корня проекта:
    .venv\\Scripts\\python.exe tests\\test_equal_mode_no_people.py

Скрипт сам поднимает статический сервер на свободном порту и требует
установленный Playwright (см. skill webapp-testing).
"""
import functools
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Error, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
STORAGE_KEY = "billSplitter.v1"
failures = []

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def norm(text):
    return re.sub(r"[\s\u00a0\u202f]+", " ", str(text)).strip()


def check(label, actual, expected):
    ok = norm(actual) == norm(expected)
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f"  | got: {actual!r}  want: {expected!r}"))
    if not ok:
        failures.append(label)


def contains(label, haystack, needle):
    ok = norm(needle) in norm(haystack)
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f"  | got: {haystack!r}  want contains: {needle!r}"))
    if not ok:
        failures.append(label)


def start_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html"


def new_page(browser, url, console_errors):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ru-RU")
    page = context.new_page()
    page.on("console", lambda m: console_errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
    page.goto(url)
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_load_state("networkidle")
    return context, page


def add_person(page, name):
    page.fill("#personName", name)
    page.click("#personForm button[type=submit]")


def add_item(page, name, amount):
    page.fill("#itemName", name)
    page.fill("#itemAmount", amount)
    page.click("#itemSubmit")


def delete_person(page, name):
    page.once("dialog", lambda d: d.accept())
    page.locator("#peopleList .chip", has_text=name).locator(".chip-remove").click()
    page.wait_for_timeout(100)


def stored_state(page):
    return page.evaluate(f"JSON.parse(localStorage.getItem('{STORAGE_KEY}'))")


server, url = start_server()
console_errors = []

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="msedge", headless=True)
    except Error:
        browser = p.chromium.launch(headless=True)

    # ---------- A. первый запуск и порядок действий ----------
    context, page = new_page(browser, url, console_errors)
    check("A: пустая сводка просит добавить участников", page.inner_text("#summaryEmpty"), "Добавьте участников, чтобы увидеть, кто сколько платит.")
    check("A: позиция объясняет первый шаг", page.inner_text("#itemsEmptyDescription"), "Сначала добавьте участников выше. Затем добавьте первую позицию и отметьте, кто её делит.")
    check("A: добавление позиции недоступно без участников", page.is_disabled("#itemSubmit"), True)
    add_person(page, "Анна")
    check("A: пустая позиция обновляет подсказку после добавления участника", page.inner_text("#itemsEmptyDescription"), "Добавьте первую позицию — например, «Пицца» — и отметьте, кто её делит.")
    context.close()

    # ---------- B. удаление последнего участника в режиме «Поровну» ----------
    context, page = new_page(browser, url, console_errors)
    add_person(page, "Анна")
    page.click("#tab-equal")
    page.fill("#equalTotal", "1000")
    page.locator("#equalTotal").press("Tab")
    check("B: сумма введена и отображается", page.input_value("#equalTotal"), "1000,00")
    check("B: итог до удаления", page.inner_text("#grandTotal"), "1 000,00 ₽")

    delete_person(page, "Анна")
    check("B: участников не осталось", page.inner_text("#peopleCount"), "0")
    check("B: итог при нуле участников", page.inner_text("#grandTotal"), "0,00 ₽")
    check("B: поле суммы очищено", page.input_value("#equalTotal"), "")
    check("B: поле суммы заблокировано", page.is_disabled("#equalTotal"), True)
    check("B: подпись итога", page.inner_text("#grandSub"), "Добавьте участников")
    check("B: объяснение в панели", page.inner_text("#equalNote"), "Сначала добавьте участников — затем сумму счёта.")
    check("B: пустой список участников в сводке", page.is_visible("#summaryEmpty"), True)
    check("B: блок переводов скрыт", page.is_visible("#settleBlock"), False)
    check("B: сумма в localStorage очищена", stored_state(page)["equalTotal"], 0)

    # ---------- C. перезагрузка после удаления ----------
    page.reload()
    page.wait_for_load_state("networkidle")
    check("C: режим «Поровну» сохранился", page.is_visible("#equalPanel"), True)
    check("C: итог после перезагрузки", page.inner_text("#grandTotal"), "0,00 ₽")
    check("C: поле суммы после перезагрузки", page.input_value("#equalTotal"), "")
    check("C: поле суммы по-прежнему заблокировано", page.is_disabled("#equalTotal"), True)
    check("C: объяснение после перезагрузки", page.inner_text("#equalNote"), "Сначала добавьте участников — затем сумму счёта.")

    # ---------- D. повторное добавление участника ----------
    add_person(page, "Борис")
    check("D: поле суммы разблокировано", page.is_disabled("#equalTotal"), False)
    check("D: сумма осталась очищенной", page.input_value("#equalTotal"), "")
    check("D: итог после добавления участника", page.inner_text("#grandTotal"), "0,00 ₽")
    check("D: подсказка про ввод суммы", page.inner_text("#equalNote"), "Укажите сумму счёта, чтобы увидеть доли.")
    check("D: сохранённая сумма нулевая", stored_state(page)["equalTotal"], 0)

    page.fill("#equalTotal", "500")
    check("D: новая сумма применяется", page.inner_text("#grandTotal"), "500,00 ₽")
    check("D: доля на одного участника", page.inner_text("#equalNote"), "1 участник · по 500,00 ₽")
    page.reload()
    page.wait_for_load_state("networkidle")
    check("D: сумма сохранилась после перезагрузки", page.inner_text("#grandTotal"), "500,00 ₽")
    check("D: поле после перезагрузки", page.input_value("#equalTotal"), "500,00")
    context.close()

    # ---------- E. старое сохранение с суммой, но без участников ----------
    context, page = new_page(browser, url, console_errors)
    page.evaluate(
        f"""localStorage.setItem('{STORAGE_KEY}', JSON.stringify({{
            version: 1, mode: 'equal', currency: 'RUB', people: [], items: [],
            taxPct: 0, tipPct: 0, equalTotal: 500000, equalPayerId: null, lastItemPayerId: null
        }}))"""
    )
    page.reload()
    page.wait_for_load_state("networkidle")
    check("E: старый черновик не показывается как итог", page.inner_text("#grandTotal"), "0,00 ₽")
    check("E: поле суммы пустое", page.input_value("#equalTotal"), "")
    check("E: поле суммы заблокировано", page.is_disabled("#equalTotal"), True)
    check("E: объяснение показано", page.inner_text("#equalNote"), "Сначала добавьте участников — затем сумму счёта.")
    context.close()

    # ---------- F. режим «По позициям» не изменился ----------
    context, page = new_page(browser, url, console_errors)
    add_person(page, "Анна")
    add_person(page, "Борис")
    add_item(page, "Пицца", "900")
    page.fill("#taxInput", "10")
    check("F: подытог позиций", page.inner_text("#itemSubtotal"), "900,00 ₽")
    check("F: итог с налогом", page.inner_text("#grandTotal"), "990,00 ₽")
    check("F: равная доля каждого", page.locator("#summaryRows .sum-person-owed").nth(0).inner_text(), "495,00 ₽")
    check("F: второму участнику начислена такая же доля", page.locator("#summaryRows .sum-person-owed").nth(1).inner_text(), "495,00 ₽")
    contains("F: перевод для сведения", page.inner_text("#settleList"), "Борис → Анна")
    contains("F: сумма перевода", page.inner_text("#settleList"), "495,00 ₽")
    page.locator("#itemsList .item").first.locator(".person-toggle", has_text="Анна").click()
    check("F: позиция на одного участника", page.locator(".item-note").first.inner_text(), "1 участник · вся сумма")
    check("F: итог не изменился", page.inner_text("#grandTotal"), "990,00 ₽")

    # сумма «поровну» не влияет на позиции
    page.click("#tab-equal")
    page.fill("#equalTotal", "1000")
    page.click("#tab-itemized")
    check("F: позиции после черновика «поровну»", page.inner_text("#grandTotal"), "990,00 ₽")

    page.click("#tab-equal")
    delete_person(page, "Анна")
    check("F: остался один участник", page.inner_text("#peopleCount"), "1")
    check("F: черновик «поровну» сохранён при живом участнике", page.inner_text("#grandTotal"), "1 000,00 ₽")
    page.click("#tab-itemized")
    check("F: позиции после удаления участника", page.inner_text("#grandTotal"), "990,00 ₽")

    delete_person(page, "Борис")
    check("F: позиции при нуле участников", page.inner_text("#grandTotal"), "0,00 ₽")
    check("F: черновик очищен и в режиме позиций", stored_state(page)["equalTotal"], 0)
    page.click("#tab-equal")
    check("F: «Поровну» при нуле участников", page.inner_text("#grandTotal"), "0,00 ₽")
    check("F: поле суммы пустое", page.input_value("#equalTotal"), "")
    context.close()

    browser.close()

server.shutdown()

check("без ошибок в консоли", len(console_errors), 0)
if console_errors:
    print("\n".join(console_errors))

print()
if failures:
    print(f"ПРОВАЛЕНО: {len(failures)}")
    for name in failures:
        print(" - " + name)
    sys.exit(1)
print("Все проверки регрессии пройдены.")
