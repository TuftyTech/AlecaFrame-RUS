/*
 * AlecaFrame-RUS: optional features on top of the translation.
 *  - «Графит»: our own dark color theme over AlecaFrame's CSS variables.
 *  - Inventory: manual price refresh from warframe.market through AlecaFrame's
 *    own market client (plugin.GetBuySellWindowData, the call behind the WTS/WTB panel).
 *  - Inventory: a click on an item name copies its Russian name (English without a translation).
 *  - Relic reward overlay: current warframe.market orders for every reward each time the window opens
 *    (same client as the Inventory button), with an instant placeholder until they arrive (an earlier
 *    price or the preloaded daily average); ducats per platinum and missing set parts on each card;
 *    no "best" highlight while no reward has a known price.
 *  - Main window: optional collapse of the ad block into its Patreon line (off by default).
 *  - Overlays: optional ad-free layout of the reward and riven windows (off by default).
 *  - Russian search: every window gets its own wrapper of AlecaFrame's plugin (src/search.js).
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
  var BULK_PRICES_KEY = PREFIX + 'bulkPrices';
  var DEFAULTS = {
    theme: 'default', themeOverlays: true, relicLivePrices: true, collapseAds: false, hideOverlayAds: false,
    hiddenTabs: '', lang: 'ru',
  };
  var LANGUAGES = { ru: 1, en: 1, auto: 1 };
  var THEMES = { graphite: 1 };
  var REFINEMENTS = { intact: 'I', exceptional: 'E', flawless: 'F', radiant: 'R' };
  // Windows whose ad slot AlecaFrame lays out through shouldAdsBeShown().
  var AD_LAYOUT_PAGES = { relicOverlay: 1, rivenOverlay: 1, AFBuilds: 1 };
  var config = {
    // Daily average prices of every Prime part and set (WFInfo data via warframestat.us, open CORS, ~70 KB).
    bulkPricesUrl: 'https://api.warframestat.us/wfinfo/prices/',
    bulkPricesTtlMs: 3 * 60 * 60 * 1000,
    priceTtlMs: 60 * 60 * 1000,
    // The reward window asks for every reward each time it opens; within this time a name is asked once.
    relicRequestReuseMs: 20 * 1000,
    maxCachedPrices: 3000,
    // warframe.market allows about 3 requests per second.
    requestsPerSecond: 3,
    maxParallelRequests: 3,
    requestTimeoutMs: 15000,
    // How long «Скопировано» stays on an inventory card.
    copiedMs: 1500,
    setupPollMs: 100,
    setupPollLimit: 600,
  };

  function now() { return Date.now(); }
  function warn(message, error) {
    try { root.console.warn('[AlecaFrame-RUS] ' + message, error || ''); } catch (e) { /* no console */ }
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

  // --------------------------------------------------------------- side menu

  // Main window tabs that can be removed from the side menu. «Литейная» is the start tab and stays.
  var HIDEABLE_TABS = [
    ['tabMasteryHelper', 'Помощник мастерства'],
    ['tabInventory', 'Инвентарь'],
    ['tabRelicPlanner', 'Реликвии'],
    // Added by src/farm.js, possibly after the settings tab is built.
    ['afruTabFarm', 'Где фармить'],
    ['tabRivenExplorer', 'Моды Разлома'],
    ['tabWarframeMarket', 'Warframe Market'],
    ['proAnalyticsTab', 'Аналитика торговли'],
    ['tabStats', 'Статистика'],
    ['tabAbout', 'Справка'],
  ];
  var START_TAB = 'tabFoundry';

  function menuItem(tabId) { return doc.querySelector('.topMenuGroup > .menuItem[tabid="' + tabId + '"]'); }

  function hiddenTabs() {
    var known = {};
    HIDEABLE_TABS.forEach(function (tab) { known[tab[0]] = true; });
    return String(getSetting('hiddenTabs') || '').split(',').filter(function (id) { return known[id]; });
  }

  function applyHiddenTabs() {
    if (page !== 'main') return;
    var parent = doc.head || doc.documentElement;
    if (!parent) return;
    var style = doc.getElementById('afru-hidden-tabs');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'afru-hidden-tabs';
      parent.appendChild(style);
    }
    var ids = hiddenTabs();
    style.textContent = ids.length
      ? ids.map(function (id) { return '.topMenuGroup > .menuItem[tabid="' + id + '"]'; }).join(',\n') + ' { display: none !important; }'
      : '';
    // Hiding the open tab would leave its page without a menu entry: go back to the start tab.
    var selected = doc.querySelector('.topMenuGroup > .menuItem.selected');
    var start = menuItem(START_TAB);
    if (selected && start && ids.indexOf(selected.getAttribute('tabid')) >= 0) start.click();
  }

  function setTabHidden(tabId, hidden) {
    var ids = hiddenTabs().filter(function (id) { return id !== tabId; });
    if (hidden) ids.push(tabId);
    setSetting('hiddenTabs', ids.join(','));
    applyHiddenTabs();
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
      title: 'Развернуть рекламный блок. Свернуть снова: Настройки → AlecaFrame-RUS.',
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

  // Requests start in order, at most config.requestsPerSecond per second and
  // config.maxParallelRequests at a time, so four relic rewards are asked for together.
  var queue = [];
  var recentStarts = [];
  var running = 0;
  var pumpTimer = null;

  function pump() {
    pumpTimer = null;
    while (queue.length && running < config.maxParallelRequests) {
      var t = now();
      recentStarts = recentStarts.filter(function (s) { return t - s < 1000; });
      if (recentStarts.length >= config.requestsPerSecond) {
        pumpTimer = root.setTimeout(pump, recentStarts[0] + 1000 - t);
        return;
      }
      recentStarts.push(t);
      running++;
      queue.shift()();
    }
  }

  function schedule(job) {
    return new Promise(function (resolve) {
      queue.push(function () {
        job().then(function (result) {
          running--;
          resolve(result);
          if (!pumpTimer) pump();
        });
      });
      if (!pumpTimer) pump();
    });
  }

  /** Calls GetBuySellWindowData; resolves to { data } or { error }. */
  function requestListings(name) {
    return schedule(function () {
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

  // Daily averages for every Prime part: the reward window shows a price at once, before (or without)
  // a live request. Shared by all windows through localStorage, refreshed every few hours.
  function readBulkPrices() {
    try {
      var data = JSON.parse(readRaw(BULK_PRICES_KEY) || 'null');
      return data && typeof data.t === 'number' && data.p && typeof data.p === 'object' ? data : null;
    } catch (e) { return null; }
  }
  var bulkPrices = readBulkPrices();
  var bulkRequest = null;

  function parseBulkPrices(list) {
    var prices = {};
    (Array.isArray(list) ? list : []).forEach(function (row) {
      var value = Math.round(Number(row && row.custom_avg));
      if (row && typeof row.name === 'string' && value > 0) prices[row.name.replace(/\s+/g, ' ').trim().toLowerCase()] = value;
    });
    return prices;
  }

  function loadBulkPrices(force) {
    if (!force && bulkPrices && now() - bulkPrices.t < config.bulkPricesTtlMs) return Promise.resolve(bulkPrices);
    if (bulkRequest) return bulkRequest;
    if (typeof root.fetch !== 'function') return Promise.resolve(bulkPrices);
    bulkRequest = root.fetch(config.bulkPricesUrl, { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (list) {
        var prices = parseBulkPrices(list);
        if (!Object.keys(prices).length) throw new Error('empty price list');
        bulkPrices = { t: now(), p: prices };
        writeRaw(BULK_PRICES_KEY, JSON.stringify(bulkPrices));
        return bulkPrices;
      })
      .catch(function (e) { warn('daily prices unavailable', e); return bulkPrices; })
      .then(function (result) { bulkRequest = null; return result; });
    return bulkRequest;
  }

  /** Daily average in platinum, or null. Warframe parts are listed with " Blueprint", weapon parts without. */
  function bulkPrice(name) {
    if (!bulkPrices || !name) return null;
    var key = String(name).replace(/\s+/g, ' ').trim().toLowerCase();
    var p = bulkPrices.p;
    return p[key] || p[key + ' blueprint'] || p[key.replace(/ blueprint$/, '')] || null;
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

  /** Puts cached prices on the listed items; with resort, restores the price order if a price changed. */
  function applyCachedPrices(resort) {
    var items = inventoryItems();
    var changed = false;
    for (var i = 0; i < items.length; i++) {
      var entry = cachedEntryFor(items[i]);
      if (!entry) continue;
      if (entry.s != null && items[i].sellPrice !== entry.s) { items[i].sellPrice = entry.s; changed = true; }
      if (entry.b != null && items[i].buyPrice !== entry.b) { items[i].buyPrice = entry.b; changed = true; }
    }
    if (changed && resort) sortByPrice();
    markFreshCards();
  }

  // AlecaFrame sorts the list in its plugin, by the prices it had when the list was loaded.
  function sortValue(item, order) {
    var price = Number(item.sellPrice);
    if (!(price > 0)) return null;
    if (order === 'platPrice') return price;
    var ducats = Number(item.ducats);
    return ducats > 0 ? ducats / price : null; // ducanator: ducats per platinum, as on the cards
  }

  /**
   * Re-sorts the list by the current sell prices when it is ordered by platinum (or ducats per
   * platinum), in AlecaFrame's current direction (largest first by default). Items without a price
   * go last; equal prices keep their order.
   */
  function sortByPrice() {
    var select = doc.getElementById('inventoryOrdering');
    var order = select ? select.value : '';
    if (order !== 'platPrice' && order !== 'ducanator') return false;
    var items = inventoryItems();
    if (items.length < 2 || typeof items.splice !== 'function') return false;
    var descending = root.orderedLargerToSmaller !== false;
    var ranked = Array.prototype.map.call(items, function (item, index) {
      return { item: item, index: index, value: item ? sortValue(item, order) : null };
    });
    ranked.sort(function (a, b) {
      if (a.value == null || b.value == null) {
        if (a.value == null && b.value == null) return a.index - b.index;
        return a.value == null ? 1 : -1;
      }
      if (a.value !== b.value) return descending ? b.value - a.value : a.value - b.value;
      return a.index - b.index;
    });
    if (ranked.every(function (r, i) { return r.index === i; })) return false;
    // In place: AlecaFrame's `items` watcher (and ours) only fire when the list is replaced.
    items.splice.apply(items, [0, items.length].concat(ranked.map(function (r) { return r.item; })));
    return true;
  }

  function displayedName(name) {
    var ru = root.__AF_RU__ && root.__AF_RU__.translate(name);
    return ru || name;
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
        var shown = label ? label.textContent.trim() : '';
        var name = item ? String(item.name).trim() : '';
        var matches = item && label && (shown === name || shown === displayedName(name).trim());
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
        'Зелёная точка на карточке: цена обновлена.';
    } else if (lastRefresh.error) {
      meta.textContent = 'нет связи';
      chip.title = 'AlecaFrame не ответил на запрос к warframe.market. Проверьте, что игра и AlecaFrame запущены, и попробуйте ещё раз.';
    } else {
      meta.textContent = formatTime(lastRefresh.at);
      chip.title = (lastRefresh.stopped ? 'Остановлено в ' : 'Обновлено в ') + formatTime(lastRefresh.at) + ': ' +
        lastRefresh.updated + ' из ' + lastRefresh.total + '.' +
        (lastRefresh.failed ? ' Без заказов на warframe.market: ' + lastRefresh.failed + '.' : '') +
        ' Зелёная точка на карточке: цена обновлена. Нажмите, чтобы обновить снова.';
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
          // Cards stay in place while prices arrive and are re-sorted once at the end.
          if (run.updated && sortByPrice()) markFreshCards();
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
          if (res.entry) { run.updated++; applyCachedPrices(false); }
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
    // A list loaded by AlecaFrame is sorted by its own prices: apply ours and sort again.
    app.$watch('items', function () { applyCachedPrices(true); });
    applyCachedPrices(true);
    renderChip();
    return true;
  }

  // ------------------------------------------------------ inventory: copy name

  // The text itself: the name row is wider than the name, and the rest of the row belongs to the card.
  var NAME_TEXT = '#inventoryObjectContainer > .inventoryObject .inventoryItemName > span';
  var copiedTimers = typeof WeakMap === 'function' ? new WeakMap() : null;

  function normalizeName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function nameTextOf(event) {
    var target = event && event.target;
    if (target && target.nodeType !== 1) target = target.parentNode;
    return target && target.closest ? target.closest(NAME_TEXT) : null;
  }

  /** The card's item in inventoryApp.items, or null while the card shows something else (a render in progress). */
  function cardItem(card, label) {
    var index = 0;
    for (var c = card.previousElementSibling; c; c = c.previousElementSibling) {
      if (c.classList.contains('inventoryObject')) index++;
    }
    var item = inventoryItems()[index];
    if (!item || !item.name) return null;
    var shown = normalizeName(label.textContent);
    var name = normalizeName(item.name);
    return shown === name || shown === normalizeName(displayedName(name)) ? item : null;
  }

  /*
   * The English name comes from AlecaFrame's data. The card text is only a fallback, read the way
   * AlecaFrame reads it: the localizer shows the original text meanwhile (READ_BACK in localizer.js).
   */
  function englishName(card, label) {
    var item = cardItem(card, label);
    if (item) return normalizeName(item.name);
    var ru = root.__AF_RU__;
    var read = function () { return label.textContent; };
    return normalizeName(ru && typeof ru.withSourceText === 'function' ? ru.withSourceText(label, read, null, []) : read());
  }

  /** The Russian name, or the English one when there is none or the interface is in English. */
  function copiedName(name) {
    var ru = root.__AF_RU__;
    if (!ru || ru.active === false || typeof ru.items !== 'function') return name;
    var items = ru.items() || {};
    return Object.prototype.hasOwnProperty.call(items, name) && items[name] ? items[name] : name;
  }

  /** Resolves to true once the text is on the clipboard. Overwolf windows may lack focus for navigator.clipboard. */
  function placeOnClipboard(text) {
    var utils = root.overwolf && root.overwolf.utils;
    if (utils && typeof utils.placeOnClipboard === 'function') {
      try {
        utils.placeOnClipboard(text);
        return Promise.resolve(true);
      } catch (e) { warn('overwolf.utils.placeOnClipboard failed', e); }
    }
    var clipboard = root.navigator && root.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(false);
    return clipboard.writeText(text).then(function () { return true; }, function (e) { warn('clipboard unavailable', e); return false; });
  }

  // Drawn by CSS from the attribute in place of the name: the text that AlecaFrame reads back stays as it was.
  function showCopied(label) {
    label.setAttribute('data-afru-copied', L('Скопировано', 'Copied'));
    if (!copiedTimers) return;
    root.clearTimeout(copiedTimers.get(label));
    copiedTimers.set(label, root.setTimeout(function () { label.removeAttribute('data-afru-copied'); }, config.copiedMs));
  }

  // Capture phase on the document: runs before the card's own click handler (the item window)
  // and does not depend on Vue keeping the list elements.
  function onNameClick(event) {
    var text = nameTextOf(event);
    if (!text) return;
    event.stopPropagation();
    var label = text.parentElement;
    var card = label.closest('#inventoryObjectContainer > .inventoryObject');
    var name = englishName(card, label);
    if (!name) return;
    placeOnClipboard(copiedName(name)).then(function (copied) { if (copied) showCopied(label); });
  }

  function onNameHover(event) {
    var text = nameTextOf(event);
    if (!text) return;
    var hint = L('Нажмите, чтобы скопировать', 'Click to copy');
    if (text.title !== hint) text.title = hint;
  }

  function setupNameCopy() {
    if (!root.inventoryApp) return false;
    doc.addEventListener('click', onNameClick, true);
    doc.addEventListener('mouseover', onNameHover, true);
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
    var overlayAds = doc.getElementById('afruHideOverlayAds');
    if (overlayAds) overlayAds.checked = getSetting('hideOverlayAds');
    var lang = doc.getElementById('afruLang');
    if (lang) lang.value = LANGUAGES[getSetting('lang')] ? getSetting('lang') : 'ru';
    var hidden = hiddenTabs();
    HIDEABLE_TABS.forEach(function (tab) {
      var box = doc.getElementById('afruTab-' + tab[0]);
      if (box) box.checked = hidden.indexOf(tab[0]) < 0;
    });
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
      el('option', { value: 'graphite' }, ['Графит (нейтральная тёмная)']),
    ]);
    var clearButton = el('button', { 'class': 'buttonSettingsTest', type: 'button' }, ['Сбросить сохранённые цены']);
    var clearStatus = el('span', { 'class': 'afru-settingsStatus', 'aria-live': 'polite' });
    var langSelect = el('select', { id: 'afruLang', 'class': 'settingsSelect' }, [
      el('option', { value: 'ru' }, ['Русский']),
      el('option', { value: 'en' }, ['English (original)']),
      el('option', { value: 'auto' }, ['Как в Windows / Same as Windows']),
    ]);

    var tab = el('div', { id: 'afruSettingsTab', 'class': 'settingsTab', translate: 'no' }, [
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Язык интерфейса / Interface language']),
        el('label', { 'class': 'settingsCheckBoxHolder', 'for': 'afruLang' }, ['Язык:', langSelect]),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'English turns off only the translation: Russian search, prices, the «Где фармить» tab and the other ' +
          'AlecaFrame-RUS features stay. Главное окно перезагрузится, оверлеи переключатся при следующем открытии.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Оформление']),
        el('label', { 'class': 'settingsCheckBoxHolder', 'for': 'afruTheme' }, ['Тема:', themeSelect]),
        checkboxRow('afruThemeOverlays', 'Применять тему к оверлеям в игре', 'indent'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Пока тема AlecaFrame-RUS включена, она заменяет выбранную тему AlecaFrame.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Реклама']),
        checkboxRow('afruCollapseAds', 'Сворачивать рекламный блок в главном окне'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Блок сжимается в узкую полоску со ссылкой на Patreon, освободившееся место занимают таймеры. ' +
          'Пока блок свёрнут, реклама не загружается. Развернуть: кнопка «Показать» на полоске.',
        ]),
        checkboxRow('afruHideOverlayAds', 'Скрывать рекламу в оверлеях (награды реликвий, ривены) и в AFBuilds'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Окно наград показывает только награды и становится уже, рекламный блок не загружается. ' +
          'Действует со следующего открытия оверлея.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Вкладки бокового меню']),
        el('div', { 'class': 'afru-tabList' }, HIDEABLE_TABS
          .filter(function (tab) { return tab[0] === 'afruTabFarm' ? !!menuItem('tabRelicPlanner') : menuItem(tab[0]); })
          .map(function (tab) { return checkboxRow('afruTab-' + tab[0], tab[1]); })),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Снятая галочка убирает вкладку из меню слева. «Литейная» остаётся всегда.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Цены warframe.market']),
        checkboxRow('afruRelicLive', 'Свежие цены наград в окне реликвии с warframe.market'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'При каждом открытии окна наград цены всех наград заново берутся из текущих заказов warframe.market: ' +
          'самый дешёвый продавец в игре. Это тот же клиент, что у кнопки «Обновить цены», он обращается к warframe.market напрямую. ' +
          'Пока ответ в пути (обычно около секунды), видна прежняя цена или средняя за сутки, точка у цены мигает. ' +
          'Зелёная точка: цена свежая. Серая: свежую получить не удалось, причина в подсказке.',
        ]),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Кнопка «Обновить цены» во вкладке «Инвентарь» берёт заказы игроков в игре через встроенный в AlecaFrame ' +
          'клиент warframe.market. Обновлённые цены хранятся 1 час.',
        ]),
        el('div', { 'class': 'settingsCheckBoxHolder' }, [clearButton, clearStatus]),
      ]),
    ]);

    themeSelect.addEventListener('change', function () { setSetting('theme', themeSelect.value); applyTheme(); });
    tab.querySelector('#afruThemeOverlays').addEventListener('change', function (e) { setSetting('themeOverlays', e.target.checked); });
    tab.querySelector('#afruRelicLive').addEventListener('change', function (e) { setSetting('relicLivePrices', e.target.checked); });
    tab.querySelector('#afruCollapseAds').addEventListener('change', function (e) { setAdsCollapsed(e.target.checked); });
    tab.querySelector('#afruHideOverlayAds').addEventListener('change', function (e) { setSetting('hideOverlayAds', e.target.checked); });
    langSelect.addEventListener('change', function () {
      setSetting('lang', langSelect.value);
      try { root.location.reload(); } catch (e) { warn('reload failed', e); }
    });
    HIDEABLE_TABS.forEach(function (item) {
      var box = tab.querySelector('#afruTab-' + item[0]);
      if (box) box.addEventListener('change', function (e) { setTabHidden(item[0], !e.target.checked); });
    });
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
    var button = el('div', { 'class': 'tabHeaderOption', tabid: 'afruSettingsTab', translate: 'no' }, ['AlecaFrame-RUS']);
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

  // Relic rewards that have no orders on warframe.market.
  var UNTRADEABLE_REWARD = /^(\d+\s*x\s*)?forma blueprint$|^riven sliver$|^exilus .*adapter( blueprint)?$|^kuva$|^void traces$/i;

  function rewardsByName(list) {
    var byName = {};
    for (var i = 0; list && i < list.length; i++) {
      var relic = list[i];
      if (!relic || !relic.name || relic.detected === false || UNTRADEABLE_REWARD.test(String(relic.name).trim())) continue;
      (byName[relic.name] = byName[relic.name] || []).push(relic);
    }
    return byName;
  }

  /*
   * Where a reward's price came from: 'live' (orders fetched while this window is open), 'cached' (orders
   * fetched afruAge minutes ago), 'avg' (daily average) or 'af' (AlecaFrame's own price).
   * afruLoading is set while current orders are on their way, afruError when they could not be used.
   */
  function rewardTitle(reward) {
    if (reward.afruSource === 'live') {
      return L('Свежая цена: текущие заказы warframe.market, самый дешёвый продавец в игре. Получена при открытии окна',
        'Fresh price: current warframe.market orders, the cheapest in-game seller. Fetched when this window opened');
    }
    var ago = reward.afruAge > 0 ? L(reward.afruAge + ' мин назад', reward.afruAge + ' min ago') : L('меньше минуты назад', 'under a minute ago');
    var what = reward.afruSource === 'avg' ? L('Средняя цена сделок за сутки на warframe.market', 'Daily average on warframe.market')
      : reward.afruSource === 'cached' ? L('Цена по заказам warframe.market ', 'warframe.market orders ') + ago
      : reward.afruSource === 'af' ? L('Цена AlecaFrame', 'AlecaFrame price')
      : L('Цены пока нет', 'No price yet');
    if (reward.afruLoading) return what + L('. Запрашиваются текущие заказы...', '. Fetching current orders...');
    if (reward.afruError === 'nolistings') return what + L('. Сейчас нет продавцов в игре', '. No in-game sellers right now');
    if (reward.afruError) return what + L('. Текущие заказы получить не удалось', '. Current orders are unavailable');
    return what;
  }

  function markReward(reward, changes) {
    Object.keys(changes).forEach(function (key) { reward['afru' + key] = changes[key]; });
    reward.afruTitle = rewardTitle(reward);
  }

  /** Fills rewards that have no price yet with the daily average. */
  function applyBulkPrices(list) {
    var byName = rewardsByName(list);
    Object.keys(byName).forEach(function (name) {
      var avg = bulkPrice(name);
      if (!avg) return;
      byName[name].forEach(function (reward) {
        if (Number(reward.platinum) > 0) return;
        reward.platinum = avg;
        markReward(reward, { Source: 'avg' });
      });
    });
  }

  // One request per reward name while the window is open: a squad often gets the same part twice.
  var relicRequests = {};

  function relicRequest(name) {
    var known = relicRequests[name];
    if (known && now() - known.at < config.relicRequestReuseMs) return known.promise;
    relicRequests[name] = { at: now(), promise: fetchPrice(name, null) };
    return relicRequests[name].promise;
  }

  /**
   * A price shows at once (an earlier live price, AlecaFrame's own or the daily average). Every time the
   * window opens, each reward is then asked for on warframe.market through the same AlecaFrame client as
   * the Inventory button, and the current orders replace that placeholder.
   */
  function refreshRelicPrices(list) {
    var app = root.relicsApp;
    if (!list || !list.length) return;
    var live = getSetting('relicLivePrices');
    var byName = rewardsByName(list);
    if (live) {
      Object.keys(byName).forEach(function (name) {
        var cached = freshPrice(priceKey(name, null));
        byName[name].forEach(function (reward) {
          if (cached && cached.s != null) {
            reward.platinum = cached.s;
            markReward(reward, { Source: 'cached', Age: Math.floor((now() - cached.t) / 60000), Loading: true });
          } else {
            markReward(reward, { Source: Number(reward.platinum) > 0 ? 'af' : reward.afruSource, Loading: true });
          }
        });
      });
    }
    applyBulkPrices(list);
    if (!bulkPrices || now() - bulkPrices.t >= config.bulkPricesTtlMs) {
      loadBulkPrices().then(function () { if (app.relics === list) applyBulkPrices(list); });
    }
    if (!live) return;
    Object.keys(byName).forEach(function (name) {
      relicRequest(name).then(function (res) {
        if (app.relics !== list) return;
        var entry = res.entry && res.entry.s != null ? res.entry : null;
        byName[name].forEach(function (reward) {
          if (entry) {
            reward.platinum = entry.s;
            markReward(reward, { Source: 'live', Loading: false, Error: '' });
          } else {
            markReward(reward, { Loading: false, Error: res.error || 'nolistings' });
          }
        });
      });
    });
  }

  function L(ru, en) { return root.__AF_RU__ && root.__AF_RU__.active === false ? en : ru; }

  // Added to the reward card template before Vue compiles it (see the plugin hook below).
  function relicInfoTemplate() {
    return '<div class="afru-relicInfo" translate="no">' +
      '<span v-if="relic.afruSource || relic.afruLoading" class="afru-relicSource" role="img" :data-source="relic.afruSource || null" ' +
        ':data-loading="relic.afruLoading ? \'\' : null" :title="relic.afruTitle" :aria-label="relic.afruTitle"></span>' +
      '<span v-if="relic.platinum>0 && relic.ducats>0" class="afru-relicRatio" title="' +
        L('Дукатов за 1 платину. От 10 и выше обычно выгоднее сдать Баро за дукаты', 'Ducats per platinum') + '">' +
        '{{ (relic.ducats / relic.platinum).toFixed(1) }} ' + L('дук/пл', 'duc/pl') + '</span>' +
      '<span v-if="relic.componentData && relic.componentData.length && relic.componentData.some(c => !(c.quantityOwned > 0))" ' +
        'class="afru-relicMissing" title="' + L('Частей комплекта, которых у вас нет', 'Set parts you do not own') + '">' +
        L('нет', 'missing') + ' {{ relic.componentData.filter(c => !(c.quantityOwned > 0)).length }}/{{ relic.componentData.length }}</span>' +
      '</div>';
  }

  function patchRelicTemplate() {
    if (page !== 'relicOverlay' || root.relicsApp) return false;
    var card = doc.querySelector('.relicPart .relicHolder > .relic');
    var prices = card && card.querySelector('.relicItemPrices');
    if (!prices || card.querySelector('.afru-relicInfo')) return false;
    prices.insertAdjacentHTML('afterend', relicInfoTemplate());
    return true;
  }

  // ------------------------------------------------------------- plugin hook

  /*
   * AlecaFrame's scripts each run `var plugin = overwolf.windows.getMainWindow().plugin;`. Every such
   * assignment goes through this setter: the window gets its own wrapper (Russian search) and the hooks
   * run at known moments, in sharedOverwolfStuff.js (whose functions already exist) and at the top of
   * the page's main script (its markup is parsed, Vue is not mounted yet).
   */
  var wrappedPlugins = typeof WeakMap === 'function' ? new WeakMap() : null;
  var adLayoutHooked = false;

  function wrapPlugin(value) {
    var search = root.__AF_RU_SEARCH__;
    if (!value || typeof value.get !== 'function' || !search || !wrappedPlugins || value.__afruWrapper) return value;
    var known = wrappedPlugins.get(value);
    if (known) return known;
    var wrapper = Object.create(value);
    wrapper.get = function () { return search.wrapClient(value.get.apply(value, arguments)); };
    Object.defineProperty(wrapper, '__afruWrapper', { value: true });
    wrappedPlugins.set(value, wrapper);
    return wrapper;
  }

  // With the setting on, the reward and riven windows take the layout AlecaFrame uses when no ad is
  // shown: no ad slot, a narrower window. Read when the window opens.
  function hookAdLayout() {
    if (adLayoutHooked || !AD_LAYOUT_PAGES[page] || typeof root.shouldAdsBeShown !== 'function') return;
    adLayoutHooked = true;
    var original = root.shouldAdsBeShown;
    root.shouldAdsBeShown = function () { return getSetting('hideOverlayAds') ? false : original.apply(this, arguments); };
  }

  function onPluginAssigned() {
    try { hookAdLayout(); } catch (e) { warn('ad layout hook failed', e); }
    try { patchRelicTemplate(); } catch (e) { warn('reward card template failed', e); }
  }

  function watchPlugin() {
    var current = wrapPlugin(root.plugin);
    try {
      Object.defineProperty(root, 'plugin', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (value) { current = wrapPlugin(value); onPluginAssigned(); },
      });
    } catch (e) { warn('cannot watch the plugin', e); }
  }

  // AlecaFrame starts the overlay on window.onload, which also waits for the ad frames, or
  // 350 ms after its script ran. The DOM is complete earlier, at DOMContentLoaded.
  function startRelicWindowEarly() {
    if (typeof root.RelicWindowInitialization !== 'function' || root.relicWindowInitialized) return;
    try { root.RelicWindowInitialization(); } catch (e) { warn('early relic window start failed', e); }
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
    app.$watch('relics', refreshRelicPrices);
    if (app.relics && app.relics.length) refreshRelicPrices(app.relics);
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

  function applyDocumentState() { applyTheme(); applyAdLayout(); applyHiddenTabs(); }

  watchPlugin();
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
    setTabHidden: setTabHidden,
    pickPrices: pickPrices,
    priceKey: priceKey,
    fetchPrice: fetchPrice,
    clearPrices: clearPrices,
    refreshInventoryPrices: refreshInventoryPrices,
    loadBulkPrices: loadBulkPrices,
    bulkPrice: bulkPrice,
    parseBulkPrices: parseBulkPrices,
    patchRelicTemplate: patchRelicTemplate,
    whenReady: whenReady,
    el: el,
    warn: warn,
    page: page,
  };

  if (page === 'main') {
    whenReady([setupInventory, setupNameCopy, setupSettingsTab, setupAdStrip]);
    // Ahead of the first reward screen, so the overlay never waits for it.
    root.setTimeout(function () { loadBulkPrices(); }, 3000);
  }
  else if (page === 'relicOverlay') {
    doc.addEventListener('DOMContentLoaded', startRelicWindowEarly);
    whenReady([setupRelicOverlay]);
  }
})(typeof window !== 'undefined' ? window : null, /*__AF_RU_EXTRAS_CSS__*/ '');
