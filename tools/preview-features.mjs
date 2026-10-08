// Shows AlecaFrame-RU's own features on the real AlecaFrame pages with mock game data
// in headless Chrome: the inventory price refresh, the settings tab, the «Графит» theme
// and the relic reward overlay (rewards, live prices, unknown prices, unsupported language).
// Usage: node tools/preview-features.mjs <AlecaFrame dir> [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, OVERWOLF_STUB, collectOverflows, serveStatic, webDirOf } from './harness.mjs';

const appDir = path.resolve(process.argv[2] ?? 'vendor/AlecaFrame');
const outDir = path.resolve(process.argv[3] ?? 'preview-out/features');
const bundlePath = path.resolve('dist/alecaframe-ru.js');
fs.mkdirSync(outDir, { recursive: true });

const part = (name, extra) => ({ name, internalName: name, type: 'part', amountOwned: 1, ducats: 45, modUsedBy: '', vualtedMakesSense: true, vaulted: true, ...extra });
const INVENTORY = [
  part('Ash Prime Neuroptics Blueprint', { amountOwned: 2, sellPrice: 9, buyPrice: 5 }),
  part('Braton Prime Receiver', { sellPrice: 6, buyPrice: 3 }),
  part('Nikana Prime Blueprint', { ducats: 25, sellPrice: 11, buyPrice: 7, vaulted: false }),
  part('Galatine Prime Handle', { amountOwned: 3, sellPrice: 4, buyPrice: 2 }),
  { name: 'Primed Continuity', internalName: 'pc', type: 'mod', modType: 'legendary', currentModRank: 0, modRankMax: 10, amountOwned: 1, sellPrice: 40, buyPrice: 25, modUsedBy: '' },
  { name: 'Arcane Energize', internalName: 'ae', type: 'arcane', currentModRank: 0, modRankMax: 5, amountOwned: 2, sellPrice: 22, buyPrice: 15, modUsedBy: '', picture: 'assets/img/arcane.png' },
  { name: 'Lith A1 Relic', internalName: 'la1', type: 'relic', isRelic: true, amountOwned: 6, sellPrice: 3, buyPrice: 1, modUsedBy: '', picture: 'assets/img/axi-intact.png' },
  part('Forma Blueprint', { ducats: 0, sellPrice: 0, buyPrice: 0, vualtedMakesSense: false }),
];
// Lowest live sell / highest live buy order; mods and relics also have orders for other variants.
const MARKET = {
  'Ash Prime Neuroptics Blueprint': { sell: [14, 15, 17], buy: [10, 8] },
  'Braton Prime Receiver': { sell: [18, 19, 20], buy: [12] },
  'Nikana Prime Blueprint': { sell: [10, 12], buy: [6] },
  'Galatine Prime Handle': { sell: [5, 6], buy: [3] },
  'Primed Continuity': { sell: [45, 48], buy: [30], other: { sell: 290, buy: 240, specialValue: 10 }, specialValue: 0 },
  'Arcane Energize': { sell: [24, 26], buy: [18], other: { sell: 160, buy: 130, specialValue: 5 }, specialValue: 0 },
  'Lith A1 Relic': { sell: [4, 5], buy: [2], other: { sell: 12, buy: 8, specialValue: 'R' }, specialValue: 'I' },
};
const reward = (name, platinum, ducats, extra) => ({ name, platinum, ducats, isItemVaulted: true, isFav: false, isPartOfOwned: true, countOwned: '1', totalToOwn: '1', componentData: [], setPlat: -1, detected: true, ...extra });
const REWARDS = [
  reward('Ash Prime Neuroptics Blueprint', 9, 45, { countOwned: '2' }),
  reward('Braton Prime Receiver', 6, 45, { isPartOfOwned: false, countOwned: '0' }),
  reward('Forma Blueprint', -1, -1, { isItemVaulted: false }),
  reward('Nikana Prime Blueprint', 11, 25, { isItemVaulted: false }),
];
const RELIC_RESULTS = {
  rewards: [true, { relicRewards: REWARDS, globalData: { platinum: 1435, ducats: 3120 } }],
  unknown: [true, { relicRewards: REWARDS.map((r) => ({ ...r, platinum: -1 })), globalData: { platinum: 1435, ducats: 3120 } }],
  language: [false, 'Unsupported Warframe language detected. For the time being, only English, French, Spanish and German are supported.'],
};

function mockScript({ relic = 'rewards', storage = {} }) {
  const [ok, data] = RELIC_RESULTS[relic];
  return `(() => {
    localStorage.clear();
    for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v);
    const INVENTORY = ${JSON.stringify(INVENTORY)};
    const MARKET = ${JSON.stringify(MARKET)};
    const listing = (platimun, specialValue, i) => ({ platimun, specialValue, playerName: 'Tenno' + i, tradeAmount: 1, amount: 1 });
    const later = (fn, ms) => setTimeout(fn, ms);
    window.__AFRU_MOCK__ = {
      plugin: {
        getFilteredInventory: (filter, all, cb) => later(() => cb(true, JSON.stringify(INVENTORY), '1 435', '96'), 30),
        GetBuySellWindowData: (name, cb) => later(() => {
          const m = MARKET[name];
          if (!m) { cb(false, 'Listing not found', '[]'); return; }
          const side = (prices, other) => prices.map((p, i) => listing(p, m.specialValue, i)).concat(m.other ? [listing(other, m.other.specialValue, 9)] : []);
          cb(true, JSON.stringify({ sellListings: side(m.sell, m.other && m.other.sell), buyListings: side(m.buy, m.other && m.other.buy), postingSettings: { readableName: name } }), '[]');
        }, 120),
        GetRelicWindowData: (testing, cb) => later(() => cb(${ok}, ${JSON.stringify(typeof data === 'string' ? data : JSON.stringify(data))}, '60'), 150),
      },
      overwolf: {
        windows: {
          getCurrentWindow: (cb) => cb({ success: true, window: { id: 'w', monitorId: 'm1' } }),
          changeSize: (o, cb) => cb && cb({ success: true }),
          changePosition: (id, l, t, cb) => cb && cb({ success: true }),
        },
        utils: { getMonitorsList: (cb) => cb({ displays: [{ id: 'm1', dpiY: 96 }] }) },
        games: { getRunningGameInfo2: (cb) => cb({ success: true, gameInfo: { logicalWidth: 1920, logicalHeight: 1080 } }) },
      },
    };
  })();`;
}

