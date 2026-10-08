import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { bundle } from '../tools/lib.mjs';

const require = createRequire(import.meta.url);
const VUE = fs.readFileSync(require.resolve('vue/dist/vue.global.prod.js'), 'utf8');
const BUNDLE = bundle({ exact: {}, patterns: {} });

function open(page, body, { storage = {}, market } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    url: `http://localhost/web/${page}`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  const calls = [];
  if (market) {
    win.plugin = {
      get: () => ({
        GetBuySellWindowData(name, cb) {
          calls.push(name);
          setTimeout(() => (market[name] ? cb(true, JSON.stringify(market[name]), '[]') : cb(false, 'Listing not found')), 1);
        },
      }),
    };
  }
  win.eval(VUE);
  win.eval(BUNDLE);
  win.__AF_RU_EXTRAS__.config.requestsPerSecond = 1000;
  return { dom, win, doc: win.document, calls };
}

async function waitFor(check, what, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('pickPrices: lowest sell, highest buy, per variant, packs only as a fallback', () => {
  const { win } = open('main.html', '');
  const { pickPrices } = win.__AF_RU_EXTRAS__;
  const plain = pickPrices({
    sellListings: [{ platimun: 15 }, { platimun: 12 }, { platimun: 27, tradeAmount: 3 }, { platimun: 0 }],
    buyListings: [{ platimun: 8 }, { platimun: 10 }],
  }, null);
  assert.deepEqual({ ...plain }, { s: 12, b: 10 });

  const mod = pickPrices({
    sellListings: [{ platimun: 300, specialValue: 10 }, { platimun: 50, specialValue: 0 }, { platimun: 45, specialValue: 0 }],
    buyListings: [{ platimun: 250, specialValue: 10 }],
  }, '0');
  assert.deepEqual({ ...mod }, { s: 45, b: null }, 'rank 10 buy orders must not price a rank 0 mod');

  const relic = pickPrices({ sellListings: [{ platimun: 5, specialValue: 'I' }, { platimun: 20, specialValue: 'R' }] }, 'R');
  assert.equal(relic.s, 20);

  const packsOnly = pickPrices({ sellListings: [{ platimun: 30, tradeAmount: 3 }] }, null);
  assert.equal(packsOnly.s, 10);
  assert.deepEqual({ ...pickPrices({}, null) }, { s: null, b: null });
  win.close();
});

test('theme: applied from settings, optional on overlays, never by default', () => {
  const plain = open('main.html', '');
  assert.equal(plain.doc.documentElement.hasAttribute('data-afru-theme'), false);
  assert.ok(plain.doc.getElementById('afru-extras-style'), 'styles are injected');
  plain.win.close();

  const themed = open('main.html', '', { storage: { 'afru.theme': 'graphite' } });
  assert.equal(themed.doc.documentElement.getAttribute('data-afru-theme'), 'graphite');
  themed.win.close();

  const overlay = open('relicOverlay.html', '', { storage: { 'afru.theme': 'graphite', 'afru.themeOverlays': 'false' } });
  assert.equal(overlay.doc.documentElement.hasAttribute('data-afru-theme'), false);
  overlay.win.close();

  const unknown = open('main.html', '', { storage: { 'afru.theme': 'neon' } });
  assert.equal(unknown.doc.documentElement.hasAttribute('data-afru-theme'), false);
  unknown.win.close();
  });

const AD_BLOCK = `
  <div class="staticRightColumn">
    <div class="adCointainerWithSubscribe adHideable">
      <div id="mainAD" class="mainAD adHideable"><div id="mainADinner" class="adAttr400x300 adHideable"></div></div>
      <div class="subscribeButton GoPremiumCallout adHideable"><div>Remove ads</div></div>
    </div>
  </div>`;

// Same implicit-global assignment as AlecaFrame's startOWADcontainers().
function fakeOwAd(win) {
  win.eval(`currentAd = {
    log: [],
    on: {},
    removeAd() { this.log.push('remove'); },
    refreshAd() { this.log.push('refresh'); },
    addEventListener(type, cb) { (this.on[type] = this.on[type] || []).push(cb); },
  };`);
  const ad = win.currentAd;
  // The log array belongs to the JSDOM realm; deepStrictEqual compares prototypes.
  return { calls: () => [...ad.log], emit: (type) => (ad.on[type] || []).forEach((cb) => cb()) };
}

test('ads: block untouched by default and on other windows', () => {
  const plain = open('main.html', AD_BLOCK);
  assert.equal(plain.doc.documentElement.hasAttribute('data-afru-ads'), false);
  const { calls, emit } = fakeOwAd(plain.win);
  emit('ow_internal_rendered');
  plain.win.currentAd.refreshAd();
  assert.deepEqual(calls(), ['refresh'], 'AlecaFrame keeps full control of the ad');
  plain.win.close();

  const overlay = open('relicOverlay.html', AD_BLOCK, { storage: { 'afru.collapseAds': 'true' } });
  assert.equal(overlay.doc.documentElement.hasAttribute('data-afru-ads'), false);
  overlay.win.close();
});

test('ads: collapsed block stops the ad until it is expanded again', async () => {
  const { win, doc } = open('main.html', AD_BLOCK, { storage: { 'afru.collapseAds': 'true' } });
  assert.equal(doc.documentElement.getAttribute('data-afru-ads'), 'collapsed');
  const { calls, emit } = fakeOwAd(win);
  assert.deepEqual(calls(), [], 'no OwAd calls before it is ready');
  emit('ow_internal_rendered');
  assert.deepEqual(calls(), ['remove']);
  win.currentAd.refreshAd();
  assert.deepEqual(calls(), ['remove'], 'refresh after a modal stays blocked while collapsed');

  await waitFor(() => doc.querySelector('.afru-adExpand'), 'expand button');
  doc.querySelector('.afru-adExpand').click();
  assert.equal(doc.documentElement.hasAttribute('data-afru-ads'), false);
  assert.equal(win.localStorage.getItem('afru.collapseAds'), 'false');
  assert.deepEqual(calls(), ['remove', 'refresh']);

  win.__AF_RU_EXTRAS__.setAdsCollapsed(true);
  assert.equal(doc.documentElement.getAttribute('data-afru-ads'), 'collapsed');
  assert.deepEqual(calls(), ['remove', 'refresh', 'remove']);
  win.close();
});

test('theme: also applied when the script runs before <html> exists', () => {
  const { window: win } = new JSDOM('', { url: 'http://localhost/web/main.html', runScripts: 'outside-only' });
  const doc = win.document;
  win.localStorage.setItem('afru.theme', 'graphite');
  doc.removeChild(doc.documentElement);
  win.eval(BUNDLE);
  doc.appendChild(doc.createElement('html')).appendChild(doc.createElement('head'));
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));
  assert.equal(doc.documentElement.getAttribute('data-afru-theme'), 'graphite');
  assert.ok(doc.getElementById('afru-extras-style'), 'styles are injected');
  win.close();
});

