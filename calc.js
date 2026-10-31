(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BillCalc = api;
  if (typeof globalThis !== 'undefined' && !globalThis.BillCalc) globalThis.BillCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CURRENCIES = {
    RUB: { symbol: '₽', digits: 2 },
    USD: { symbol: '$', digits: 2 },
    EUR: { symbol: '€', digits: 2 },
    GBP: { symbol: '£', digits: 2 },
    KZT: { symbol: '₸', digits: 2 },
    AMD: { symbol: '֏', digits: 2 },
    GEL: { symbol: '₾', digits: 2 },
    JPY: { symbol: '¥', digits: 0 }
  };

  function num(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function intAmount(value) {
    return Math.max(0, Math.round(num(value, 0)));
  }

  function formatNumber(value, digits) {
    return new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value);
  }

  function moneyForCurrency(cents, currency) {
    const c = CURRENCIES[currency] || CURRENCIES.RUB;
    return formatNumber(cents / 10 ** c.digits, c.digits) + ' ' + c.symbol;
  }

  function parseMoney(text, digits) {
    const cleaned = String(text).trim().replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
    if (!cleaned) return 0;
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return null;
    const value = Number(cleaned);
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 10 ** digits);
  }

  function centsToInput(cents, digits) {
    if (!cents) return '';
    return (cents / 10 ** digits).toFixed(digits).replace('.', ',');
  }

  function parsePercent(text) {
    const cleaned = String(text).trim().replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
    if (!cleaned) return 0;
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return null;
    const value = Number(cleaned);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function percentToInput(pct) {
    return pct ? String(pct).replace('.', ',') : '';
  }

  function formatPercent(pct) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(pct);
  }

  function splitAmount(amount, parts) {
    if (parts <= 0) return [];
    const base = Math.floor(amount / parts);
    const remainder = amount - base * parts;
    return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  function allocateProportionally(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0 || total === 0) return weights.map(() => 0);
    const shares = weights.map((w) => Math.floor((total * w) / sum));
    const remainder = total - shares.reduce((a, b) => a + b, 0);
    const order = weights
      .map((w, index) => ({ index, fraction: (total * w) % sum }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let i = 0; i < remainder; i += 1) shares[order[i % order.length].index] += 1;
    return shares;
  }

  function isItemExcluded(item) {
    // Позиция исключена из расчёта, если у неё нет участников.
    // Нулевая сумма — отдельный случай невалидности, а не «исключение».
    return item.sharedBy.length === 0;
  }

  function convertCurrencyAmounts(state, oldCurrency, newCurrency) {
    const oldDigits = CURRENCIES[oldCurrency] ? CURRENCIES[oldCurrency].digits : 2;
    const newDigits = CURRENCIES[newCurrency] ? CURRENCIES[newCurrency].digits : 2;
    if (oldDigits === newDigits) return;
    const factor = 10 ** (newDigits - oldDigits);
    for (const item of state.items) {
      item.amount = Math.max(0, Math.round(item.amount * factor));
    }
    state.equalTotal = Math.max(0, Math.round(state.equalTotal * factor));
    if (typeof state.tipAmount === 'number') {
      state.tipAmount = Math.max(0, Math.round(state.tipAmount * factor));
    }
  }

  function compute(state) {
    ensurePayers(state);
    const people = state.people;
    const stats = new Map(people.map((p) => [p.id, {
      id: p.id, name: p.name, subtotal: 0, discount: 0, tax: 0, tip: 0, owed: 0, paid: 0, balance: 0
    }]));

    if (state.mode === 'equal') {
      const total = people.length ? state.equalTotal : 0;
      const tip = people.length
        ? (state.tipMode === 'amount' ? (state.tipAmount || 0) : Math.round(total * (state.tipPct || 0) / 100))
        : 0;
      const grandTotal = total + tip;
      const shares = splitAmount(total, people.length);
      const tipShares = splitAmount(tip, people.length);
      people.forEach((p, i) => {
        const s = stats.get(p.id);
        s.subtotal = shares[i] || 0;
        s.tip = tipShares[i] || 0;
        s.owed = s.subtotal + s.tip;
        s.paid = p.id === state.equalPayerId ? grandTotal : 0;
        s.balance = s.paid - s.owed;
      });
      return { mode: 'equal', people: [...stats.values()], subtotal: total, tax: 0, tip, total: grandTotal, excludedCount: 0 };
    }

    const included = [];
    for (const item of state.items) {
      if (item.amount <= 0) continue;
      // Resolve participants in global people order, not sharedBy order,
      // so remainder cents are distributed deterministically.
      const participants = people.filter((p) => item.sharedBy.includes(p.id));
      if (participants.length) included.push({ item, participants });
    }
    const subtotal = included.reduce((sum, entry) => sum + entry.item.amount, 0);
    const discount = Math.min(subtotal, Math.round(subtotal * state.discountPct / 100));
    const discountParts = allocateProportionally(discount, included.map((entry) => entry.item.amount));
    const netAmounts = included.map((entry, index) => entry.item.amount - discountParts[index]);
    const taxableSubtotal = subtotal - discount;
    const tax = Math.round(taxableSubtotal * state.taxPct / 100);
    const tip = (state.tipMode === 'amount') ? (state.tipAmount || 0) : Math.round(taxableSubtotal * (state.tipPct || 0) / 100);
    const taxParts = allocateProportionally(tax, netAmounts);
    const tipParts = allocateProportionally(tip, netAmounts);

    included.forEach((entry, index) => {
      const item = entry.item;
      const participants = entry.participants;
      const amountShares = splitAmount(item.amount, participants.length);
      const discountShares = splitAmount(discountParts[index], participants.length);
      const taxShares = splitAmount(taxParts[index], participants.length);
      const tipShares = splitAmount(tipParts[index], participants.length);
      participants.forEach((p, i) => {
        const s = stats.get(p.id);
        s.subtotal += amountShares[i];
        s.discount += discountShares[i];
        s.tax += taxShares[i];
        s.tip += tipShares[i];
      });
      if (item.payerId && stats.has(item.payerId)) {
        stats.get(item.payerId).paid += netAmounts[index] + taxParts[index] + tipParts[index];
      }
    });

    people.forEach((p) => {
      const s = stats.get(p.id);
      s.owed = s.subtotal - s.discount + s.tax + s.tip;
      s.balance = s.paid - s.owed;
    });

    const excludedCount = state.items.filter(isItemExcluded).length;
    return {
      mode: 'itemized', people: [...stats.values()], subtotal, discount, tax, tip,
      total: taxableSubtotal + tax + tip, excludedCount
    };
  }

  function settlements(people) {
    const debtors = people
      .filter((p) => p.balance < 0)
      .map((p) => ({ name: p.name, amount: -p.balance }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ru'));
    const creditors = people
      .filter((p) => p.balance > 0)
      .map((p) => ({ name: p.name, amount: p.balance }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ru'));
    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const amount = Math.min(debtors[i].amount, creditors[j].amount);
      if (amount > 0) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount });
      debtors[i].amount -= amount;
      creditors[j].amount -= amount;
      if (debtors[i].amount === 0) i += 1;
      if (creditors[j].amount === 0) j += 1;
    }
    return transfers;
  }

  function ensurePayers(state) {
    const ids = new Set(state.people.map((p) => p.id));
    const first = state.people[0] ? state.people[0].id : null;
    if (first) {
      if (!ids.has(state.equalPayerId)) state.equalPayerId = first;
      if (!ids.has(state.lastItemPayerId)) state.lastItemPayerId = first;
      for (const item of state.items) {
        if (!ids.has(item.payerId)) item.payerId = state.lastItemPayerId;
      }
    } else {
      state.equalPayerId = null;
      state.lastItemPayerId = null;
      for (const item of state.items) item.payerId = null;
    }
  }

  return {
    CURRENCIES: CURRENCIES,
    num: num,
    intAmount: intAmount,
    formatNumber: formatNumber,
    moneyForCurrency: moneyForCurrency,
    parseMoney: parseMoney,
    centsToInput: centsToInput,
    parsePercent: parsePercent,
    percentToInput: percentToInput,
    formatPercent: formatPercent,
    splitAmount: splitAmount,
    allocateProportionally: allocateProportionally,
    isItemExcluded: isItemExcluded,
    convertCurrencyAmounts: convertCurrencyAmounts,
    settlements: settlements,
    ensurePayers: ensurePayers,
    compute: compute
  };
});
