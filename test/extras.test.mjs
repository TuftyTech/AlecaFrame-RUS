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
  win.__AF_RU_EXTRAS__.config.requestGapMs = 0;
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
  await waitFor(() => calls.length === 2, 'live price requests');
  await new Promise((r) => setTimeout(r, 20));
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
