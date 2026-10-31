"""Регрессия: старые сохранения с валютами вне списка (GBP, JPY) приводятся к RUB.

Запуск из корня проекта:
    .venv\\Scripts\\python.exe tests\\test_legacy_currency_conversion.py
"""
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
STORAGE_KEY = "billSplitter.v1"
failures = []

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def norm(text):
    return " ".join(str(text).split())


def check(label, actual, expected):
    global failures
    a, e = norm(actual), norm(expected)
    if a != e:
        failures.append(f"{label}: got {a!r}, want {e!r}")
        print(f"FAIL {label}: got {a!r}, want {e!r}")
    else:
        print(f"PASS {label}")


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/index.html"

    state = {
        "version": 1,
        "mode": "itemized",
        "currency": "JPY",
        "taxPct": 0,
        "tipPct": 0,
        "tipMode": "percent",
        "tipAmount": 0,
        "discountPct": 0,
        "equalTotal": 0,
        "equalPayerId": None,
        "lastItemPayerId": "p1",
        "people": [{"id": "p1", "name": "Анна"}, {"id": "p2", "name": "Борис"}],
        "items": [{"id": "i1", "name": "Пицца", "amount": 1000, "payerId": "p1", "sharedBy": ["p1", "p2"]}],
    }

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context()
        page = context.new_page()
        page.add_init_script(f"localStorage.setItem({json.dumps(STORAGE_KEY)}, {json.dumps(json.dumps(state))});")
        page.goto(url)
        page.wait_for_load_state("networkidle")

        check("legacy: currency becomes RUB", page.input_value("#currencySelect"), "RUB")
        check("legacy: grand total scaled", page.locator("#grandTotal").inner_text(), "1 000,00 ₽")

        context.close()
        browser.close()

    httpd.shutdown()
    if failures:
        print("\nFAILED:", ", ".join(failures))
        sys.exit(1)
    print("\nAll legacy currency checks passed.")


if __name__ == "__main__":
    main()