const INVENTORY = `
  <div id="tabInventory">
    <div class="foundryTopSettings"><div class="foundryTopSettingsSide right"><div class="topSetting"><input id="inventorySearch"></div></div></div>
    <div id="inventoryObjectContainer">
      <div v-for="item in items" class="inventoryObject" :key="item.name">
        <div class="inventoryItemName"><span class="normalItem">{{item.name}}</span></div>
        <span class="inventorySellPrice">{{item.sellPrice}}</span>
        <span class="inventoryBuyPrice">{{item.buyPrice}}</span>
      </div>
    </div>
  </div>`;
const ITEMS = [
  { name: 'Ash Prime Neuroptics Blueprint', type: 'part', sellPrice: 20, buyPrice: 5 },
  { name: 'Primed Continuity', type: 'mod', currentModRank: 0, sellPrice: 60, buyPrice: 20 },
  { name: 'Forma Blueprint', type: 'part', sellPrice: 0, buyPrice: 0 },
  { name: 'Ash Prime Neuroptics Blueprint', type: 'part', sellPrice: 20, buyPrice: 5 },
];
const MARKET = {
  'Ash Prime Neuroptics Blueprint': {
    sellListings: [{ platimun: 15 }, { platimun: 12 }],
    buyListings: [{ platimun: 8 }, { platimun: 10 }],
  },
  'Primed Continuity': {
    sellListings: [{ platimun: 300, specialValue: 10 }, { platimun: 45, specialValue: 0 }],
    buyListings: [{ platimun: 250, specialValue: 10 }, { platimun: 30, specialValue: 0 }],
  },
};

