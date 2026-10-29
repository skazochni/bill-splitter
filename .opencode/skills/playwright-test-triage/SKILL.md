---
name: playwright-test-triage
description: Run and debug the Bill Splitter Playwright regression scripts in tests/. Use when asked to run all tests, interpret PASS/FAIL output, triage a failing browser test, check Playwright/browser setup in .venv, or distinguish an app regression from a broken test or environment problem.
metadata:
  origin: project
---

# Bill Splitter Playwright Test Triage

Run the existing regression scripts, read their output, and decide whether a failure belongs to the app, the test code, or the local Playwright setup.

## When to use

- The user asks to run one or all browser regression tests.
- A `tests\*.py` script fails or hangs and the cause is unclear.
- Playwright reports a missing browser executable, channel, or dependency.
- You need to state whether a change broke behavior, before touching `app.js`.

For writing new UI checks or manually exercising the page, use `ui-playwright-testing` instead; this skill covers running and diagnosing.

## Prerequisites

- Tests are plain Python scripts: no pytest, no `package.json`, no build step.
- Interpreter and Playwright come from `.venv`; run from the repository root.
- Each script starts its own `ThreadingHTTPServer` on port `0` (ephemeral) and serves the repo root, so no manual server is needed and parallel runs do not collide on ports.
- Scripts try `chromium` with `channel="msedge"` first and fall back to bundled `chromium`.
- Every script prints `PASS`/`FAIL` lines, exits with code `1` on any failure, and prints a final summary.

## Workflow

1. Run the narrowest relevant script, or all four when the request is a general regression run. Prefer sequential runs: several headless browsers at once make timing-sensitive waits flakier.
2. Read the exit code plus the `FAIL` lines. Each failure prints `got: ... | want: ...`, which is usually enough to classify the cause.
3. Classify before fixing (see triage table). Fix test or environment problems directly; change application code only when the test demonstrates a real defect and the user asked for a fix.
4. Re-run the failed script, then the other scripts touched by the same area of code.
5. Report the exact commands, per-script pass/fail counts, and any file you edited.

```powershell
.\.venv\Scripts\python.exe tests\test_equal_mode_no_people.py
.\.venv\Scripts\python.exe tests\test_mvp_scenarios.py
.\.venv\Scripts\python.exe tests\test_summary_export.py
.\.venv\Scripts\python.exe tests\test_currency_and_item_rounding.py
```

## Test map

| Script | Covers |
| --- | --- |
| `test_equal_mode_no_people.py` | Equal mode with zero participants, persistence of the reset, old saved drafts |
| `test_mvp_scenarios.py` | Demo bill, equal split, per-item payers, discounts, validation, mobile layout, history |
| `test_summary_export.py` | Clipboard summary, print/PDF fallback, print layout |
| `test_currency_and_item_rounding.py` | Currency precision, item remainder allocation, payer reassignment |

## Triage table

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `BrowserType.launch: Executable doesn't exist ... ms-playwright\...` | Browsers never installed for this Playwright version | `.\.venv\Scripts\python.exe -m playwright install` (retry on `ECONNRESET`, the download resumes) |
| `AttributeError`/`TypeError` on a `Locator` method | Test written against a different Playwright API than installed | Check `pip show playwright`, replace with a supported call. Python has `all_inner_texts`/`all_text_contents` but **no** `all_input_values`; read input values with `evaluate_all("els => els.map(e => e.value)")` |
| `FAIL ... got: X | want: Y` for amounts, totals, or labels | Possible app regression | Reproduce in the browser, compare with `AGENTS.md` rules, then fix `app.js` only if requested |
| `FAIL ... no browser errors` with console text printed below | JS exception in the app | Fix the app; do not silence the check |
| Timeout waiting for a dialog or element | Missing `page.once("dialog", ...)` handler, or assertion ran before the 250 ms debounced save | Add the handler or wait for the observable state, never a fixed long sleep |
| `SyntaxError`/`UnicodeDecodeError` on a test file | File re-saved in the wrong encoding | Keep `tests/*.py` UTF-8 without BOM |
| Russian text looks garbled in console output | Terminal code page, not the file | Ignore; scripts already call `sys.stdout.reconfigure(encoding="utf-8")` |

## Rules

- Never delete or weaken a `check(...)` assertion to make a run green. A test bug may be fixed while keeping the same expected value.
- No app change for a test-only request unless the failure proves a real defect.
- Do not add pytest, dependencies, or a build tool. Keep the scripts self-contained.
- Do not start a second HTTP server; the scripts own their servers.
- Keep dialog handlers in place for `#resetBtn`, `#restore...`, and history deletion, otherwise the run hangs.
- Treat `localStorage` as shared state between scenarios: reset it when a scenario needs an empty bill.

## Project notes

- Amounts are formatted with non-breaking spaces; compare through the scripts' `norm()` helper, not raw text.
- `billSplitter.v1` holds the draft, `billSplitter.history.v1` holds history; stale drafts are sanitized on load.
- Save is debounced 250 ms, so reload checks must wait for `networkidle` or the visible result.
- Print tests only assert that printing was invoked or a fallback message appeared; a native dialog is not expected in headless runs.

## Validation

- All four scripts exit with code `0` and print their final success line.
- Each run's `FAILED`/`Все проверки` summary is quoted in the report.
- Any edited test file still asserts the original expected values.
- If the environment blocked execution, say so explicitly instead of claiming the UI was verified.
