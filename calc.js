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
    convertCurrencyAmounts: convertCurrencyAmounts
  };
});