test('inventory: «Обновить цены» loads warframe.market prices, marks cards and keeps them across reloads', async () => {
  const { win, doc, calls } = open('main.html', INVENTORY, { market: MARKET });
  win.eval(`inventoryApp = Vue.createApp({ data: () => ({ items: ${JSON.stringify(ITEMS.slice(0, 3))} }) }).mount('#tabInventory')`);
  await waitFor(() => doc.getElementById('afruPriceRefresh'), 'refresh button');
  const chip = doc.getElementById('afruPriceRefresh');
  assert.equal(chip.closest('.foundryTopSettingsSide.right').firstElementChild, chip);
  assert.equal(chip.getAttribute('role'), 'button');

  chip.click();
  assert.equal(chip.getAttribute('data-state'), 'running');
  await waitFor(() => chip.getAttribute('data-state') !== 'running', 'refresh to finish');

  const items = win.inventoryApp.items;
  assert.deepEqual([items[0].sellPrice, items[0].buyPrice], [12, 10]);
  assert.deepEqual([items[1].sellPrice, items[1].buyPrice], [45, 30], 'mod priced at its own rank');
  assert.deepEqual([items[2].sellPrice, items[2].buyPrice], [0, 0], 'items without listings keep AlecaFrame prices');
  assert.deepEqual(calls, ['Ash Prime Neuroptics Blueprint', 'Primed Continuity', 'Forma Blueprint']);
  assert.match(chip.querySelector('.afru-chipMeta').textContent, /^\d\d:\d\d$/);
  assert.match(chip.title, /Без заказов на warframe\.market: 1/);

  await waitFor(() => doc.querySelectorAll('[data-afru-fresh]').length === 2, 'fresh markers');
  const cards = doc.querySelectorAll('.inventoryObject');
  assert.equal(cards[0].querySelector('.inventorySellPrice').textContent, '12');
  assert.equal(cards[2].hasAttribute('data-afru-fresh'), false);
  assert.ok(JSON.parse(win.localStorage.getItem('afru.prices'))['primed continuity|0']);

  // AlecaFrame replaces the list on every filter change: cached prices come back without new requests.
  win.inventoryApp.items = JSON.parse(JSON.stringify(ITEMS));
  await waitFor(() => win.inventoryApp.items[3].sellPrice === 12, 'cached prices on the new list');
  assert.equal(calls.length, 3);
  win.close();
});

const ORDERING = (value) => `<select id="inventoryOrdering"><option value="name">Name</option><option value="platPrice">Platinum</option></select>`
  .replace(`value="${value}"`, `value="${value}" selected`);
const SORT_ITEMS = [
  { name: 'Alternox Prime Stock', type: 'part', sellPrice: 14 },
  { name: 'Nova Prime Systems Blueprint', type: 'part', sellPrice: 10 },
  { name: 'Vasto Prime Barrel', type: 'part', sellPrice: 9 },
  { name: 'Forma Blueprint', type: 'part', sellPrice: 0 },
  { name: 'Corufell Prime Stock', type: 'part', sellPrice: 5 },
];
const SORT_MARKET = {
  'Alternox Prime Stock': { sellListings: [{ platimun: 9 }] },
  'Nova Prime Systems Blueprint': { sellListings: [{ platimun: 13 }] },
  'Corufell Prime Stock': { sellListings: [{ platimun: 11 }] },
};
const names = (win) => [...win.inventoryApp.items].map((i) => i.name);

