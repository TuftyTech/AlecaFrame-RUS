/*
 * AlecaFrame-RU: optional features on top of the translation.
 *  - «Графит»: our own dark color theme over AlecaFrame's CSS variables.
 *  - Inventory: manual price refresh from warframe.market through AlecaFrame's
 *    own market client (plugin.GetBuySellWindowData, the call behind the WTS/WTB panel).
 *  - Relic reward overlay: live prices for the detected rewards, and no "best"
 *    highlight while no reward has a known price.
 *  - Main window: optional collapse of the ad block into its Patreon line (off by default).
 * Settings live in localStorage under "afru.*" and are shared by every AlecaFrame window.
 * The subscription status and AlecaFrame's own theme data are never touched.
 */
(function (root, css) {
  'use strict';
  if (!root || !root.document || root.__AF_RU_EXTRAS__) return;

  var doc = root.document;
  var page = (/([^/\\]+)\.html?$/i.exec((root.location && root.location.pathname) || '') || [])[1] || '';
  var OVERLAY_PAGES = { InGameNotification: 1, relicOverlay: 1, relicRecommendation: 1, rivenOverlay: 1, tradeFinishedNotification: 1 };
  var isOverlay = !!OVERLAY_PAGES[page];

  var PREFIX = 'afru.';
  var PRICE_CACHE_KEY = PREFIX + 'prices';
  var DEFAULTS = { theme: 'default', themeOverlays: true, relicLivePrices: true, collapseAds: false };
  var THEMES = { graphite: 1 };
  var REFINEMENTS = { intact: 'I', exceptional: 'E', flawless: 'F', radiant: 'R' };
  var config = {
    priceTtlMs: 60 * 60 * 1000,
    maxCachedPrices: 3000,
    // warframe.market allows about 3 requests per second.
    requestGapMs: 350,
    requestTimeoutMs: 15000,
    setupPollMs: 100,
    setupPollLimit: 600,
  };

  function now() { return Date.now(); }
  function warn(message, error) {
    try { root.console.warn('[AlecaFrame-RU] ' + message, error || ''); } catch (e) { /* no console */ }
  }

  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    });
    return node;
  }

  // ---------------------------------------------------------------- settings

  function storage() { try { return root.localStorage || null; } catch (e) { return null; } }
  function readRaw(key) {
    var s = storage();
    try { return s ? s.getItem(key) : null; } catch (e) { return null; }
  }
  function writeRaw(key, value) {
    var s = storage();
    try {
      if (!s) return;
      if (value == null) s.removeItem(key);
      else s.setItem(key, value);
    } catch (e) { warn('cannot save ' + key, e); }
  }

  function getSetting(name) {
    var raw = readRaw(PREFIX + name);
    if (raw == null) return DEFAULTS[name];
    return typeof DEFAULTS[name] === 'boolean' ? raw === 'true' : raw;
  }
  function setSetting(name, value) { writeRaw(PREFIX + name, String(value)); }

  // ------------------------------------------------------------------- theme

  function injectStyle() {
    if (!css || doc.getElementById('afru-extras-style')) return true;
    var parent = doc.head || doc.documentElement;
    if (!parent) return false;
    var style = doc.createElement('style');
    style.id = 'afru-extras-style';
    style.textContent = css;
    parent.appendChild(style);
    return true;
  }

  function applyTheme() {
    var html = doc.documentElement;
    if (!html) return;
    var theme = getSetting('theme');
    var active = THEMES[theme] && (!isOverlay || getSetting('themeOverlays'));
    if (active) html.setAttribute('data-afru-theme', theme);
    else html.removeAttribute('data-afru-theme');
  }

  // --------------------------------------------------------------------- ads

  function adsCollapsed() { return page === 'main' && getSetting('collapseAds'); }

  // AlecaFrame keeps its only OwAd in the implicit global `currentAd`. While the block is
  // collapsed the ad is removed, as AlecaFrame itself does under its modals, so nothing
  // keeps loading where nobody can see it.
  var ad = { instance: null, refresh: null, ready: false, removed: false };

  function syncAdPlayback() {
    var instance = ad.instance;
    if (!instance || !ad.refresh || !ad.ready) return;
    try {
      if (adsCollapsed() && !ad.removed) { ad.removed = true; instance.removeAd(); }
      else if (!adsCollapsed() && ad.removed) { ad.removed = false; ad.refresh.call(instance); }
    } catch (e) { warn('cannot switch the ad block', e); }
  }

  function adoptAd(instance) {
    ad.instance = instance;
    ad.refresh = null;
    ad.ready = false;
    ad.removed = false;
    if (!instance || typeof instance.refreshAd !== 'function' || typeof instance.removeAd !== 'function') return;
    var refresh = ad.refresh = instance.refreshAd;
    // AlecaFrame refreshes the ad after its modals close; keep it removed while collapsed.
    instance.refreshAd = function () { if (!adsCollapsed()) return refresh.apply(instance, arguments); };
    if (typeof instance.addEventListener === 'function') {
      // OwAd accepts API calls only after this event.
      instance.addEventListener('ow_internal_rendered', function () { ad.ready = true; syncAdPlayback(); });
    } else {
      ad.ready = true;
    }
  }

  function watchAdInstance() {
    var current = root.currentAd;
    try {
      Object.defineProperty(root, 'currentAd', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (value) { current = value; adoptAd(value); },
      });
    } catch (e) { warn('cannot watch the ad block', e); return; }
    if (current) adoptAd(current);
  }

  function applyAdLayout() {
    var html = doc.documentElement;
    if (html && page === 'main') {
      if (adsCollapsed()) html.setAttribute('data-afru-ads', 'collapsed');
      else html.removeAttribute('data-afru-ads');
    }
    syncAdPlayback();
  }

  function setAdsCollapsed(collapsed) {
    setSetting('collapseAds', collapsed);
    applyAdLayout();
    syncSettingsUi();
  }

  function setupAdStrip() {
    var block = doc.querySelector('.adCointainerWithSubscribe');
    if (!block) return false;
    if (block.querySelector('.afru-adExpand')) return true;
    var expand = el('button', {
      type: 'button', 'class': 'afru-adExpand', translate: 'no',
      title: 'Развернуть рекламный блок. Свернуть снова: Настройки → AlecaFrame-RU.',
    }, ['Показать']);
    expand.addEventListener('click', function () { setAdsCollapsed(false); });
    block.appendChild(expand);
    return true;
  }

  // ------------------------------------------------------------------ prices

  function priceKey(name, variant) {
    return String(name).replace(/\s+/g, ' ').trim().toLowerCase() + '|' + (variant == null ? '' : variant);
  }
  function isFresh(entry) { return !!entry && typeof entry.t === 'number' && now() - entry.t < config.priceTtlMs; }

  function readPriceCache() {
    try {
      var data = JSON.parse(readRaw(PRICE_CACHE_KEY) || '{}');
      return data && typeof data === 'object' ? data : {};
    } catch (e) { return {}; }
  }
  var priceCache = readPriceCache();

  function savePriceCache() {
    var kept = {};
    Object.keys(priceCache)
      .filter(function (k) { return isFresh(priceCache[k]); })
      .sort(function (a, b) { return priceCache[b].t - priceCache[a].t; })
      .slice(0, config.maxCachedPrices)
      .forEach(function (k) { kept[k] = priceCache[k]; });
    priceCache = kept;
    writeRaw(PRICE_CACHE_KEY, JSON.stringify(kept));
  }
  function freshPrice(key) { return isFresh(priceCache[key]) ? priceCache[key] : null; }

  /**
   * Lowest sell and highest buy price from AlecaFrame's warframe.market listings
   * ("platimun" is AlecaFrame's spelling). For items with variants (mod rank,
   * relic refinement) only listings of that variant count. Packs count per unit
   * and only when there are no single-item listings.
   */
  function pickPrices(data, variant) {
    function prices(list) {
      if (!Array.isArray(list)) return [];
      var valid = list.filter(function (l) { return l && Number(l.platimun) > 0; });
      var hasVariants = valid.some(function (l) { return l.specialValue != null && l.specialValue !== ''; });
      if (variant != null && hasVariants) {
        valid = valid.filter(function (l) { return String(l.specialValue) === String(variant); });
      }
      var singles = valid.filter(function (l) { return !(Number(l.tradeAmount) > 1); });
      if (singles.length) return singles.map(function (l) { return Number(l.platimun); });
      return valid.map(function (l) { return Math.round(Number(l.platimun) / Number(l.tradeAmount)); });
    }
    var sell = prices(data && data.sellListings);
    var buy = prices(data && data.buyListings);
    return {
      s: sell.length ? Math.min.apply(Math, sell) : null,
      b: buy.length ? Math.max.apply(Math, buy) : null,
    };
  }

  function marketClient() {
    try {
      var client = root.plugin && typeof root.plugin.get === 'function' ? root.plugin.get() : null;
      return client && typeof client.GetBuySellWindowData === 'function' ? client : null;
    } catch (e) { return null; }
  }

  var lastRequestAt = 0;
  var requestChain = Promise.resolve();

  /** Calls GetBuySellWindowData one request at a time; resolves to { data } or { error }. */
  function requestListings(name) {
    var job = requestChain.then(function () {
      var wait = Math.max(0, lastRequestAt + config.requestGapMs - now());
      return new Promise(function (resolve) { root.setTimeout(resolve, wait); });
    }).then(function () {
      lastRequestAt = now();
      return new Promise(function (resolve) {
        var client = marketClient();
        if (!client) { resolve({ error: 'unavailable' }); return; }
        var settled = false;
        var timer = root.setTimeout(function () { finish({ error: 'timeout' }); }, config.requestTimeoutMs);
        function finish(result) {
          if (settled) return;
          settled = true;
          root.clearTimeout(timer);
          resolve(result);
        }
        try {
          client.GetBuySellWindowData(name, function (success, json) {
            if (!success) { finish({ error: 'notfound' }); return; }
            try { finish({ data: JSON.parse(json) }); } catch (e) { finish({ error: 'parse' }); }
          });
        } catch (e) { finish({ error: 'call' }); }
      });
    });
    requestChain = job;
    return job;
  }

  /** Resolves to { entry: { s, b, t } } or { error }. Prices are cached for every window. */
  function fetchPrice(name, variant) {
    return requestListings(name).then(function (res) {
      if (!res.data) return { error: res.error };
      var p = pickPrices(res.data, variant);
      if (p.s == null && p.b == null) return { error: 'nolistings' };
      var entry = { s: p.s, b: p.b, t: now() };
      priceCache[priceKey(name, variant)] = entry;
      savePriceCache();
      return { entry: entry };
    });
  }

  function clearPrices() {
    priceCache = {};
    writeRaw(PRICE_CACHE_KEY, null);
  }

  // --------------------------------------------------------------- inventory

  function itemVariant(item) {
    if (item.type === 'mod' || item.type === 'arcane') return String(item.currentModRank == null ? 0 : item.currentModRank);
    if (item.isRelic || item.type === 'relic') {
      var m = /\b(intact|exceptional|flawless|radiant)\b/i.exec(item.name || '');
      return m ? REFINEMENTS[m[1].toLowerCase()] : 'I';
    }
    return null;
  }

  function inventoryItems() {
    var items = root.inventoryApp && root.inventoryApp.items;
    return items && typeof items.length === 'number' ? items : [];
  }

  function cachedEntryFor(item) {
    return item && item.name ? freshPrice(priceKey(item.name, itemVariant(item))) : null;
  }

  function applyCachedPrices() {
    var items = inventoryItems();
    for (var i = 0; i < items.length; i++) {
      var entry = cachedEntryFor(items[i]);
      if (!entry) continue;
      if (entry.s != null && items[i].sellPrice !== entry.s) items[i].sellPrice = entry.s;
      if (entry.b != null && items[i].buyPrice !== entry.b) items[i].buyPrice = entry.b;
    }
    markFreshCards();
  }

  // Cards follow the items order (v-for); the name check guards against a render in progress.
  function markFreshCards() {
    var app = root.inventoryApp;
    var mark = function () {
      var items = inventoryItems();
      var cards = doc.querySelectorAll('#inventoryObjectContainer > .inventoryObject');
      for (var i = 0; i < cards.length; i++) {
        var label = cards[i].querySelector('.inventoryItemName');
        var item = items[i];
        var matches = item && label && label.textContent.trim() === String(item.name).trim();
        if (matches && cachedEntryFor(item)) cards[i].setAttribute('data-afru-fresh', '');
        else cards[i].removeAttribute('data-afru-fresh');
      }
    };
    if (app && typeof app.$nextTick === 'function') app.$nextTick(mark);
    else root.setTimeout(mark, 0);
  }

  var refreshRun = null;
  var lastRefresh = null;

  function formatTime(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function renderChip() {
    var chip = doc.getElementById('afruPriceRefresh');
    if (!chip) return;
    var label = chip.querySelector('.afru-chipLabel');
    var meta = chip.querySelector('.afru-chipMeta');
    if (refreshRun) {
      var percent = refreshRun.total ? Math.round((100 * refreshRun.done) / refreshRun.total) : 0;
      chip.setAttribute('data-state', 'running');
      chip.setAttribute('aria-busy', 'true');
      chip.style.setProperty('--afru-progress', percent + '%');
      label.textContent = 'Обновление цен';
      meta.textContent = refreshRun.done + ' / ' + refreshRun.total;
      chip.title = 'Загружаются текущие заказы warframe.market. Нажмите, чтобы остановить.';
      return;
    }
    chip.removeAttribute('aria-busy');
    chip.setAttribute('data-state', lastRefresh && lastRefresh.error ? 'error' : 'idle');
    label.textContent = 'Обновить цены';
    if (!lastRefresh) {
      meta.textContent = '';
      chip.title = 'Загрузить текущие цены warframe.market (игроки онлайн) для показанных предметов. ' +
        'Зелёная точка на карточке — цена обновлена.';
    } else if (lastRefresh.error) {
      meta.textContent = 'нет связи';
      chip.title = 'AlecaFrame не ответил на запрос к warframe.market. Проверьте, что игра и AlecaFrame запущены, и попробуйте ещё раз.';
    } else {
      meta.textContent = formatTime(lastRefresh.at);
      chip.title = (lastRefresh.stopped ? 'Остановлено в ' : 'Обновлено в ') + formatTime(lastRefresh.at) + ': ' +
        lastRefresh.updated + ' из ' + lastRefresh.total + '.' +
        (lastRefresh.failed ? ' Без заказов на warframe.market: ' + lastRefresh.failed + '.' : '') +
        ' Зелёная точка на карточке — цена обновлена. Нажмите, чтобы обновить снова.';
    }
  }

  /** Refreshes prices of the items shown in the Inventory tab; a second call stops the run. */
  function refreshInventoryPrices() {
    if (refreshRun) { refreshRun.stopped = true; return Promise.resolve(); }
    var seen = {};
    var jobs = [];
    var items = inventoryItems();
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || !item.name) continue;
      var variant = itemVariant(item);
      var key = priceKey(item.name, variant);
      if (seen[key]) continue;
      seen[key] = true;
      jobs.push({ name: item.name, variant: variant });
    }
    if (!jobs.length) return Promise.resolve();

    var run = refreshRun = { done: 0, total: jobs.length, updated: 0, failed: 0, stopped: false, unavailable: false };
    renderChip();
    return new Promise(function (resolve) {
      (function next(index) {
        if (run.stopped || index >= jobs.length) {
          refreshRun = null;
          lastRefresh = {
            at: now(), updated: run.updated, total: run.total, failed: run.failed,
            stopped: run.stopped && !run.unavailable, error: run.unavailable && !run.updated ? 'unavailable' : null,
          };
          renderChip();
          resolve();
          return;
        }
        fetchPrice(jobs[index].name, jobs[index].variant).then(function (res) {
          run.done++;
          if (res.entry) { run.updated++; applyCachedPrices(); }
          else if (res.error === 'unavailable') { run.unavailable = true; run.stopped = true; }
          else run.failed++;
          renderChip();
          next(index + 1);
        });
      })(0);
    });
  }

  function buildChip() {
    var chip = el('div', {
      id: 'afruPriceRefresh', 'class': 'afru-chip', role: 'button', tabindex: '0', translate: 'no', 'data-state': 'idle',
    }, [
      el('span', { 'class': 'afru-chipIcon', 'aria-hidden': 'true' }),
      el('span', { 'class': 'afru-chipLabel' }, ['Обновить цены']),
      el('span', { 'class': 'afru-chipMeta', 'aria-live': 'polite' }),
      el('span', { 'class': 'afru-chipProgress', 'aria-hidden': 'true' }),
    ]);
    chip.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    chip.addEventListener('click', function () { refreshInventoryPrices(); });
    chip.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refreshInventoryPrices(); }
    });
    return chip;
  }

  function setupInventory() {
    var app = root.inventoryApp;
    var bar = doc.querySelector('#tabInventory .foundryTopSettingsSide.right');
    if (!app || typeof app.$watch !== 'function' || !bar) return false;
    if (!doc.getElementById('afruPriceRefresh')) bar.insertBefore(buildChip(), bar.firstChild);
    app.$watch('items', applyCachedPrices);
    applyCachedPrices();
    renderChip();
    return true;
  }

  // ---------------------------------------------------------- settings tab

  function syncSettingsUi() {
    var theme = doc.getElementById('afruTheme');
    if (theme) theme.value = THEMES[getSetting('theme')] ? getSetting('theme') : 'default';
    var overlays = doc.getElementById('afruThemeOverlays');
    if (overlays) overlays.checked = getSetting('themeOverlays');
    var live = doc.getElementById('afruRelicLive');
    if (live) live.checked = getSetting('relicLivePrices');
    var ads = doc.getElementById('afruCollapseAds');
    if (ads) ads.checked = getSetting('collapseAds');
  }

  function checkboxRow(id, text, extraClass) {
    return el('label', { 'class': 'settingsCheckBoxHolder' + (extraClass ? ' ' + extraClass : ''), 'for': id }, [
      el('input', { id: id, 'class': 'settingsCheckBoxHolderBox', type: 'checkbox' }),
      text,
    ]);
  }

  function buildSettingsTab() {
    var themeSelect = el('select', { id: 'afruTheme', 'class': 'settingsSelect' }, [
      el('option', { value: 'default' }, ['Стандартная AlecaFrame']),
      el('option', { value: 'graphite' }, ['Графит — нейтральная тёмная']),
    ]);
    var clearButton = el('button', { 'class': 'buttonSettingsTest', type: 'button' }, ['Сбросить сохранённые цены']);
    var clearStatus = el('span', { 'class': 'afru-settingsStatus', 'aria-live': 'polite' });

    var tab = el('div', { id: 'afruSettingsTab', 'class': 'settingsTab', translate: 'no' }, [
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Оформление']),
        el('label', { 'class': 'settingsCheckBoxHolder', 'for': 'afruTheme' }, ['Тема:', themeSelect]),
        checkboxRow('afruThemeOverlays', 'Применять тему к оверлеям в игре', 'indent'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Пока тема AlecaFrame-RU включена, она заменяет выбранную тему AlecaFrame.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Главное окно']),
        checkboxRow('afruCollapseAds', 'Сворачивать рекламный блок'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Блок сжимается в узкую полоску со ссылкой на Patreon, освободившееся место занимают таймеры. ' +
          'Пока блок свёрнут, реклама не загружается. Развернуть: кнопка «Показать» на полоске.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Цены warframe.market']),
        checkboxRow('afruRelicLive', 'Уточнять цены наград в окне реликвии по текущим заказам'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Кнопка «Обновить цены» во вкладке «Инвентарь» берёт заказы игроков онлайн через встроенный в AlecaFrame ' +
          'клиент warframe.market. Обновлённые цены хранятся 1 час.',
        ]),
        el('div', { 'class': 'settingsCheckBoxHolder' }, [clearButton, clearStatus]),
      ]),
    ]);

    themeSelect.addEventListener('change', function () { setSetting('theme', themeSelect.value); applyTheme(); });
    tab.querySelector('#afruThemeOverlays').addEventListener('change', function (e) { setSetting('themeOverlays', e.target.checked); });
    tab.querySelector('#afruRelicLive').addEventListener('change', function (e) { setSetting('relicLivePrices', e.target.checked); });
    tab.querySelector('#afruCollapseAds').addEventListener('change', function (e) { setAdsCollapsed(e.target.checked); });
    clearButton.addEventListener('click', function () {
      clearPrices();
      lastRefresh = null;
      renderChip();
      if (root.inventoryApp && typeof root.inventoryApp.refresh === 'function') {
        try { root.inventoryApp.refresh(); } catch (e) { warn('inventory refresh failed', e); }
      }
      clearStatus.textContent = 'Готово: показаны цены AlecaFrame';
    });
    return tab;
  }

  function setupSettingsTab() {
    var modal = doc.getElementById('modalSettings');
    var header = modal && modal.querySelector('.mainTabHeader');
    var body = modal && modal.querySelector('.mainTabBody');
    if (!root.settingsApp || !header || !body) return false;
    if (doc.getElementById('afruSettingsTab')) return true;

    var tab = buildSettingsTab();
    var button = el('div', { 'class': 'tabHeaderOption', tabid: 'afruSettingsTab', translate: 'no' }, ['AlecaFrame-RU']);
    // Same behavior as AlecaFrame's doTabHeaderWork(), whose handlers also hide this tab.
    button.addEventListener('click', function () {
      Array.prototype.forEach.call(header.children, function (c) { c.classList.remove('selected'); });
      Array.prototype.forEach.call(body.children, function (c) { c.classList.remove('shown'); });
      button.classList.add('selected');
      tab.classList.add('shown');
      syncSettingsUi();
    });
    header.appendChild(button);
    body.appendChild(tab);
    syncSettingsUi();
    return true;
  }

  // ----------------------------------------------------------- relic overlay

  function bestPlatinum(relics) {
    var best = 0;
    for (var i = 0; relics && i < relics.length; i++) {
      var p = Number(relics[i] && relics[i].platinum);
      if (p > best) best = p;
    }
    return best;
  }

  function refreshRelicPrices(list) {
    var app = root.relicsApp;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      (function (relic) {
        if (!relic || !relic.name || relic.detected === false) return;
        var cached = freshPrice(priceKey(relic.name, null));
        if (cached) { if (cached.s != null) relic.platinum = cached.s; return; }
        fetchPrice(relic.name, null).then(function (res) {
          if (res.entry && res.entry.s != null && app.relics === list) relic.platinum = res.entry.s;
        });
      })(list[i]);
    }
  }

  function setupRelicOverlay() {
    var app = root.relicsApp;
    if (!app || typeof app.$watch !== 'function') return false;
    // AlecaFrame's version marks every card when all prices are unknown (-1 >= -1).
    app.relicMaxPrice = function (relic) {
      var best = bestPlatinum(app.relics);
      return best > 0 && Number(relic && relic.platinum) >= best;
    };
    // Replacing a method is not reactive: redraw cards rendered with the old one.
    if (typeof app.$forceUpdate === 'function') app.$forceUpdate();
    if (getSetting('relicLivePrices')) {
      app.$watch('relics', refreshRelicPrices);
      if (app.relics && app.relics.length) refreshRelicPrices(app.relics);
    }
    return true;
  }

  // -------------------------------------------------------------------- init

  var ready = {};

  function whenReady(setups) {
    var pending = setups.slice();
    var tries = 0;
    function attempt() {
      pending = pending.filter(function (setup) {
        try {
          if (!setup()) return true;
          ready[setup.name] = true;
        } catch (e) { warn(setup.name + ' failed', e); }
        return false;
      });
      return !pending.length;
    }
    if (!pending.length || attempt()) return;
    var timer = root.setInterval(function () {
      if (attempt() || ++tries >= config.setupPollLimit) root.clearInterval(timer);
    }, config.setupPollMs);
  }

  function applyDocumentState() { applyTheme(); applyAdLayout(); }

  if (page === 'main') watchAdInstance();
  // The installer puts the script right after <head>; when run even earlier there is no <html> yet.
  if (injectStyle() && doc.documentElement) applyDocumentState();
  else doc.addEventListener('DOMContentLoaded', function () { injectStyle(); applyDocumentState(); });
  root.addEventListener('storage', function (e) {
    if (e.key === PRICE_CACHE_KEY) { priceCache = readPriceCache(); return; }
    if (e.key == null || e.key.indexOf(PREFIX) === 0) { applyDocumentState(); syncSettingsUi(); }
  });

  root.__AF_RU_EXTRAS__ = {
    /** Which hooks are installed in this window, e.g. { setupInventory: true }. */
    ready: ready,
    config: config,
    getSetting: getSetting,
    setSetting: setSetting,
    applyTheme: applyTheme,
    setAdsCollapsed: setAdsCollapsed,
    pickPrices: pickPrices,
    priceKey: priceKey,
    fetchPrice: fetchPrice,
    clearPrices: clearPrices,
    refreshInventoryPrices: refreshInventoryPrices,
  };

  if (page === 'main') whenReady([setupInventory, setupSettingsTab, setupAdStrip]);
  else if (page === 'relicOverlay') whenReady([setupRelicOverlay]);
})(typeof window !== 'undefined' ? window : null, /*__AF_RU_EXTRAS_CSS__*/ '');
