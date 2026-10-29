---
name: ui-playwright-testing
description: Test the Bill Splitter UI in a real browser with Playwright. Use when validating visible behavior, responsive layouts, accessibility interactions, copy/print flows, or regressions after UI or calculation changes.
metadata:
  origin: project
---

# Bill Splitter UI and Playwright Testing

Use this skill to verify user-visible behavior in the Bill Splitter browser app. Keep tests focused on changed behavior and preserve existing regression coverage.

## Project setup

- The app is a static SPA with no build step or package manifest.
- UI markup is in `index.html`, styling in `styles.css`, and application behavior in `app.js`.
- Browser tests are in `tests/` and use the project's `.venv` Playwright installation.
- Each test script starts its own local server; do not start a second server unless a test specifically requires it.
- Run commands from the repository root using Windows paths:

```powershell
.\.venv\Scripts\python.exe tests\test_summary_export.py
```

## Workflow

1. Read the relevant UI code and existing test(s) before changing or testing behavior.
2. Identify the user action, expected visible result, and relevant error or empty states.
3. Use the narrowest existing Playwright test that covers the change. Add or extend a test when a new user-visible branch is not already covered.
4. For a UI change without an applicable test, use Playwright to exercise the actual page. Check browser console errors and assert observable outcomes; do not rely only on source inspection.
5. Test a narrow viewport when layout, controls, or text wrapping changes.
6. Run directly related regression tests when changing shared state, calculations, currency behavior, or export flows.
7. Report exactly which commands ran and whether they passed. If browser setup prevents execution, state the blocker and do not claim the behavior was verified.

## Existing test map

Choose tests by behavior, not by convenience:

- `tests\test_equal_mode_no_people.py` — equal mode when there are no participants.
- `tests\test_mvp_scenarios.py` — core split scenarios, validation, responsive layout, persistence, and history.
- `tests\test_summary_export.py` — copying the bill summary and print/PDF behavior.
- `tests\test_currency_and_item_rounding.py` — currency precision, item allocation, and rounding.

Run a focused test:

```powershell
.\.venv\Scripts\python.exe tests\test_equal_mode_no_people.py
```

Run all browser regression tests when a change crosses several flows:

```powershell
.\.venv\Scripts\python.exe tests\test_equal_mode_no_people.py
.\.venv\Scripts\python.exe tests\test_mvp_scenarios.py
.\.venv\Scripts\python.exe tests\test_summary_export.py
.\.venv\Scripts\python.exe tests\test_currency_and_item_rounding.py
```

## Test design rules

- Prefer accessible labels, roles, and visible text over brittle CSS selectors. Preserve established selectors when changing UI identifiers that existing tests depend on.
- Assert user-observable behavior: rendered amounts, status messages, enabled/disabled actions, dialogs, and print output—not implementation details alone.
- Make tests independent and reset local storage or application state when scenarios require a clean bill.
- For print behavior, test that the print action is invoked or a supported fallback is shown; do not assume the host environment will open a native print dialog.
- For clipboard behavior, verify both the requested summary content and the UI feedback.
- When changing calculation rules, assert exact monetary values and rounding outcomes, including relevant edge cases.
- Keep test data deterministic and avoid relying on external services, network access, or real user data.

## Boundaries

- Do not add a test framework, dependency, or build tool for a small UI change when the existing Playwright setup is sufficient.
- Do not weaken or remove a regression assertion simply to make a test pass.
- Do not alter app behavior as part of a test-only request unless the test demonstrates a defect and the user requested a fix.
- For broad design work, also follow the project's accessibility and frontend design guidance rather than duplicating those skills here.