test('inventory: sorted by platinum, the list follows the refreshed sell prices', async () => {
  const { win, doc } = open('main.html', ORDERING('platPrice') + INVENTORY, { market: SORT_MARKET });
  win.eval(`var orderedLargerToSmaller = true; inventoryApp = Vue.createApp({ data: () => ({ items: ${JSON.stringify(SORT_ITEMS)} }) }).mount('#tabInventory')`);
  await waitFor(() => doc.getElementById('afruPriceRefresh'), 'refresh button');
  await win.__AF_RU_EXTRAS__.refreshInventoryPrices();
  assert.deepEqual(names(win), [
    'Nova Prime Systems Blueprint', // 13
    'Corufell Prime Stock', // 11
    'Alternox Prime Stock', // 9, listed before Vasto by AlecaFrame
    'Vasto Prime Barrel', // 9
    'Forma Blueprint', // no price: last
  ]);
  await waitFor(() => doc.querySelectorAll('[data-afru-fresh]').length === 3, 'fresh markers after sorting');
  const cards = [...doc.querySelectorAll('.inventoryObject')];
  assert.deepEqual(cards.map((c) => c.querySelector('.inventorySellPrice').textContent), ['13', '11', '9', '9', '0']);
  assert.deepEqual(cards.map((c) => c.hasAttribute('data-afru-fresh')), [true, true, true, false, false]);

  // AlecaFrame reloads the list sorted by its old prices; the cached ones put it back in order.
  win.inventoryApp.items = JSON.parse(JSON.stringify(SORT_ITEMS));
  await waitFor(() => names(win)[0] === 'Nova Prime Systems Blueprint', 'order restored on reload');
  assert.equal(names(win)[1], 'Corufell Prime Stock');

  // Smallest first when AlecaFrame's direction toggle is reversed; unpriced items still go last.
  win.orderedLargerToSmaller = false;
  win.inventoryApp.items = JSON.parse(JSON.stringify(SORT_ITEMS));
  await waitFor(() => names(win)[0] === 'Alternox Prime Stock', 'ascending order');
  assert.deepEqual(names(win).slice(-2), ['Nova Prime Systems Blueprint', 'Forma Blueprint']);
  win.close();
});

test('inventory: other orderings are left as AlecaFrame sorted them', async () => {
  const { win, doc } = open('main.html', ORDERING('name') + INVENTORY, { market: SORT_MARKET });
  win.eval(`inventoryApp = Vue.createApp({ data: () => ({ items: ${JSON.stringify(SORT_ITEMS)} }) }).mount('#tabInventory')`);
  await waitFor(() => doc.getElementById('afruPriceRefresh'), 'refresh button');
  await win.__AF_RU_EXTRAS__.refreshInventoryPrices();
  assert.deepEqual(names(win), SORT_ITEMS.map((i) => i.name));
  assert.equal(win.inventoryApp.items[1].sellPrice, 13);
  win.close();
});

test('inventory: reports a missing market client instead of failing silently', async () => {
  const { win, doc } = open('main.html', INVENTORY);
  win.eval(`inventoryApp = Vue.createApp({ data: () => ({ items: ${JSON.stringify(ITEMS.slice(0, 2))} }) }).mount('#tabInventory')`);
  await waitFor(() => doc.getElementById('afruPriceRefresh'), 'refresh button');
  const chip = doc.getElementById('afruPriceRefresh');
  await win.__AF_RU_EXTRAS__.refreshInventoryPrices();
  assert.equal(chip.getAttribute('data-state'), 'error');
  assert.equal(chip.querySelector('.afru-chipMeta').textContent, 'нет связи');
  assert.equal(win.inventoryApp.items[0].sellPrice, 20);
  win.close();
});

const SETTINGS = `
  <div id="modalSettings">
    <div class="mainTabHeader"><div class="tabHeaderOption selected" tabid="generalSettingsTab">General</div></div>
    <div class="mainTabBody"><div id="generalSettingsTab" class="settingsTab shown"></div></div>
  </div>`;

test('settings: AlecaFrame-RU tab switches the theme for this and other windows', async () => {
  const { win, doc } = open('main.html', SETTINGS);
  win.settingsApp = {};
  await waitFor(() => doc.getElementById('afruSettingsTab'), 'settings tab');
  const button = doc.querySelector('[tabid="afruSettingsTab"]');
  button.click();
  assert.ok(doc.getElementById('afruSettingsTab').classList.contains('shown'));
  assert.equal(doc.getElementById('generalSettingsTab').classList.contains('shown'), false);
  assert.equal(doc.getElementById('afruRelicLive').checked, true);

  const select = doc.getElementById('afruTheme');
  select.value = 'graphite';
  select.dispatchEvent(new win.Event('change'));
  assert.equal(doc.documentElement.getAttribute('data-afru-theme'), 'graphite');
  assert.equal(win.localStorage.getItem('afru.theme'), 'graphite');

  win.localStorage.setItem('afru.theme', 'default');
  win.dispatchEvent(new win.StorageEvent('storage', { key: 'afru.theme' }));
  assert.equal(doc.documentElement.hasAttribute('data-afru-theme'), false, 'storage events from other windows apply too');
  assert.equal(select.value, 'default');
  win.close();
});

const MENU = `
  <div class="topMenuGroup">
    <div class="menuItem selected" tabId="tabFoundry">Foundry</div>
    <div class="menuItem" tabId="tabInventory">Inventory</div>
    <div class="menuItem" tabId="proAnalyticsTab">Trading Analytics</div>
    <div class="menuItem" tabId="tabStats">Stats</div>
  </div>`;

