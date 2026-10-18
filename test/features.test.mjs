import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { bundle } from '../tools/lib.mjs';

const require = createRequire(import.meta.url);
const VUE = fs.readFileSync(require.resolve('vue/dist/vue.global.prod.js'), 'utf8');
const ITEMS = {
  Ash: 'Эш',
  'Ash Prime Set': 'Эш Прайм: Комплект',
  'Ash Prime Systems Blueprint': 'Эш Прайм: Система (Чертёж)',
  'Flash Accelerator': 'Ускоритель вспышки',
  'Nova Prime Chassis Blueprint': 'Нова Прайм: Каркас (Чертёж)',
  'Nova Prime Systems Blueprint': 'Нова Прайм: Система (Чертёж)',
  'Nekros Prime Set': 'Некрос Прайм: Комплект',
  'Lith A1 Relic': 'Реликвия Лит A1',
  'Meso B2 Relic': 'Реликвия Мезо B2',
  Soma: 'Сома',
};
const BUNDLE = bundle({ exact: { Search: 'Поиск' }, patterns: {}, items: ITEMS });

function open(page, body = '', { storage = {}, before } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    url: `http://localhost/web/${page}`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  if (before) before(win);
  win.eval(VUE);
  win.eval(BUNDLE);
  return { win, doc: win.document };
}