const server = await serveStatic(webDirOf(appDir));
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const report = [];

async function openPage(file, { viewport, russian = true, ...mock }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('**/*', (route) => (route.request().url().startsWith(server.base) ? route.continue() : route.abort()));
  await ctx.addInitScript(mockScript(mock));
  await ctx.addInitScript(OVERWOLF_STUB);
  if (russian) await ctx.addInitScript({ path: bundlePath });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.base}/${file}`, { waitUntil: 'load' });
  return { ctx, page, errors };
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

async function mainWindow(theme) {
  const { ctx, page, errors } = await openPage('main.html', { viewport: { width: 1770, height: 800 }, storage: { 'afru.theme': theme } });
  await page.addStyleTag({ content: '#loadingScreen { display: none !important; }' });
  await page.waitForFunction(() => window.__AF_RU_EXTRAS__?.ready.setupInventory && window.__AF_RU_EXTRAS__.ready.setupSettingsTab);
  await page.locator('.menuItem[tabId="tabInventory"]').click({ force: true });
  await page.evaluate(() => window.inventoryApp.refresh());
  await page.waitForFunction(() => window.inventoryApp.items.length > 0);
  await page.waitForTimeout(400);
  await shot(page, `${theme}-inventory`);

  await page.click('#afruPriceRefresh');
  await page.waitForTimeout(700);
  await shot(page, `${theme}-inventory-running`);
  await page.waitForFunction(() => document.getElementById('afruPriceRefresh').dataset.state !== 'running', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  await shot(page, `${theme}-inventory-refreshed`);
  const prices = await page.evaluate(() => window.inventoryApp.items.map((i) => `${i.name}: ${i.sellPrice}/${i.buyPrice}`));
  const chip = await page.evaluate(() => { const c = document.getElementById('afruPriceRefresh'); return `${c.textContent.trim()} — ${c.title}`; });

  await page.evaluate(() => window.settingsApp.open());
  await page.waitForTimeout(300);
  await page.click('[tabid="afruSettingsTab"]');
  await page.waitForTimeout(200);
  await shot(page, `${theme}-settings`);
  await page.click('[tabid="generalSettingsTab"]');
  await page.waitForTimeout(200);
  await shot(page, `${theme}-settings-general`);
  await page.evaluate(() => { window.settingsApp.visible = false; });
  await page.locator('.menuItem[tabId="tabFoundry"]').click({ force: true });
  await page.waitForTimeout(300);
  await shot(page, `${theme}-foundry`);

  report.push(`## main.html, theme=${theme} (page errors: ${errors.length})`, `  chip: ${chip}`, ...prices.map((p) => `  ${p}`));
  report.push(...errors.map((e) => `  page error: ${e.split('\n')[0]}`));
  await ctx.close();
}

async function relicOverlay(name, { russian = true, theme = 'default', live = true, relic = 'rewards' } = {}) {
  // 1920x1080 game with ads shown: AlecaFrame sizes the window to 1420x355.
  const storage = { 'afru.theme': theme, 'afru.relicLivePrices': String(live) };
  const { ctx, page, errors } = await openPage('relicOverlay.html', { viewport: { width: 1420, height: 355 }, russian, relic, storage });
  await page.waitForFunction(() => window.relicsApp && !window.relicsApp.loading);
  await page.waitForTimeout(live ? 1200 : 300);
  await shot(page, `relic-${name}`);
  const state = await page.evaluate(() => ({
    best: [...document.querySelectorAll('.relic')].map((r, i) => (r.classList.contains('relicMaxPrice') ? i : -1)).filter((i) => i >= 0),
    prices: window.relicsApp.relics.map((r) => r.platinum),
    error: window.relicsApp.error ? document.querySelector('.inventoryBuySellTabOverlayError')?.textContent.trim() : '',
  }));
  const overflows = await page.evaluate(collectOverflows);
  report.push(`## relic-${name}: highlighted=${JSON.stringify(state.best)} platinum=${JSON.stringify(state.prices)} page errors=${errors.length}`);
  if (state.error) report.push(`  error box: ${state.error}`);
  report.push(...errors.map((e) => `  page error: ${e.split('\n')[0]}`));
  for (const o of overflows) report.push(`  overflow +${o.over}px  ${o.text}  ::  ${o.path}`);
  await ctx.close();
  return overflows;
}

await mainWindow('default');
await mainWindow('graphite');
await relicOverlay('en-original', { russian: false, live: false });
await relicOverlay('ru', { live: false });
await relicOverlay('ru-live');
await relicOverlay('en-original-unknown', { russian: false, live: false, relic: 'unknown' });
await relicOverlay('ru-unknown', { live: false, relic: 'unknown' });
await relicOverlay('en-original-language', { russian: false, live: false, relic: 'language' });
await relicOverlay('ru-language', { live: false, relic: 'language' });
await relicOverlay('ru-graphite-live', { theme: 'graphite' });

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'report.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