test('side menu: tabs hidden in settings disappear, the open one falls back to Foundry', async () => {
  const { win, doc } = open('main.html', MENU + SETTINGS, { storage: { 'afru.hiddenTabs': 'tabStats,unknownTab' } });
  // AlecaFrame's onclick="menuPressed(event)"; inline handlers do not run in this JSDOM mode.
  win.eval(`document.querySelectorAll('.menuItem').forEach((item) => item.addEventListener('click', (e) => {
    document.querySelectorAll('.menuItem').forEach((m) => m.classList.toggle('selected', m === e.currentTarget));
  }));`);
  win.settingsApp = {};
  await waitFor(() => doc.getElementById('afruSettingsTab'), 'settings tab');
  const rule = () => doc.getElementById('afru-hidden-tabs').textContent;
  const hidden = () => [...doc.querySelectorAll('.menuItem')].filter((m) => rule() && m.matches(rule().replace(/\s*\{[^}]*\}\s*$/, ''))).map((m) => m.getAttribute('tabid'));
  assert.deepEqual(hidden(), ['tabStats']);
  assert.match(rule(), /display: none !important/);

  const boxes = [...doc.querySelectorAll('.afru-tabList input')].map((b) => [b.id, b.checked]);
  assert.deepEqual(boxes, [['afruTab-tabInventory', true], ['afruTab-proAnalyticsTab', true], ['afruTab-tabStats', false]], 'only tabs present in this AlecaFrame version are listed');

  doc.querySelector('[tabid="proAnalyticsTab"]').click();
  assert.equal(doc.querySelector('.menuItem.selected').getAttribute('tabid'), 'proAnalyticsTab');
  const analytics = doc.getElementById('afruTab-proAnalyticsTab');
  analytics.checked = false;
  analytics.dispatchEvent(new win.Event('change'));
  assert.deepEqual(hidden(), ['proAnalyticsTab', 'tabStats']);
  assert.equal(win.localStorage.getItem('afru.hiddenTabs'), 'tabStats,proAnalyticsTab');
  assert.equal(doc.querySelector('.menuItem.selected').getAttribute('tabid'), 'tabFoundry', 'the hidden open tab is left');

  win.localStorage.setItem('afru.hiddenTabs', '');
  win.dispatchEvent(new win.StorageEvent('storage', { key: 'afru.hiddenTabs' }));
  assert.equal(rule(), '');
  assert.equal(doc.getElementById('afruTab-tabStats').checked, true);
  win.close();
});

const RELICS = `
  <div class="relicPart"><div class="relicHolder">
    <div v-for="relic in relics" class="relic" :class="{ relicMaxPrice: relicMaxPrice(relic) }" :data-name="relic.name">{{ relic.platinum }}</div>
  </div></div>`;
const RELIC_APP = `relicsApp = Vue.createApp({
  data: () => ({ relics: [] }),
  methods: { relicMaxPrice(relic) { return relic.platinum >= Math.max.apply(Math, relicsApp.relics.map(p => p.platinum)); } },
}).mount('.relicPart')`;

test('relic overlay: no "best" highlight without prices, live prices move it', async () => {
  const market = { 'Braton Prime Receiver': { sellListings: [{ platimun: 18 }, { platimun: 21 }] } };
  const { win, doc, calls } = open('relicOverlay.html', RELICS, { market });
  win.eval(RELIC_APP);
  // Rendered by AlecaFrame's own method first: every unknown (-1) price counts as the best.
  win.relicsApp.relics = [{ name: 'Forma Blueprint', platinum: -1, detected: true }, { name: 'Lith A1 Relic', platinum: -1, detected: true }];
  await waitFor(() => doc.querySelectorAll('.relicMaxPrice').length === 2, 'original highlight');

  await waitFor(() => win.__AF_RU_EXTRAS__.ready.setupRelicOverlay, 'relic overlay hooks');
  await waitFor(() => calls.length === 1, 'live price requests');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['Lith A1 Relic'], 'Forma has no orders and is not requested');
  assert.equal(doc.querySelectorAll('.relicMaxPrice').length, 0);

  win.relicsApp.relics = [
    { name: 'Nikana Prime Blueprint', platinum: 11, detected: true },
    { name: 'Braton Prime Receiver', platinum: 6, detected: true },
    { name: 'Forma Blueprint', platinum: -1, detected: false },
  ];
  await waitFor(() => doc.querySelector('.relicMaxPrice')?.dataset.name === 'Braton Prime Receiver', 'highlight on the live best price');
  assert.equal(win.relicsApp.relics[1].platinum, 18);
  assert.equal(win.relicsApp.relics[0].platinum, 11, 'rewards without listings keep their price');
  assert.ok(!calls.slice(2).includes('Forma Blueprint'), 'undetected rewards are not requested');
  win.close();
});

