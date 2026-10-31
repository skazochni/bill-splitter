(() => {
  'use strict';
  if (typeof window.BillCalc === 'undefined') {
    console.error('calc.js не загружен: модуль расчётов (BillCalc) недоступен. Приложение не инициализировано.');
    return;
  }

  const STORAGE_KEY = 'billSplitter.v1';
  const HISTORY_KEY = 'billSplitter.history.v1';
  const HISTORY_LIMIT = 20;
  const CURRENCIES = window.BillCalc.CURRENCIES;
  const AVATAR_CLASSES = 6;
  const MAX_PEOPLE = 100;
  const MAX_ITEMS = 500;
  const MAX_ID_LENGTH = 80;
  const MAX_PERSON_NAME = 40;
  const MAX_ITEM_NAME = 60;
  const SAVE_DEBOUNCE_MS = 250;
  const LIVE_TOTAL_DELAY_MS = 600;
  const UNDO_TIMEOUT_MS = 6000;
  const THEME_KEY = 'billSplitter.theme.v1';

  let storageOk = true;
  let undoSnapshot = null;
  let undoTimer = null;

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function defaultState() {
    return {
      version: 1,
      mode: 'itemized',
      currency: 'RUB',
      people: [],
      items: [],
      taxPct: 0,
      tipPct: 0,
      tipMode: 'percent',
      tipAmount: 0,
      discountPct: 0,
      equalTotal: 0,
      equalPayerId: null,
      lastItemPayerId: null
    };
  }

  const num = window.BillCalc.num;

  const intAmount = window.BillCalc.intAmount;

  function sanitize(raw) {
    const out = defaultState();
    if (!raw || typeof raw !== 'object') return out;
    if (CURRENCIES[raw.currency]) out.currency = raw.currency;
    const legacyCurrency = (typeof raw.currency === 'string' && raw.currency && !CURRENCIES[raw.currency]) ? raw.currency : null;
    if (raw.mode === 'equal') out.mode = 'equal';
    out.taxPct = num(raw.taxPct, 0);
    out.tipPct = num(raw.tipPct, 0);
    out.tipMode = raw.tipMode === 'amount' ? 'amount' : 'percent';
    out.tipAmount = intAmount(raw.tipAmount);
    out.discountPct = Math.min(100, num(raw.discountPct, 0));
    out.equalTotal = intAmount(raw.equalTotal);

    const ids = new Set();
    for (const p of Array.isArray(raw.people) ? raw.people.slice(0, MAX_PEOPLE) : []) {
      if (!p || typeof p !== 'object') continue;
      const name = String(p.name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_PERSON_NAME);
      if (!name) continue;
      let id = typeof p.id === 'string' && p.id ? p.id.slice(0, MAX_ID_LENGTH) : uid('p');
      while (ids.has(id)) id = uid('p');
      ids.add(id);
      out.people.push({ id, name });
    }
    // Сумма «поровну» — черновик, привязанный к участникам: без них она не имеет смысла.
    if (!out.people.length) out.equalTotal = 0;

    const itemIds = new Set();
    for (const it of Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : []) {
      if (!it || typeof it !== 'object') continue;
      const amount = intAmount(it.amount);
      let id = typeof it.id === 'string' && it.id ? it.id.slice(0, MAX_ID_LENGTH) : uid('i');
      while (itemIds.has(id)) id = uid('i');
      itemIds.add(id);
      const name = String(it.name || '').trim().slice(0, MAX_ITEM_NAME);
      const sharedBy = Array.isArray(it.sharedBy)
        ? [...new Set(it.sharedBy.filter((x) => typeof x === 'string' && ids.has(x)))]
        : [];
      const payerId = typeof it.payerId === 'string' && ids.has(it.payerId) ? it.payerId : null;
      out.items.push({ id, name: name || 'Позиция', amount, payerId, sharedBy });
    }

    const firstId = out.people[0] ? out.people[0].id : null;
    out.equalPayerId = typeof raw.equalPayerId === 'string' && ids.has(raw.equalPayerId) ? raw.equalPayerId : firstId;
    out.lastItemPayerId = typeof raw.lastItemPayerId === 'string' && ids.has(raw.lastItemPayerId) ? raw.lastItemPayerId : firstId;
    for (const item of out.items) {
      if (!item.payerId) item.payerId = firstId;
    }
    if (legacyCurrency) {
      BillCalc.convertCurrencyAmounts(out, legacyCurrency, 'RUB');
      out.currency = 'RUB';
    }
    return out;
  }

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      storageOk = false;
      return defaultState();
    }
    if (!raw) return defaultState();
    try {
      return sanitize(JSON.parse(raw));
    } catch {
      return defaultState();
    }
  }

  function loadHistory() {
    let raw = null;
    try {
      raw = localStorage.getItem(HISTORY_KEY);
    } catch {
      storageOk = false;
      return [];
    }
    if (!raw) return [];
    try {
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return [];
      return entries.slice(0, HISTORY_LIMIT).filter((entry) =>
        entry && typeof entry === 'object' && entry.state && typeof entry.state === 'object'
      ).map((entry) => {
        const oldCurrency = typeof entry.currency === 'string' ? entry.currency : 'RUB';
        const isLegacy = !CURRENCIES[oldCurrency];
        const currency = isLegacy ? 'RUB' : oldCurrency;
        const sanitizedState = sanitize(entry.state);
        const createdAt = typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
          ? entry.createdAt
          : new Date(0).toISOString();
        return {
          id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, MAX_ID_LENGTH) : uid('h'),
          name: String(entry.name || 'Счёт').trim().slice(0, MAX_ITEM_NAME) || 'Счёт',
          createdAt,
          currency,
          total: BillCalc.compute(sanitizedState).total,
          state: sanitizedState
        };
      });
    } catch {
      return [];
    }
  }

  let state = loadState();
  let lastSelectedCurrency = state.currency;
  let historyRecords = loadHistory();
  const CURRENCY_LABELS = { RUB: 'рубль', USD: 'доллар США', EUR: 'евро', AMD: 'драм', GEL: 'лари', KZT: 'тенге' };
  const $ = (id) => document.getElementById(id);
  const el = {
    currency: $('currencySelect'),
    reset: $('resetBtn'),
    themeBtn: $('themeBtn'),
    themeMenu: $('themeMenu'),
    historyBtn: $('historyBtn'),
    aboutBtn: $('aboutBtn'),
    aboutDialog: $('aboutDialog'),
    aboutClose: $('aboutClose'),
    convertCurrencyBtn: $('convertCurrencyBtn'),
    convertCurrencyDialog: $('convertCurrencyDialog'),
    convertCurrencyClose: $('convertCurrencyClose'),
    convertFromCurrency: $('convertFromCurrency'),
    convertToCurrency: $('convertToCurrency'),
    convertCurrencyHint: $('convertCurrencyHint'),
    convertRateInput: $('convertRateInput'),
    convertRateError: $('convertRateError'),
    convertRateLabel: $('convertRateLabel'),
    convertRateSymbol: $('convertRateSymbol'),
    convertCurrencySubmit: $('convertCurrencySubmit'),
    convertCurrencyCancel: $('convertCurrencyCancel'),
    historyCount: $('historyCount'),
    historyDialog: $('historyDialog'),
    historyClose: $('historyClose'),
    historyName: $('historyName'),
    historySave: $('historySave'),
    historyError: $('historyError'),
    historyEmpty: $('historyEmpty'),
    historyList: $('historyList'),
    storageNotice: $('storageNotice'),
    personForm: $('personForm'),
    personName: $('personName'),
    personError: $('personError'),
    demoCallout: $('demoCallout'),
    loadDemoBtn: $('loadDemoBtn'),
    demoStatus: $('demoStatus'),
    peopleList: $('peopleList'),
    peopleHint: $('peopleHint'),
    peopleCount: $('peopleCount'),
    tabs: Array.from(document.querySelectorAll('.mode-tab:not(.tip-mode-tab)')),
    itemizedPanel: $('itemizedPanel'),
    equalPanel: $('equalPanel'),
    itemForm: $('itemForm'),
    itemName: $('itemName'),
    itemAmount: $('itemAmount'),
    itemSubmit: $('itemSubmit'),
    itemError: $('itemError'),
    itemsList: $('itemsList'),
    itemsEmpty: $('itemsEmpty'),
    itemsEmptyDescription: $('itemsEmptyDescription'),
    itemsExcluded: $('itemsExcluded'),
    itemUndo: $('itemUndo'),
    itemUndoCancel: $('itemUndoCancel'),
    personUndo: $('personUndo'),
    personUndoCancel: $('personUndoCancel'),
    itemSubtotal: $('itemSubtotal'),
    discountInput: $('discountInput'),
    taxInput: $('taxInput'),
    tipInput: $('tipInput'),
    tipUnit: $('tipUnit'),
    tipModeAmountBtn: $('tipModeAmountBtn'),
    equalTotal: $('equalTotal'),
    equalPayer: $('equalPayer'),
    equalPayerHint: $('equalPayerHint'),
    equalNote: $('equalNote'),
    grandTotal: $('grandTotal'),
    grandSub: $('grandSub'),
    summaryTotals: $('summaryTotals'),
    summaryRows: $('summaryRows'),
    summaryEmpty: $('summaryEmpty'),
    summaryPeopleCount: $('summaryPeopleCount'),
    settleBlock: $('settleBlock'),
    settleList: $('settleList'),
    settleEmpty: $('settleEmpty'),
    copySummary: $('copySummary'),
    printSummary: $('printSummary'),
    exportStatus: $('exportStatus'),
    exportHelp: $('exportHelp'),
    totalLive: $('totalLive'),
    mobileTotal: $('mobileTotal'),
    mobileTotalAmount: $('mobileTotalAmount')
  };

  function currentCurrency() {
    return CURRENCIES[state.currency] || CURRENCIES.RUB;
  }


  const formatNumber = window.BillCalc.formatNumber;

  function money(cents) {
    return moneyForCurrency(cents, state.currency);
  }

  const moneyForCurrency = window.BillCalc.moneyForCurrency;

  function moneyRange(a, b) {
    const c = currentCurrency();
    return formatNumber(a / 10 ** c.digits, c.digits) + '–' +
      formatNumber(b / 10 ** c.digits, c.digits) + ' ' + c.symbol;
  }

  const parseMoney = window.BillCalc.parseMoney;

  const centsToInput = window.BillCalc.centsToInput;

  const parsePercent = window.BillCalc.parsePercent;

  const percentToInput = window.BillCalc.percentToInput;

  const formatPercent = window.BillCalc.formatPercent;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function initial(name) {
    const chars = Array.from(String(name).trim());
    return (chars[0] || '?').toLocaleUpperCase('ru-RU');
  }

  function avatarClass(id) {
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return 'av-' + (hash % AVATAR_CLASSES);
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function peopleWord(n) {
    return n + ' ' + plural(n, 'участник', 'участника', 'участников');
  }

  function itemsWord(n) {
    return n + ' ' + plural(n, 'позиция', 'позиции', 'позиций');
  }
  const splitAmount = window.BillCalc.splitAmount;

  const allocateProportionally = window.BillCalc.allocateProportionally;

  const isItemExcluded = window.BillCalc.isItemExcluded;




  let saveTimer = null;
  let liveTimer = null;

  function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageOk = true;
      el.storageNotice.hidden = true;
    } catch {
      storageOk = false;
      el.storageNotice.hidden = false;
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }
  function renderPeople() {
    el.peopleCount.textContent = String(state.people.length);
    el.peopleList.innerHTML = state.people.map((p) => `
      <span class="chip">
        <span class="avatar ${avatarClass(p.id)}" aria-hidden="true">${escapeHtml(initial(p.name))}</span>
        <span class="chip-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <button type="button" class="chip-remove" data-person-id="${escapeHtml(p.id)}" aria-label="Удалить участника ${escapeHtml(p.name)}" title="Удалить">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </span>`).join('');
    el.peopleHint.hidden = state.people.length > 0;
  }

  function renderMode() {
    el.tabs.forEach((tab) => {
      const active = tab.dataset.mode === state.mode;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    el.itemizedPanel.hidden = state.mode !== 'itemized';
    el.equalPanel.hidden = state.mode !== 'equal';
  }

  function updateItemsMeta() {
    const included = state.items.filter((item) => !isItemExcluded(item));
    const subtotal = included.reduce((sum, item) => sum + item.amount, 0);
    el.itemSubtotal.textContent = money(subtotal);
    const excluded = state.items.length - included.length;
    el.itemsExcluded.hidden = excluded === 0;
    if (excluded > 0) {
      el.itemsExcluded.textContent = excluded === 1
        ? '1 позиция не участвует в расчёте — выберите участников или удалите её.'
        : excluded + ' ' + plural(excluded, 'позиция', 'позиции', 'позиций') +
          ' не участвуют в расчёте — выберите участников или удалите их.';
    }
  }

  function itemNote(item, participants) {
    if (item.amount <= 0) return 'Укажите сумму позиции';
    if (!participants.length) return '';
    if (participants.length === 1) return '1 участник · вся сумма';
    const parts = splitAmount(item.amount, participants.length);
    const min = Math.min(...parts);
    const max = Math.max(...parts);
    const label = participants.length + ' ' + plural(participants.length, 'участник', 'участника', 'участников');
    return min === max ? label + ' · по ' + money(min) : label + ' · по ' + moneyRange(min, max);
  }

  function findItem(id) {
    return state.items.find((item) => item.id === id) || null;
  }

  function updateItemNote(card) {
    const item = findItem(card.dataset.itemId);
    if (!item) return;
    const participants = state.people.filter((p) => item.sharedBy.includes(p.id));
    const note = card.querySelector('.item-note');
    if (note) note.textContent = itemNote(item, participants);
    const warning = card.querySelector('.item-warning');
    if (warning) warning.hidden = participants.length > 0;
    card.classList.toggle('has-warning', participants.length === 0);
  }
  function itemMarkup(item, c) {
    const participants = state.people.filter((p) => item.sharedBy.includes(p.id));
    const hasPeople = state.people.length > 0;
    const placeholder = c.digits ? '0,' + '0'.repeat(c.digits) : '0';
    const payerOptions = hasPeople
      ? state.people.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === item.payerId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
      : '<option value="">Нет участников</option>';
    const toggles = state.people.map((p) => `
      <button type="button" class="person-toggle" data-person-id="${escapeHtml(p.id)}" aria-pressed="${item.sharedBy.includes(p.id)}" title="${item.sharedBy.includes(p.id) ? 'Не делить на участника' : 'Делить на участника'}">
        ${escapeHtml(p.name)}
      </button>`).join('');
    const warning = participants.length === 0;
    return `
      <li class="item${warning ? ' has-warning' : ''}" data-item-id="${escapeHtml(item.id)}">
        <div class="item-head">
          <label class="sr-only" for="item-name-${escapeHtml(item.id)}">Название позиции</label>
          <input class="item-name" id="item-name-${escapeHtml(item.id)}" type="text" maxlength="60" value="${escapeHtml(item.name)}" autocomplete="off">
          <div class="money-field item-money">
            <label class="sr-only" for="item-amount-${escapeHtml(item.id)}">Сумма позиции</label>
            <input id="item-amount-${escapeHtml(item.id)}" type="text" inputmode="decimal" value="${centsToInput(item.amount, c.digits)}" placeholder="${placeholder}" autocomplete="off">
            <span class="currency-symbol">${escapeHtml(c.symbol)}</span>
          </div>
          <button type="button" class="icon-btn item-delete" aria-label="Удалить позицию ${escapeHtml(item.name)}" title="Удалить позицию">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6.5 2h3M5 4l.6 9h4.8L11 4M6.8 6.5v4M9.2 6.5v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="item-foot">
          <label class="inline-field">Плательщик
            <select class="item-payer"${hasPeople ? '' : ' disabled'}>${payerOptions}</select>
          </label>
          <div class="split-between">
            <span class="split-label">Делить между:</span>
            <div class="toggles">${toggles || '<span class="muted">нет участников</span>'}</div>
          </div>
        </div>
        <p class="item-note">${escapeHtml(itemNote(item, participants))}</p>
        <p class="item-warning"${warning ? '' : ' hidden'}>Выберите хотя бы одного участника — позиция не участвует в расчёте.</p>
      </li>`;
  }

  function renderItems() {
    const c = currentCurrency();
    el.itemsList.innerHTML = state.items.map((item) => itemMarkup(item, c)).join('');
    el.itemsEmpty.hidden = state.items.length > 0;
    el.itemsEmptyDescription.textContent = state.people.length
      ? 'Добавьте первую позицию — например, «Пицца» — и отметьте, кто её делит.'
      : 'Сначала добавьте участников выше. Затем добавьте первую позицию и отметьте, кто её делит.';
    updateItemsMeta();
  }

  function updateEqualNote() {
    if (!state.people.length) {
      el.equalNote.textContent = 'Сначала добавьте участников — затем сумму счёта.';
      el.equalNote.classList.add('is-muted');
      return;
    }
    el.equalNote.classList.remove('is-muted');
    if (!state.equalTotal) {
      el.equalNote.textContent = 'Укажите сумму счёта, чтобы увидеть доли.';
      return;
    }
    const parts = splitAmount(state.equalTotal, state.people.length);
    const min = Math.min(...parts);
    const max = Math.max(...parts);
    const label = state.people.length + ' ' + plural(state.people.length, 'участник', 'участника', 'участников');
    el.equalNote.textContent = min === max ? label + ' · по ' + money(min) : label + ' · от ' + money(min) + ' до ' + money(max);
  }

  function renderEqual() {
    const c = currentCurrency();
    el.equalTotal.value = centsToInput(state.equalTotal, c.digits);
    el.equalTotal.placeholder = c.digits ? '0,' + '0'.repeat(c.digits) : '0';
    el.equalPayer.innerHTML = state.people.length
      ? state.people.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === state.equalPayerId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
      : '<option value="">Нет участников</option>';
    el.equalPayer.disabled = state.people.length === 0;
    el.equalPayerHint.hidden = state.people.length > 0;
    if (state.people.length === 0) {
      el.equalPayer.setAttribute('aria-describedby', 'equalPayerHint');
    } else {
      el.equalPayer.removeAttribute('aria-describedby');
    }
    updateEqualNote();
  }
  function summaryPersonMarkup(person, mode) {
    const breakdown = mode === 'itemized'
      ? [
          'позиции ' + money(person.subtotal),
          person.discount ? 'скидка −' + money(person.discount) : '',
          person.tax ? 'налог ' + money(person.tax) : '',
          person.tip ? 'чаевые ' + money(person.tip) : ''
        ].filter(Boolean).join(' · ')
      : 'доля счёта ' + money(person.subtotal) + (person.tip ? ' · чаевые ' + money(person.tip) : '');
    let balanceText = 'в расчёте';
    let balanceClass = 'is-neutral';
    if (person.balance > 0) {
      balanceText = 'вернут ' + money(person.balance);
      balanceClass = 'is-positive';
    } else if (person.balance < 0) {
      balanceText = 'доплатит ' + money(-person.balance);
      balanceClass = 'is-negative';
    }
    return `
      <div class="sum-person">
        <div class="sum-person-top">
          <span class="sum-person-name">
            <span class="avatar ${avatarClass(person.id)}" aria-hidden="true">${escapeHtml(initial(person.name))}</span>
            <span class="name">${escapeHtml(person.name)}</span>
          </span>
          <span class="sum-person-owed">${money(person.owed)}</span>
        </div>
        <div class="sum-breakdown">${escapeHtml(breakdown)}</div>
        <div class="sum-balance">
          <span class="sum-paid">Оплачено ${money(person.paid)}</span>
          <span class="balance ${balanceClass}">${escapeHtml(balanceText)}</span>
        </div>
      </div>`;
  }

  function renderSettlements(people) {
    const transfers = BillCalc.settlements(people);
    el.settleList.innerHTML = transfers.map((t) => `
      <li class="settle-item">
        <span class="settle-flow">${escapeHtml(t.from)} <span class="arrow" aria-hidden="true">→</span> ${escapeHtml(t.to)}</span>
        <span class="settle-amount">${money(t.amount)}</span>
      </li>`).join('');
    const empty = transfers.length === 0;
    el.settleList.hidden = empty;
    el.settleEmpty.hidden = !empty;
    el.settleEmpty.textContent = empty ? 'Все в расчёте — переводы не нужны.' : '';
  }
  function hasBillData() {
    return state.people.length > 0 || state.items.length > 0 ||
      state.equalTotal > 0 || state.discountPct > 0 || state.taxPct > 0 || state.tipPct > 0;
  }

  function loadDemoBill() {
    if (hasBillData()) return;

    const people = [
      { id: uid('p'), name: 'Анна' },
      { id: uid('p'), name: 'Борис' },
      { id: uid('p'), name: 'Вера' }
    ];
    const [anna, boris, vera] = people;
    const amount = (majorUnits) => Math.round(majorUnits * 10 ** currentCurrency().digits);
    state = {
      ...defaultState(),
      currency: state.currency,
      mode: 'itemized',
      people,
      items: [
        { id: uid('i'), name: 'Пицца', amount: amount(1200), payerId: anna.id, sharedBy: people.map((person) => person.id) },
        { id: uid('i'), name: 'Салат', amount: amount(650), payerId: boris.id, sharedBy: [boris.id, vera.id] },
        { id: uid('i'), name: 'Десерт', amount: amount(450), payerId: vera.id, sharedBy: [anna.id, boris.id] }
      ],
      discountPct: 5,
      taxPct: 10,
      tipPct: 10,
      equalPayerId: anna.id,
      lastItemPayerId: vera.id
    };
    saveNow();
    renderAll();
    el.demoStatus.textContent = 'Пример загружен. Участников, позиции и суммы можно изменить.';
  }

  function persistHistory(nextRecords) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(nextRecords));
      historyRecords = nextRecords;
      storageOk = true;
      el.storageNotice.hidden = true;
      el.historyError.hidden = true;
      return true;
    } catch {
      storageOk = false;
      el.storageNotice.hidden = false;
      el.historyError.textContent = 'Не удалось сохранить историю в браузере.';
      el.historyError.hidden = false;
      return false;
    }
  }

  function renderHistory() {
    el.historyCount.textContent = String(historyRecords.length);
    el.historyEmpty.hidden = historyRecords.length > 0;
    el.historyList.innerHTML = historyRecords.map((record) => {
      const savedAt = new Date(record.createdAt).toLocaleString('ru-RU', {
        dateStyle: 'short',
        timeStyle: 'short'
      });
      return `
        <li class="history-entry" data-history-id="${escapeHtml(record.id)}">
          <div class="history-entry-info">
            <div class="history-entry-name" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</div>
            <div class="history-entry-meta">${escapeHtml(savedAt)} · ${peopleWord(record.state.people.length)} · ${escapeHtml(moneyForCurrency(record.total, record.currency))}</div>
          </div>
          <div class="history-entry-actions">
            <button class="btn btn-ghost" type="button" data-history-open aria-label="Открыть счёт ${escapeHtml(record.name)}">Открыть</button>
            <button class="btn btn-ghost" type="button" data-history-delete aria-label="Удалить счёт ${escapeHtml(record.name)}">Удалить</button>
          </div>
        </li>`;
    }).join('');
  }

  function updateSummary() {
    const result = BillCalc.compute(state);
    const count = state.people.length;
    const canExport = count > 0 && hasBillData();
    el.historySave.disabled = !hasBillData();
    el.copySummary.disabled = !canExport;
    el.printSummary.disabled = !canExport;
    el.exportHelp.hidden = canExport;
    for (const button of [el.copySummary, el.printSummary]) {
      if (canExport) {
        button.removeAttribute('aria-describedby');
      } else {
        button.setAttribute('aria-describedby', 'exportHelp');
      }
    }
    el.copySummary.title = canExport ? '' : 'Добавьте участников и укажите сумму счёта';
    el.printSummary.title = canExport ? '' : 'Добавьте участников и укажите сумму счёта';
    el.exportStatus.textContent = '';

    el.grandTotal.textContent = money(result.total);
    el.mobileTotalAmount.textContent = money(result.total);
    el.mobileTotal.setAttribute('aria-label', 'Итого ' + money(result.total) + '. К итогу. Перейти к расчёту.');
    el.grandSub.textContent = count
      ? peopleWord(count) + (result.mode === 'equal' ? ' · поровну' : ' · ' + itemsWord(state.items.length))
      : 'Добавьте участников';

    if (result.mode === 'itemized') {
      let html = `<div class="totals-row"><span>Позиции</span><span>${money(result.subtotal)}</span></div>`;
      if (state.discountPct > 0 || result.discount > 0) {
        html += `<div class="totals-row"><span>Скидка · ${formatPercent(state.discountPct)}%</span><span>${money(-result.discount)}</span></div>`;
      }
      if (state.taxPct > 0 || result.tax > 0) {
        html += `<div class="totals-row"><span>Налог · ${formatPercent(state.taxPct)}%</span><span>${money(result.tax)}</span></div>`;
      }
      const hasTip = state.tipMode === 'amount' ? (state.tipAmount > 0) : (state.tipPct > 0 || result.tip > 0);
      const tipLabel = state.tipMode === 'amount'
        ? 'Чаевые · ' + money(state.tipAmount)
        : 'Чаевые · ' + formatPercent(state.tipPct) + '%';
      if (hasTip) {
        html += `<div class="totals-row"><span>${tipLabel}</span><span>${money(result.tip)}</span></div>`;
      }
      html += `<div class="totals-row is-total"><span>Итого</span><span>${money(result.total)}</span></div>`;
      if (result.excludedCount > 0) {
        html += `<div class="totals-warning">${result.excludedCount === 1
          ? '1 позиция не учтена'
          : result.excludedCount + ' ' + plural(result.excludedCount, 'позиция', 'позиции', 'позиций') + ' не учтены'} — выберите участников.</div>`;
      }
      el.summaryTotals.innerHTML = html;
      el.summaryTotals.hidden = false;
    } else {
      el.summaryTotals.innerHTML = '';
      el.summaryTotals.hidden = true;
    }

    el.summaryPeopleCount.textContent = count ? peopleWord(count) : '';
    if (!count) {
      el.summaryRows.innerHTML = '';
      el.summaryEmpty.hidden = false;
      el.settleBlock.hidden = true;
    } else {
      el.summaryEmpty.hidden = true;
      el.settleBlock.hidden = false;
      el.summaryRows.innerHTML = result.people.map((p) => summaryPersonMarkup(p, result.mode)).join('');
      renderSettlements(result.people);
    }

    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      el.totalLive.textContent = 'Итого: ' + money(result.total);
    }, LIVE_TOTAL_DELAY_MS);
  }

  function summaryText() {
    const result = BillCalc.compute(state);
    const lines = ['Расчёт счёта', 'Итого: ' + money(result.total), ''];
    if (result.mode === 'equal') {
      lines.push('Режим: поровну');
    } else {
      lines.push('Позиции: ' + money(result.subtotal));
      if (result.discount > 0) lines.push('Скидка: −' + money(result.discount));
      if (result.tax > 0) lines.push('Налог: ' + money(result.tax));
      if (result.tip > 0) {
      if (state.tipMode === 'amount') lines.push('Чаевые: ' + money(result.tip));
      else lines.push('Чаевые: ' + formatPercent(state.tipPct) + '%');
    }
      if (result.excludedCount > 0) {
        lines.push('Не учтено позиций: ' + result.excludedCount + ' (не выбраны участники)');
      }
    }
    lines.push('', 'По участникам:');
    for (const person of result.people) {
      lines.push(person.name + ' — к оплате ' + money(person.owed) + ', оплачено ' + money(person.paid));
    }
    const transfers = BillCalc.settlements(result.people);
    lines.push('', 'Переводы:');
    if (transfers.length) {
      for (const transfer of transfers) {
        lines.push(transfer.from + ' → ' + transfer.to + ': ' + money(transfer.amount));
      }
    } else {
      lines.push('Переводы не нужны.');
    }
    return lines.join('\n');
  }
  function renderAll() {
    BillCalc.ensurePayers(state);
    el.currency.value = state.currency;
    el.demoCallout.hidden = hasBillData();
    document.querySelectorAll('.currency-symbol').forEach((node) => {
      node.textContent = currentCurrency().symbol;
    });
    renderPeople();
    renderMode();
    renderItems();
    renderEqual();
    el.discountInput.value = percentToInput(state.discountPct);
    el.taxInput.value = percentToInput(state.taxPct);
    renderTipUI();
    if (el.tipModeAmountBtn) el.tipModeAmountBtn.textContent = currentCurrency().symbol;
    const c = currentCurrency();
    el.itemAmount.placeholder = c.digits ? '0,' + '0'.repeat(c.digits) : '0';
    el.itemSubmit.disabled = false;
    el.itemSubmit.title = '';
    updateSummary();
    renderHistory();
    if (!storageOk) el.storageNotice.hidden = false;
  }

  function nextItemName() {
    const names = new Set(state.items.map((item) => item.name));
    let n = 1;
    while (names.has('Позиция ' + n)) n += 1;
    return 'Позиция ' + n;
  }

  function addPerson(rawName) {
    const name = String(rawName).trim().replace(/\s+/g, ' ').slice(0, MAX_PERSON_NAME);
    if (!name) return { ok: false, error: 'Введите имя участника.' };
    const normalized = name.toLocaleLowerCase('ru-RU');
    if (state.people.some((p) => p.name.toLocaleLowerCase('ru-RU') === normalized)) {
      return { ok: false, error: 'Участник с таким именем уже есть.' };
    }
    const person = { id: uid('p'), name };
    const hadNobody = state.people.length === 0;
    state.people.push(person);
    if (!state.equalPayerId) state.equalPayerId = person.id;
    if (!state.lastItemPayerId) state.lastItemPayerId = person.id;
    if (hadNobody) {
      for (const item of state.items) {
        if (!item.payerId) item.payerId = person.id;
      }
    }
    saveNow();
    renderAll();
    return { ok: true };
  }

  function clearUndo() {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    undoSnapshot = null;
  }

  function hideUndoNotice() {
    el.itemUndo.hidden = true;
    el.personUndo.hidden = true;
  }

  function showUndo(kind) {
    el.itemUndo.hidden = kind !== 'item';
    el.personUndo.hidden = kind !== 'person';
  }

  function scheduleUndo(snapshot) {
    clearUndo();
    undoSnapshot = snapshot;
    if (undoTimer) clearTimeout(undoTimer);
    showUndo(snapshot.kind);
    undoTimer = setTimeout(() => { undoSnapshot = null; hideUndoNotice(); }, UNDO_TIMEOUT_MS);
  }

  function restorePerson(snapshot) {
    state.people.splice(Math.min(snapshot.index, state.people.length), 0, snapshot.person);
    for (const entry of snapshot.affected) {
      const item = entry.item;
      if (entry.hadParticipant) item.sharedBy = [...new Set([...(item.sharedBy || []), snapshot.person.id])];
      if (entry.wasPayer) item.payerId = snapshot.person.id;
    }
    state.equalPayerId = snapshot.equalPayerId;
    state.lastItemPayerId = snapshot.lastItemPayerId;
  }

  function undoLastDelete() {
    const snapshot = undoSnapshot;
    if (!snapshot) return;
    clearUndo();
    hideUndoNotice();
    if (snapshot.kind === 'currency') {
      state = JSON.parse(JSON.stringify(snapshot.state));
      saveNow();
      renderAll();
      return;
    }
    if (snapshot.kind === 'item') {
      state.items.splice(Math.min(snapshot.index, state.items.length), 0, snapshot.item);
    } else {
      restorePerson(snapshot);
    }
    saveNow();
    renderAll();
  }

  function removePerson(id) {
    const person = state.people.find((p) => p.id === id);
    if (!person) return;
    const snapshot = {
      kind: 'person',
      person: { id: person.id, name: person.name },
      index: state.people.indexOf(person),
      equalPayerId: state.equalPayerId,
      lastItemPayerId: state.lastItemPayerId,
      affected: state.items
        .map((item) => ({
          item,
          wasPayer: item.payerId === id,
          hadParticipant: item.sharedBy.includes(id)
        }))
        .filter((entry) => entry.wasPayer || entry.hadParticipant)
    };
    state.people = state.people.filter((p) => p.id !== id);
    for (const item of state.items) {
      item.sharedBy = item.sharedBy.filter((personId) => personId !== id);
      if (item.payerId === id) item.payerId = state.people[0] ? state.people[0].id : null;
    }
    if (state.equalPayerId === id) state.equalPayerId = state.people[0] ? state.people[0].id : null;
    if (state.lastItemPayerId === id) state.lastItemPayerId = state.people[0] ? state.people[0].id : null;
    // Без участников сумма «поровну» не может быть итогом — очищаем и сохраняем.
    if (!state.people.length) state.equalTotal = 0;
    scheduleUndo(snapshot);
    saveNow();
    renderAll();
  }

  function showPersonError(message) {
    el.personError.textContent = message;
    el.personError.hidden = false;
    el.personName.setAttribute('aria-invalid', 'true');
    el.personName.setAttribute('aria-describedby', 'personError');
  }

  function hidePersonError() {
    el.personError.hidden = true;
    el.personName.removeAttribute('aria-invalid');
    el.personName.removeAttribute('aria-describedby');
  }

  function showItemError(message) {
    el.itemError.textContent = message;
    el.itemError.hidden = false;
    el.itemAmount.setAttribute('aria-describedby', 'itemError');
  }

  function hideItemError() {
    el.itemError.hidden = true;
    el.itemAmount.removeAttribute('aria-describedby');
  }
  function effectiveTheme() {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced === 'light' || forced === 'dark') return forced;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function updateThemeMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', effectiveTheme() === 'dark' ? '#0e1116' : '#0f766e');
  }

  function loadThemeChoice() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
  }

  function applyThemeChoice(choice) {
    const root = document.documentElement;
    if (choice === 'light' || choice === 'dark') {
      root.setAttribute('data-theme', choice);
    } else {
      root.removeAttribute('data-theme');
    }
    try { localStorage.setItem(THEME_KEY, choice); } catch { }
    updateThemeMeta();
    updateThemeMenuChecked(choice);
  }

  function updateThemeMenuChecked(choice) {
    document.querySelectorAll('.theme-menu-item').forEach((btn) => {
      btn.setAttribute('aria-checked', String(btn.dataset.themeChoice === choice));
    });
  }

  function closeThemeMenu(returnFocus) {
    const menu = el.themeMenu;
    const btn = el.themeBtn;
    if (!menu || !btn) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }

  function openThemeMenu() {
    const menu = el.themeMenu;
    const btn = el.themeBtn;
    if (!menu || !btn) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const current = loadThemeChoice();
    const items = Array.from(menu.querySelectorAll('.theme-menu-item'));
    const target = items.find((b) => b.dataset.themeChoice === current) || items[0];
    if (target) target.focus();
  }

  function initTheme() {
    const choice = loadThemeChoice();
    applyThemeChoice(choice);
    const btn = el.themeBtn;
    const menu = el.themeMenu;
    if (!btn || !menu) return;
    btn.addEventListener('click', () => {
      if (menu.hidden) openThemeMenu(); else closeThemeMenu(false);
    });
    menu.addEventListener('click', (event) => {
      const item = event.target.closest('.theme-menu-item');
      if (!item) return;
      applyThemeChoice(item.dataset.themeChoice);
      closeThemeMenu(true);
    });
    menu.addEventListener('keydown', (event) => {
      const items = Array.from(menu.querySelectorAll('.theme-menu-item'));
      const idx = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = items[(idx + 1) % items.length];
        if (next) next.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = items[(idx - 1 + items.length) % items.length];
        if (prev) prev.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        if (items[0]) items[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        if (items[items.length - 1]) items[items.length - 1].focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const item = document.activeElement && document.activeElement.closest('.theme-menu-item');
        if (item) { applyThemeChoice(item.dataset.themeChoice); closeThemeMenu(true); }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeThemeMenu(true);
      }
    });
    document.addEventListener('click', (event) => {
      if (menu.hidden) return;
      if (event.target.closest('.theme-switcher')) return;
      closeThemeMenu(false);
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => { if (loadThemeChoice() === 'system') updateThemeMeta(); });
  }

  el.personForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = addPerson(el.personName.value);
    if (!result.ok) {
      showPersonError(result.error);
      return;
    }
    hidePersonError();
    el.personName.value = '';
    el.personName.focus();
  });
  el.personName.addEventListener('input', hidePersonError);
  el.loadDemoBtn.addEventListener('click', loadDemoBill);
  el.mobileTotal.addEventListener('click', () => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    document.querySelector('.summary-card').scrollIntoView({ behavior, block: 'start' });
  });
  el.copySummary.addEventListener('click', async () => {
    const text = summaryText();
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        field.remove();
      }
    }
    el.exportStatus.textContent = copied
      ? 'Расчёт скопирован — его можно отправить в чат.'
      : 'Не удалось скопировать расчёт. Проверьте разрешение браузера на буфер обмена.';
  });
  el.printSummary.addEventListener('click', () => {
    el.exportStatus.textContent = 'Если окно печати не появилось, нажмите Ctrl+P или откройте меню браузера и выберите «Печать».';
    try {
      if (typeof window.print !== 'function') throw new Error('Печать не поддерживается этим браузером.');
      window.print();
    } catch (error) {
      el.exportStatus.textContent = error instanceof Error
        ? error.message + ' Используйте Ctrl+P или меню браузера.'
        : 'Не удалось открыть печать. Используйте Ctrl+P или меню браузера.';
    }
  });
  window.addEventListener('afterprint', () => {
    el.exportStatus.textContent = 'Окно печати закрыто. Для PDF в нём выберите «Сохранить как PDF».';
  });
  el.peopleList.addEventListener('click', (event) => {
    const button = event.target.closest('.chip-remove');
    if (button) removePerson(button.dataset.personId);
  });
  el.itemUndoCancel.addEventListener('click', undoLastDelete);
  el.personUndoCancel.addEventListener('click', undoLastDelete);

  el.itemForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.people.length) {
      showPersonError('Добавьте хотя бы одного участника.');
      el.personName.focus();
      return;
    }
    const amount = parseMoney(el.itemAmount.value, currentCurrency().digits);
    if (amount === null || amount <= 0) {
      showItemError('Введите сумму больше нуля.');
      el.itemAmount.setAttribute('aria-invalid', 'true');
      el.itemAmount.focus();
      return;
    }
    hideItemError();
    el.itemAmount.removeAttribute('aria-invalid');
    const name = el.itemName.value.trim().slice(0, MAX_ITEM_NAME) || nextItemName();
    const payerId = state.lastItemPayerId || state.people[0].id;
    state.lastItemPayerId = payerId;
    state.items.push({
      id: uid('i'),
      name,
      amount,
      payerId,
      sharedBy: state.people.map((p) => p.id)
    });
    saveNow();
    renderAll();
    el.itemName.value = '';
    el.itemAmount.value = '';
    el.itemName.focus();
  });
  el.itemAmount.addEventListener('input', () => {
    el.itemAmount.removeAttribute('aria-invalid');
    hideItemError();
  });

  el.itemsList.addEventListener('input', (event) => {
    const card = event.target.closest('.item');
    if (!card) return;
    const item = findItem(card.dataset.itemId);
    if (!item) return;
    if (event.target.matches('.item-name')) {
      const value = event.target.value;
      if (value.trim()) item.name = value;
      scheduleSave();
    } else if (event.target.matches('.item-money input')) {
      const amount = parseMoney(event.target.value, currentCurrency().digits);
      if (amount === null) {
        event.target.setAttribute('aria-invalid', 'true');
        return;
      }
      event.target.removeAttribute('aria-invalid');
      item.amount = amount;
      scheduleSave();
      updateItemNote(card);
      updateItemsMeta();
      updateSummary();
    }
  });

  el.itemsList.addEventListener('focusout', (event) => {
    const card = event.target.closest('.item');
    if (!card) return;
    const item = findItem(card.dataset.itemId);
    if (!item) return;
    if (event.target.matches('.item-money input')) {
      event.target.value = centsToInput(item.amount, currentCurrency().digits);
      event.target.removeAttribute('aria-invalid');
    } else if (event.target.matches('.item-name')) {
      const name = event.target.value.trim().slice(0, MAX_ITEM_NAME);
      if (name) {
        item.name = name;
        event.target.value = item.name;
        const removeButton = card.querySelector('.item-delete');
        if (removeButton) removeButton.setAttribute('aria-label', 'Удалить позицию ' + item.name);
        scheduleSave();
      } else {
        event.target.value = item.name;
      }
    }
  });

  el.itemsList.addEventListener('change', (event) => {
    if (!event.target.matches('.item-payer')) return;
    const card = event.target.closest('.item');
    const item = findItem(card.dataset.itemId);
    if (!item) return;
    item.payerId = event.target.value || null;
    if (item.payerId) state.lastItemPayerId = item.payerId;
    saveNow();
    updateSummary();
  });
  el.itemsList.addEventListener('click', (event) => {
    const toggle = event.target.closest('.person-toggle');
    if (toggle) {
      const card = toggle.closest('.item');
      const item = findItem(card.dataset.itemId);
      if (!item) return;
      const personId = toggle.dataset.personId;
      const include = toggle.getAttribute('aria-pressed') !== 'true';
      if (include) {
        item.sharedBy = state.people
          .filter((p) => item.sharedBy.includes(p.id) || p.id === personId)
          .map((p) => p.id);
      } else {
        item.sharedBy = item.sharedBy.filter((id) => id !== personId);
      }
      toggle.setAttribute('aria-pressed', String(include));
      toggle.title = include ? 'Не делить на участника' : 'Делить на участника';
      updateItemNote(card);
      updateItemsMeta();
      updateSummary();
      scheduleSave();
      return;
    }
    const remove = event.target.closest('.item-delete');
    if (remove) {
      const card = remove.closest('.item');
      const item = findItem(card.dataset.itemId);
      if (!item) return;
      const snapshot = {
        kind: 'item',
        item: { id: item.id, name: item.name, amount: item.amount, payerId: item.payerId, sharedBy: [...item.sharedBy] },
        index: state.items.indexOf(item)
      };
      state.items = state.items.filter((candidate) => candidate.id !== item.id);
      scheduleUndo(snapshot);
      saveNow();
      renderAll();
    }
  });

  function tipMode() { return state.tipMode === 'amount' ? 'amount' : 'percent'; }

  function setTipMode(mode) {
    state.tipMode = (mode === 'amount') ? 'amount' : 'percent';
    if (state.tipMode === 'amount' && !state.tipAmount) state.tipAmount = 0;
    saveNow();
    renderTipUI();
    updateSummary();
  }

  function renderTipUI() {
    const mode = tipMode();
    document.querySelectorAll('.tip-mode-tab').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.tipMode === mode));
    });
    if (el.tipUnit) el.tipUnit.textContent = (mode === 'amount') ? (currentCurrency().symbol) : '%';
    if (el.tipModeAmountBtn) el.tipModeAmountBtn.textContent = currentCurrency().symbol;
    if (mode === 'percent') {
      el.tipInput.value = percentToInput(state.tipPct);
      el.tipInput.placeholder = '0';
    } else {
      el.tipInput.value = centsToInput(state.tipAmount, currentCurrency().digits);
      const c = currentCurrency();
      el.tipInput.placeholder = c.digits ? '0,' + '0'.repeat(c.digits) : '0';
    }
  }

  function setupTipInput() {
    el.tipInput.addEventListener('input', () => {
      if (tipMode() === 'percent') {
        const value = parsePercent(el.tipInput.value);
        if (value === null) { el.tipInput.setAttribute('aria-invalid', 'true'); return; }
        el.tipInput.removeAttribute('aria-invalid');
        state.tipPct = value;
      } else {
        const amount = parseMoney(el.tipInput.value, currentCurrency().digits);
        if (amount === null) { el.tipInput.setAttribute('aria-invalid', 'true'); return; }
        el.tipInput.removeAttribute('aria-invalid');
        state.tipAmount = amount;
      }
      scheduleSave();
      updateSummary();
    });
    el.tipInput.addEventListener('blur', () => {
      renderTipUI();
      el.tipInput.removeAttribute('aria-invalid');
    });
    document.querySelectorAll('.tip-mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => setTipMode(btn.dataset.tipMode));
    });
  }

  function bindPercentInput(input, key, maximum = Infinity) {
    input.addEventListener('input', () => {
      const value = parsePercent(input.value);
      if (value === null || value > maximum) {
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      input.removeAttribute('aria-invalid');
      state[key] = value;
      scheduleSave();
      updateSummary();
    });
    input.addEventListener('blur', () => {
      input.value = percentToInput(state[key]);
      input.removeAttribute('aria-invalid');
    });
  }
  bindPercentInput(el.discountInput, 'discountPct', 100);
  bindPercentInput(el.taxInput, 'taxPct');
  setupTipInput();

  el.equalTotal.addEventListener('input', () => {
    const value = parseMoney(el.equalTotal.value, currentCurrency().digits);
    if (value === null) {
      el.equalTotal.setAttribute('aria-invalid', 'true');
      return;
    }
    el.equalTotal.removeAttribute('aria-invalid');
    state.equalTotal = value;
    scheduleSave();
    updateSummary();
    updateEqualNote();
  });
  el.equalTotal.addEventListener('blur', () => {
    el.equalTotal.value = centsToInput(state.equalTotal, currentCurrency().digits);
    el.equalTotal.removeAttribute('aria-invalid');
    updateEqualNote();
  });
  el.equalPayer.addEventListener('change', () => {
    state.equalPayerId = el.equalPayer.value || null;
    saveNow();
    updateSummary();
  });

  el.currency.addEventListener('change', () => {
    const nextCurrency = CURRENCIES[el.currency.value] ? el.currency.value : 'RUB';
    if (nextCurrency !== state.currency) {
      lastSelectedCurrency = state.currency;
      BillCalc.convertCurrencyAmounts(state, state.currency, nextCurrency);
      state.currency = nextCurrency;
    }
    saveNow();
    renderAll();
    if (el.tipModeAmountBtn) el.tipModeAmountBtn.textContent = currentCurrency().symbol;
  });
  el.reset.addEventListener('click', () => {
    if (!hasBillData()) return;
    if (!window.confirm('Очистить счёт? Все участники и позиции будут удалены.')) return;
    clearUndo();
    const currency = state.currency;
    const mode = state.mode;
    state = defaultState();
    state.currency = currency;
    state.mode = mode;
    el.demoStatus.textContent = '';
    saveNow();
    renderAll();
    el.personName.focus();
  });

  el.historyBtn.addEventListener('click', () => {
    el.historyError.hidden = true;
    el.historyDialog.showModal();
  });
  el.historyClose.addEventListener('click', () => el.historyDialog.close());
  el.aboutBtn.addEventListener('click', () => { el.aboutDialog.showModal(); });
  el.aboutClose.addEventListener('click', () => el.aboutDialog.close());
  el.aboutDialog.addEventListener('close', () => { el.aboutBtn.focus(); });

  function populateCurrencySelect(select) {
    select.innerHTML = '';
    for (const code of Object.keys(BillCalc.CURRENCIES)) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = BillCalc.CURRENCIES[code].symbol + ' — ' + (CURRENCY_LABELS[code] || code);
      select.appendChild(opt);
    }
  }
  function openConvertCurrencyDialog() {
    populateCurrencySelect(el.convertFromCurrency);
    populateCurrencySelect(el.convertToCurrency);
    el.convertFromCurrency.value = state.currency;
    let defaultTo = 'RUB';
    if (state.currency === 'RUB') {
      defaultTo = (lastSelectedCurrency && lastSelectedCurrency !== 'RUB') ? lastSelectedCurrency : 'USD';
    }
    el.convertToCurrency.value = defaultTo;
    updateConvertCurrencyLabels();
    updateConvertCurrencyButtonState();
    el.convertRateInput.value = '';
    el.convertRateError.hidden = true;
    el.convertRateError.textContent = '';
    el.convertCurrencyDialog.showModal();
  }
  function updateConvertCurrencyLabels() {
    const from = el.convertFromCurrency.value;
    const to = el.convertToCurrency.value;
    const fromSymbol = BillCalc.CURRENCIES[from] ? BillCalc.CURRENCIES[from].symbol : from;
    const toSymbol = BillCalc.CURRENCIES[to] ? BillCalc.CURRENCIES[to].symbol : to;
    el.convertRateLabel.textContent = '1 ' + fromSymbol + ' =';
    el.convertRateSymbol.textContent = toSymbol;
  }
  function updateConvertCurrencyButtonState() {
    const same = el.convertFromCurrency.value === el.convertToCurrency.value;
    el.convertCurrencySubmit.disabled = same;
    el.convertCurrencyHint.hidden = !same;
  }
  el.convertCurrencyBtn.addEventListener('click', openConvertCurrencyDialog);
  el.convertFromCurrency.addEventListener('change', () => { updateConvertCurrencyLabels(); updateConvertCurrencyButtonState(); });
  el.convertToCurrency.addEventListener('change', () => { updateConvertCurrencyLabels(); updateConvertCurrencyButtonState(); });
  el.convertCurrencyClose.addEventListener('click', () => el.convertCurrencyDialog.close());
  el.convertCurrencyCancel.addEventListener('click', () => el.convertCurrencyDialog.close());
  el.convertCurrencyDialog.addEventListener('close', () => { el.convertCurrencyBtn.focus(); });

  function validateConvertRate(value) {
    const raw = String(value || '').trim();
    const normalized = raw.replace(',', '.');
    if (!/^\d+(\.\d{1,6})?$/.test(normalized)) return null;
    const n = Number(normalized);
    if (!Number.isFinite(n) || n <= 0 || n > 1000000) return null;
    return normalized;
  }
  el.convertCurrencySubmit.addEventListener('click', () => {
    const from = el.convertFromCurrency.value;
    const to = el.convertToCurrency.value;
    const normalized = validateConvertRate(el.convertRateInput.value);
    if (!normalized) {
      el.convertRateError.textContent = 'Введите курс больше 0, до 6 знаков после запятой';
      el.convertRateError.hidden = false;
      el.convertRateInput.focus();
      return;
    }
    if (from === to) {
      el.convertRateError.textContent = 'Выберите другую валюту';
      el.convertRateError.hidden = false;
      el.convertRateInput.focus();
      return;
    }
    el.convertRateError.hidden = true;
    const snapshot = JSON.parse(JSON.stringify(state));
    BillCalc.convertCurrencyByRate(state, from, normalized, to);
    lastSelectedCurrency = from;
    const fromSymbol = BillCalc.CURRENCIES[from].symbol;
    const toSymbol = BillCalc.CURRENCIES[to].symbol;
    const rateParts = normalized.split('.');
    let rateFrac = rateParts[1] || '';
    if (rateFrac.length < 2) rateFrac = rateFrac.padEnd(2, '0');
    const rateText = rateParts[0] + ',' + rateFrac;
    // trim? keep as is maybe
    clearUndo();
    undoSnapshot = { kind: 'currency', state: snapshot };
    const p = el.itemUndo.querySelector('p');
    if (p) p.textContent = 'Пересчитано: 1 ' + fromSymbol + ' = ' + rateText + ' ' + toSymbol + '. Отменить';
    el.itemUndo.hidden = false;
    el.personUndo.hidden = true;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoSnapshot = null; el.itemUndo.hidden = true; }, UNDO_TIMEOUT_MS);
    el.convertCurrencyDialog.close();
    saveNow();
    renderAll();
    if (el.tipModeAmountBtn) el.tipModeAmountBtn.textContent = (BillCalc.CURRENCIES[state.currency] || {}).symbol || state.currency;
  });
  el.historyDialog.addEventListener('close', () => {
    el.historyName.value = '';
    el.historyError.hidden = true;
  });
  el.historySave.addEventListener('click', () => {
    if (!hasBillData()) return;
    const savedAt = new Date().toISOString();
    const dateLabel = new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(savedAt));
    const record = {
      id: uid('h'),
      name: el.historyName.value.trim().slice(0, MAX_ITEM_NAME) || 'Счёт от ' + dateLabel,
      createdAt: savedAt,
      currency: state.currency,
      total: BillCalc.compute(state).total,
      state: JSON.parse(JSON.stringify(state))
    };
    if (persistHistory([record, ...historyRecords].slice(0, HISTORY_LIMIT))) {
      el.historyName.value = '';
      renderHistory();
    }
  });
  el.historyList.addEventListener('click', (event) => {
    const entry = event.target.closest('.history-entry');
    if (!entry) return;
    const record = historyRecords.find((item) => item.id === entry.dataset.historyId);
    if (!record) return;
    if (event.target.closest('[data-history-delete]')) {
      const nextRecords = historyRecords.filter((item) => item.id !== record.id);
      if (persistHistory(nextRecords)) renderHistory();
      return;
    }
    if (!event.target.closest('[data-history-open]')) return;
    if (hasBillData() && !window.confirm('Открыть сохранённый счёт? Текущие данные будут заменены.')) return;
    state = sanitize(record.state);
    el.demoStatus.textContent = '';
    BillCalc.ensurePayers(state);
    saveNow();
    renderAll();
    el.historyDialog.close();
  });
  el.historyDialog.addEventListener('click', (event) => {
    if (event.target === el.historyDialog) el.historyDialog.close();
  });

  el.tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      state.mode = tab.dataset.mode === 'equal' ? 'equal' : 'itemized';
      saveNow();
      renderMode();
      updateSummary();
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + el.tabs.length) % el.tabs.length;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % el.tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = el.tabs.length - 1;
      el.tabs[nextIndex].focus();
      el.tabs[nextIndex].click();
    });
  });

  window.addEventListener('beforeunload', () => {
    if (saveTimer) saveNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) saveNow();
  });

  registerServiceWorker();

  initTheme();
  renderAll();
  if (!storageOk) el.storageNotice.hidden = false;

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    try {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.error('Service worker registration failed:', err);
      });
    } catch (err) {
      console.error('Service worker registration failed:', err);
    }
  }
})();