async function waitFor(check, what, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A plugin like AlecaFrame's: a shared object whose get() returns the C# instance. */
function fakePlugin(results) {
  const calls = [];
  const instance = {
    getFilteredInventory(filter, all, cb) { calls.push(['getFilteredInventory', filter]); cb(true, JSON.stringify(results), 0, 0); },
    GetWFMarketSearchSuggestions(query, cb) { calls.push(['GetWFMarketSearchSuggestions', query]); cb(true, JSON.stringify(results)); },
    GetBuySellWindowData(name, cb) { calls.push(['GetBuySellWindowData', name]); cb(false, 'none'); },
    onRelicPlannerUpdate: { addListener() {} },
  };
  return { shared: { get: () => instance, initialized: () => true }, instance, calls };
}

test('search: a Russian query reaches AlecaFrame as the English fragment of the same items', () => {
  const { win } = open('main.html');
  const plan = win.__AF_RU_SEARCH__.plan;
  assert.equal(plan('нова прайм каркас').fragment, 'Nova Prime Chassis Blueprint');
  assert.equal(plan('нова система').fragment, 'Nova Prime Systems Blueprint');
  assert.equal(plan('лит а1').fragment, 'Lith A1 Relic', 'relic codes typed with Russian letters');
  assert.equal(plan('Нова').fragment.toLowerCase().startsWith('nova'), true);
  assert.equal(plan('Nova Prime'), null, 'English queries pass as typed');
  assert.equal(plan('ytrhjc').fragment.startsWith('Nekros'), true, 'English keyboard layout');
  assert.equal(plan('ыщьф').fragment, 'soma', 'Russian keyboard layout for an English name');
  assert.equal(plan('абвгд'), null, 'nothing matches: left as typed');
  win.close();
});

test('search: the window wrapper rewrites the filter and drops accidental matches, the shared plugin stays as it was', () => {
  const plugin = fakePlugin([{ name: 'Ash Prime Set' }, { name: 'Flash Accelerator' }, { name: 'Ash Skin' }, { amount: 3 }]);
  const { win } = open('main.html', '', { before: (w) => { w.plugin = plugin.shared; } });
  // AlecaFrame's scripts assign it again: `var plugin = overwolf.windows.getMainWindow().plugin;`
  win.plugin = plugin.shared;
  assert.notEqual(win.plugin, plugin.shared);
  assert.equal(plugin.shared.get(), plugin.instance, 'the shared object is untouched');
  assert.equal(win.plugin.initialized(), true);

  let names = null;
  win.plugin.get().getFilteredInventory(JSON.stringify({ type: 'allParts', search: 'эш', order: 'name' }), true, (ok, data) => {
    names = JSON.parse(data).map((i) => i.name);
  });
  const filter = JSON.parse(plugin.calls[0][1]);
  assert.equal(filter.search.toLowerCase(), 'ash');
  assert.equal(filter.order, 'name', 'other filter fields are kept');
  assert.deepEqual(names, ['Ash Prime Set', 'Ash Skin', undefined], '"Flash" is dropped, unknown shapes are kept');

  win.plugin.get().GetWFMarketSearchSuggestions('некрос', () => {});
  assert.equal(plugin.calls[1][1], 'Nekros Prime Set');
  win.plugin.get().getFilteredInventory(JSON.stringify({ search: 'Braton' }), true, () => {});
  assert.equal(JSON.parse(plugin.calls[2][1]).search, 'Braton');
  assert.equal(typeof win.plugin.get().onRelicPlannerUpdate.addListener, 'function', 'non-function members pass through');
  win.close();
});

const RELICS = `
  <div class="relicPart"><div class="relicHolder">
    <div v-for="relic in relics" class="relic" :data-name="relic.name">
      <div class="relicItemPrices"><span class="plat">{{ relic.platinum }}</span></div>
    </div>
  </div></div>`;
const RELIC_APP = `relicsApp = Vue.createApp({
  data: () => ({ relics: [] }),
  methods: { relicMaxPrice() { return false; } },
}).mount('.relicPart')`;

test('relic overlay: daily prices show at once, the card gets ducats per platinum and missing parts', async () => {
  const bulk = { t: Date.now(), p: { 'nova prime chassis blueprint': 12, 'braton prime barrel': 4 } };
  const { win, doc } = open('relicOverlay.html', RELICS, { storage: { 'afru.bulkPrices': JSON.stringify(bulk), 'afru.relicLivePrices': 'false' } });
  // The page's main script assigns the plugin before it mounts Vue: the card template is extended then.
  win.plugin = fakePlugin([]).shared;
  assert.ok(doc.querySelector('.relic .afru-relicInfo'), 'template extended before mount');
  win.eval(RELIC_APP);
  win.relicsApp.relics = [
    { name: 'Nova Prime Chassis', platinum: -1, ducats: 45, detected: true, componentData: [{ quantityOwned: 1 }, { quantityOwned: 0 }, { quantityOwned: 0 }] },
    { name: 'Braton Prime Barrel', platinum: 9, ducats: 15, detected: true },
    { name: 'Forma Blueprint', platinum: -1, ducats: -1, detected: true },
  ];
  await waitFor(() => win.__AF_RU_EXTRAS__.ready.setupRelicOverlay, 'relic overlay hooks');
  await waitFor(() => doc.querySelector('.relic .plat')?.textContent === '12', 'daily price');
  const [nova, braton, forma] = doc.querySelectorAll('.relic');
  assert.equal(win.relicsApp.relics[0].afruSource, 'avg');
  const dot = nova.querySelector('.afru-relicSource');
  assert.equal(dot.dataset.source, 'avg');
  assert.equal(dot.hasAttribute('data-loading'), false);
  assert.equal(dot.getAttribute('title'), 'Средняя цена сделок за сутки на warframe.market');
  assert.equal(nova.querySelector('.afru-relicRatio').textContent.trim(), '3.8 дук/пл');
  assert.equal(nova.querySelector('.afru-relicMissing').textContent.trim(), 'нет 2/3');
  assert.equal(braton.querySelector('.plat').textContent, '9', 'AlecaFrame prices are kept');
  assert.equal(braton.querySelector('.afru-relicSource'), null);
  assert.equal(forma.querySelector('.plat').textContent, '-1');
  win.close();
});

test('relic overlay: daily prices are parsed from the WFInfo list', () => {
  const { win } = open('main.html');
  const parsed = win.__AF_RU_EXTRAS__.parseBulkPrices([
    { name: 'Frost Prime Set', custom_avg: '76.1' }, { name: 'Bad', custom_avg: 'x' }, { name: 'Zero', custom_avg: '0' },
  ]);
  assert.deepEqual({ ...parsed }, { 'frost prime set': 76 });
  win.close();
});

test('overlay ads: hidden only with the setting, only in overlay windows', () => {
  const shouldAds = (page, storage) => {
    const { win } = open(page, '', { storage });
    win.eval('function shouldAdsBeShown() { return true; }');
    win.plugin = fakePlugin([]).shared;
    const result = win.shouldAdsBeShown();
    win.close();
    return result;
  };
  assert.equal(shouldAds('relicOverlay.html', {}), true, 'off by default');
  assert.equal(shouldAds('relicOverlay.html', { 'afru.hideOverlayAds': 'true' }), false);
  assert.equal(shouldAds('rivenOverlay.html', { 'afru.hideOverlayAds': 'true' }), false);
  assert.equal(shouldAds('main.html', { 'afru.hideOverlayAds': 'true' }), true, 'the main window has its own setting');
});

test('language: English turns off the translation but keeps search and the extras', () => {
  const { win, doc } = open('main.html', '<span>Search</span>', { storage: { 'afru.lang': 'en' } });
  assert.equal(doc.querySelector('span').textContent, 'Search');
  assert.equal(win.__AF_RU__.active, false);
  assert.equal(win.__AF_RU_SEARCH__.plan('нова каркас').fragment, 'Nova Prime Chassis Blueprint');
  assert.ok(win.__AF_RU_EXTRAS__);
  win.close();

  const ru = open('main.html', '<span>Search</span>', { storage: { 'afru.lang': 'ru' } });
  assert.equal(ru.doc.querySelector('span').textContent, 'Поиск');
  ru.win.close();
});

const MENU = `
  <div class="topMenuGroup">
    <div class="menuItem selected" tabid="tabFoundry">Foundry</div>
    <div class="menuItem" tabid="tabRelicPlanner">Relics</div>
  </div>
  <div><div id="tabFoundry" class="tab"></div><div id="tabRelicPlanner" class="tab"></div></div>`;

test('farm tab: added to the side menu after «Реликвии» and switched like AlecaFrame tabs', async () => {
  const { win, doc } = open('main.html', MENU, {
    before: (w) => {
      w.menuPressed = (e) => {
        const item = e.target.closest('.menuItem');
        w.document.querySelectorAll('.tab').forEach((t) => { t.style.display = 'none'; });
        w.document.getElementById(item.getAttribute('tabid')).style.display = '';
      };
    },
  });
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([
    { node: 'Hepit (Void)', missionType: 'Capture', tier: 'Lith', isHard: false, isStorm: false, expiry: new Date(Date.now() + 30 * 60000).toISOString() },
    { node: 'Ukko (Void)', missionType: 'Survival', tier: 'Lith', isHard: true, isStorm: false, expiry: new Date(Date.now() + 50 * 60000).toISOString() },
  ]) });
  await waitFor(() => doc.getElementById('afruTabFarm'), 'farm tab');
  const items = [...doc.querySelectorAll('.topMenuGroup > .menuItem')].map((m) => m.getAttribute('tabid'));
  assert.deepEqual(items, ['tabFoundry', 'tabRelicPlanner', 'afruTabFarm']);
  assert.equal(doc.getElementById('afruTabFarm').style.display, 'none');

  doc.querySelector('[tabid="afruTabFarm"]').click();
  await waitFor(() => doc.querySelector('.afru-fissure'), 'fissures');
  const lith = doc.querySelector('.afru-fissureGroup');
  assert.match(lith.textContent, /Лит/);
  const rows = [...lith.querySelectorAll('.afru-fissure')].map((r) => r.querySelector('.afru-fissureMission').textContent);
  assert.deepEqual(rows, ['Capture', 'Survival'], 'fast missions first');
  assert.match(lith.textContent, /быстро/);
  assert.match(lith.textContent, /Стальной Путь/);

  const farm = win.__AF_RU_FARM__;
  assert.deepEqual({ ...farm.parsePlace('Mercury/Apollodorus (Survival), Rot B') }, { planet: 'Mercury', node: 'Apollodorus', mission: 'Survival', rotation: 'B' });
  assert.equal(farm.relicLabel('Meso B2 Relic'), 'Реликвия Мезо B2');
  assert.equal(farm.suggestions('лит а1')[0].en, 'Lith A1 Relic');
  win.close();
});