test('relic overlay: distinct rewards are requested together, cached ones show at once', async () => {
  const { win, doc } = open('relicOverlay.html', RELICS, {
    storage: {
      'afru.prices': JSON.stringify({
        'fresh part|': { s: 40, b: 30, t: Date.now() - 60 * 1000 },
        'stale part|': { s: 7, b: 5, t: Date.now() - 30 * 60 * 1000 },
      }),
    },
  });
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const prices = { 'Stale Part': 9, 'Part A': 15, 'Part B': 25, 'Part C': 35, 'Part D': 45 };
  win.plugin = {
    get: () => ({
      GetBuySellWindowData(name, cb) {
        calls.push(name);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        setTimeout(() => { inFlight--; cb(true, JSON.stringify({ sellListings: [{ platimun: prices[name] }] }), '[]'); }, 40);
      },
    }),
  };
  win.eval(RELIC_APP);
  await waitFor(() => win.__AF_RU_EXTRAS__.ready.setupRelicOverlay, 'relic overlay hooks');
  win.relicsApp.relics = [
    { name: 'Fresh Part', platinum: 1, detected: true },
    { name: 'Stale Part', platinum: 1, detected: true },
    { name: 'Part A', platinum: 1, detected: true },
    { name: 'Part A', platinum: 1, detected: true },
  ];
  const rewards = () => win.relicsApp.relics.map((r) => r.platinum);
  // Vue runs the watcher before the next render, so the first frame already has these.
  await win.relicsApp.$nextTick();
  assert.deepEqual([...doc.querySelectorAll('.relic')].map((r) => r.textContent.trim()), ['40', '7', '1', '1'], 'cached prices replace AlecaFrame ones right away');
  await waitFor(() => rewards()[3] === 15, 'live prices');
  assert.deepEqual(rewards(), [40, 9, 15, 15]);
  assert.deepEqual(calls, ['Stale Part', 'Part A'], 'one request per distinct stale reward');

  calls.length = 0;
  win.relicsApp.relics = ['Part B', 'Part C', 'Part D', 'Part E'].map((name) => ({ name, platinum: 1, detected: true }));
  await waitFor(() => calls.length === 4, 'four requests');
  assert.equal(maxInFlight, 3, 'up to three requests run at the same time');
  await waitFor(() => win.relicsApp.relics[2].platinum === 45, 'the fourth price');
  assert.equal(doc.querySelector('.relicMaxPrice')?.dataset.name, 'Part D');
  win.close();
});

test('relic overlay: AlecaFrame start is not delayed until window.onload', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/web/relicOverlay.html', runScripts: 'outside-only' });
  const win = dom.window;
  win.eval(BUNDLE);
  win.eval('var relicWindowInitialized = false; var started = 0; function RelicWindowInitialization() { if (relicWindowInitialized) return; relicWindowInitialized = true; started++; } window.onload = RelicWindowInitialization;');
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  assert.equal(win.eval('started'), 1);
  win.dispatchEvent(new win.Event('load'));
  assert.equal(win.eval('started'), 1, 'the later onload call is skipped by AlecaFrame itself');
  win.close();
});

test('relic overlay: live prices can be turned off', async () => {
  const market = { 'Braton Prime Receiver': { sellListings: [{ platimun: 18 }] } };
  const { win, calls } = open('relicOverlay.html', RELICS, { market, storage: { 'afru.relicLivePrices': 'false' } });
  win.eval(RELIC_APP);
  await waitFor(() => win.__AF_RU_EXTRAS__.ready.setupRelicOverlay, 'relic overlay hooks');
  win.relicsApp.relics = [{ name: 'Braton Prime Receiver', platinum: 6, detected: true }];
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, []);
  assert.equal(win.relicsApp.relics[0].platinum, 6);
  win.close();
});
