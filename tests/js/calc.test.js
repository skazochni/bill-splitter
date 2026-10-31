const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BillCalc = require('../../calc.js');

const ROOT = path.resolve(__dirname, '../..');
const GOLDEN_PATH = path.join(ROOT, 'tests', 'fixtures', 'compute_golden.json');

function normSpaces(s) {
  return String(s).replace(/\u00A0/g, ' ').replace(/\u202F/g, ' ');
}

// 1. compute() against golden snapshot
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

for (const [label, entry] of Object.entries(golden)) {
  test(`compute golden: ${label}`, () => {
    const actual = BillCalc.compute(entry.input);
    assert.deepStrictEqual(actual, entry.result);
  });
}

// 2. Primitives
test('splitAmount: remainder distributed', () => {
  assert.deepStrictEqual(BillCalc.splitAmount(10, 3), [4, 3, 3]);
});

test('splitAmount: single participant', () => {
  assert.deepStrictEqual(BillCalc.splitAmount(10, 1), [10]);
});

test('splitAmount: zero participants returns empty', () => {
  assert.deepStrictEqual(BillCalc.splitAmount(10, 0), []);
});

test('allocateProportionally: zero weights return zeros', () => {
  assert.deepStrictEqual(BillCalc.allocateProportionally(10, [0, 0, 0]), [0, 0, 0]);
});

test('allocateProportionally: remainder cents distributed', () => {
  const res = BillCalc.allocateProportionally(10, [1, 1, 1]);
  assert.equal(res.reduce((a, b) => a + b, 0), 10);
  assert.deepStrictEqual(res, [4, 3, 3]);
});

test('isItemExcluded: no participants -> excluded', () => {
  assert.equal(BillCalc.isItemExcluded({ sharedBy: [] }), true);
});

test('isItemExcluded: with participant -> not excluded (even zero amount)', () => {
  assert.equal(BillCalc.isItemExcluded({ sharedBy: ['p1'] }), false);
});

test('parseMoney/centsToInput: AMD (0 digits)', () => {
  assert.equal(BillCalc.parseMoney('100', 0), 100);
  assert.equal(BillCalc.centsToInput(100, 0), '100');
});

test('parseMoney/centsToInput: 2 digits comma and dot', () => {
  assert.equal(BillCalc.parseMoney('1,5', 2), 150);
  assert.equal(BillCalc.parseMoney('1.5', 2), 150);
  assert.equal(BillCalc.centsToInput(150, 2), '1,50');
});

test('parsePercent/formatPercent round-trip', () => {
  assert.equal(BillCalc.parsePercent('10,5'), 10.5);
  const formatted = BillCalc.formatPercent(10.5);
  assert.equal(BillCalc.parsePercent(formatted), 10.5);
});

// 3. Money formatting normalization
test('moneyForCurrency normalizes nbsp in thousands', () => {
  const s = BillCalc.moneyForCurrency(123456, 'RUB');
  const norm = normSpaces(s);
  assert.equal(norm, '1 234,56 ₽');
});

// 4. settlements: compare as sorted set (order-independent)
test('settlements: transfers for simple debt', () => {
  const people = [
    { name: 'Анна', balance: 500 },
    { name: 'Борис', balance: -500 },
  ];
  const transfers = BillCalc.settlements(people);
  const sorted = transfers.map(t => `${t.from}->${t.to}:${t.amount}`).sort();
  assert.deepStrictEqual(sorted, ['Борис->Анна:500']);
});

test('settlements: no transfers when balanced', () => {
  const people = [
    { name: 'Анна', balance: 0 },
    { name: 'Борис', balance: 0 },
  ];
  assert.deepStrictEqual(BillCalc.settlements(people), []);
});

// 5. convertCurrencyAmounts: 2 digits -> AMD -> back, no NaN
test('convertCurrencyAmounts: round-trip RUB->AMD->RUB', () => {
  const st = {
    items: [{ id: 'i1', name: 'X', amount: 1000, payerId: 'p1', sharedBy: ['p1'] }],
    equalTotal: 2000,
  };
  const copy1 = JSON.parse(JSON.stringify(st));
  BillCalc.convertCurrencyAmounts(copy1, 'RUB', 'AMD');
  assert.ok(Number.isFinite(copy1.items[0].amount));
  assert.ok(Number.isFinite(copy1.equalTotal));
  assert.equal(copy1.items[0].amount, 10);
  assert.equal(copy1.equalTotal, 20);
  const copy2 = JSON.parse(JSON.stringify(copy1));
  BillCalc.convertCurrencyAmounts(copy2, 'AMD', 'RUB');
  assert.ok(Number.isFinite(copy2.items[0].amount));
  assert.ok(Number.isFinite(copy2.equalTotal));
  assert.equal(copy2.items[0].amount, st.items[0].amount);
  assert.equal(copy2.equalTotal, st.equalTotal);
});

test('convertCurrencyAmounts: same precision no-op', () => {
  const st = { items: [{ amount: 1000 }], equalTotal: 2000 };
  const before = JSON.stringify(st);
  BillCalc.convertCurrencyAmounts(st, 'RUB', 'USD');
  assert.equal(JSON.stringify(st), before);
});
