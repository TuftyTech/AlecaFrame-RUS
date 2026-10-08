import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { bundle, bundleTexts, loadLocale, loadTexts, readCss } from '../tools/lib.mjs';

const require = createRequire(import.meta.url);
const VUE = fs.readFileSync(require.resolve('vue/dist/vue.global.prod.js'), 'utf8');

const DICT = {
  exact: {
    Foundry: 'Литейная',
    Owned: 'В наличии',
    Sell: 'Продать',
    All: 'Все',
    'Rank up': 'Повысить ранг',
    'Search items': 'Поиск предметов',
    Forma: 'Форма',
    'to try again.': ', чтобы повторить.',
  },
  patterns: {
    '{0} owned': 'В наличии: {0}',
    'Status: {0}': 'Статус: {0}',
    'Sold {0} for {1}p': 'Продано за {1}p: {0}',
  },
};

function setup(body, { dict = DICT, beforeInject } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Foundry</title></head><body>${body}</body></html>`, {
    runScripts: 'outside-only',
  });
  beforeInject?.(dom.window);
  dom.window.eval(bundle(dict));
  return dom;
}
const $ = (dom, sel) => dom.window.document.querySelector(sel);
const flush = () => new Promise((r) => setTimeout(r, 0));

test('translates static text and keeps surrounding whitespace', () => {
  const dom = setup('<div id="a">\n    Foundry\n  </div><b id="b">Unknown text</b><i id="c">Литейная</i>');
  assert.equal($(dom, '#a').firstChild.nodeValue, '\n    Литейная\n  ');
  assert.equal($(dom, '#b').textContent, 'Unknown text');
  assert.equal($(dom, '#c').textContent, 'Литейная');
  assert.equal(dom.window.document.title, 'Литейная');
  assert.equal(dom.window.document.documentElement.lang, 'ru');
});

test('fragments starting with punctuation attach to the previous word', () => {
  const dom = setup('<p id="p">Click <a>here</a> to try again.</p>');
  assert.equal($(dom, '#p').lastChild.nodeValue, ', чтобы повторить.');
});

test('patterns fill placeholders, allow reordering and translate known values', () => {
  const dom = setup('<span id="a">5 owned</span><span id="b">Status: Owned</span><span id="c">Sold Ash Prime Set for 120p</span>');
  assert.equal($(dom, '#a').textContent, 'В наличии: 5');
  assert.equal($(dom, '#b').textContent, 'Статус: В наличии');
  assert.equal($(dom, '#c').textContent, 'Продано за 120p: Ash Prime Set');
});

test('leaves code, user input and ad slots alone', () => {
  const dom = setup(`
    <script>/* Foundry */</script>
    <textarea id="ta">Sell</textarea>
    <div id="mainADinner"><span id="ad">Sell</span></div>
    <div translate="no"><span id="no">Sell</span></div>`);
  assert.equal($(dom, '#ta').value, 'Sell');
  assert.equal($(dom, '#ad').textContent, 'Sell');
  assert.equal($(dom, '#no').textContent, 'Sell');
});

test('inventory card names are shown in Russian, but AlecaFrame reads them back in English', async () => {
  const seen = [];
  const dom = setup(`
    <div class="inventoryObject" id="card">
      <div class="inventoryItemName" rank="0"><span class="normalItem" id="name">Forma</span></div>
      <button id="sell">Sell</button>
    </div>`, {
    beforeInject(win) {
      // Same lookup as AlecaFrame's onBuySellItemClicked (jsdom has no innerText).
      win.onBuySellItemClicked = function (event) {
        let target = event.target;
        while (!target.classList.contains('inventoryObject')) target = target.parentElement;
        seen.push(target.getElementsByClassName('inventoryItemName')[0].textContent);
        return 'handled';
      };
    },
  });
  const win = dom.window;
  // AlecaFrame's handlers are wrapped on DOMContentLoaded, after its own scripts have run.
  await new Promise((r) => (win.document.readyState === 'loading' ? win.document.addEventListener('DOMContentLoaded', r) : r()));
  assert.equal($(dom, '#name').textContent, 'Форма');
  const result = win.onBuySellItemClicked({ target: $(dom, '#sell'), preventDefault() {} });
  assert.equal(result, 'handled');
  assert.deepEqual(seen, ['Forma'], 'warframe.market lookup uses the English name');
  assert.equal($(dom, '#name').textContent, 'Форма', 'the card shows Russian again right away');
  const writes = win.__AF_RU__.stats.text;
  await flush();
  assert.equal(win.__AF_RU__.stats.text, writes, 'the swap does not look like new text');
});

test('translates text attributes, including HTML tooltips', () => {
  const dom = setup('<input id="i" placeholder="Search items"><div id="t" title="Sell" data-tippy-content="<b>Sell</b> now"></div><input id="btn" type="button" value="Sell"><input id="txt" value="Sell">');
  assert.equal($(dom, '#i').placeholder, 'Поиск предметов');
  assert.equal($(dom, '#t').title, 'Продать');
  assert.equal($(dom, '#t').getAttribute('data-tippy-content'), '<b>Продать</b> now');
  assert.equal($(dom, '#btn').value, 'Продать');
  assert.equal($(dom, '#txt').value, 'Sell', 'text input values are user data');
});

test('keeps <option> values in English when the value comes from the text', () => {
  const dom = setup('<select id="s"><option>All</option><option value="x">Sell</option></select>');
  const select = $(dom, '#s');
  assert.equal(select.options[0].text, 'Все');
  assert.equal(select.value, 'All');
  assert.equal(select.options[1].text, 'Продать');
});

test('follows DOM changes made after load without looping', async () => {
  const dom = setup('<div id="root"><span id="s">Owned</span></div>');
  const doc = dom.window.document;
  const added = doc.createElement('p');
  added.textContent = 'Sell';
  added.title = 'Foundry';
  $(dom, '#root').append(added);
  $(dom, '#s').firstChild.nodeValue = '3 owned';
  await flush();
  assert.equal(added.textContent, 'Продать');
  assert.equal(added.title, 'Литейная');
  assert.equal($(dom, '#s').textContent, 'В наличии: 3');
  const writes = dom.window.__AF_RU__.stats.text;
  await flush();
  await flush();
  assert.equal(dom.window.__AF_RU__.stats.text, writes, 'own writes must not retrigger translation');
});

test('wraps alert/confirm/prompt messages', () => {
  const calls = [];
  setup('', {
    beforeInject(win) {
      win.alert = (m) => calls.push(m);
    },
  }).window.alert('Sell');
  assert.deepEqual(calls, ['Продать']);
});

test('records untranslated texts for gap reports', () => {
  const dom = setup('<p>Brand new label</p><p>Foundry</p>');
  assert.deepEqual(Array.from(dom.window.__AF_RU__.missing()), ['Brand new label']);
});

const VUE_APP = `
  <div id="app">
    <h1 id="h">Foundry</h1>
    <span id="cnt">{{ n }} owned</span>
    <span id="st">Status: {{ status }}</span>
    <select id="sel" v-model="choice"><option value="All">All</option><option value="Sell">Sell</option></select>
    <button id="btn" title="Rank up" @click="n++">Rank up</button>
    <p id="cond" v-if="show">Sell</p>
  </div>`;

for (const when of ['before', 'after']) {
  test(`works with Vue 3.2 in-DOM templates (injected ${when} mount)`, async () => {
    const dom = new JSDOM(`<!doctype html><html><body>${VUE_APP}</body></html>`, { runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(VUE);
    if (when === 'before') win.eval(bundle(DICT));
    win.eval(`window.vm = Vue.createApp({ data: () => ({ n: 1, status: 'Owned', choice: 'All', show: false }) }).mount('#app')`);
    if (when === 'after') win.eval(bundle(DICT));
    await flush();
    const vm = win.vm;
    assert.equal($(dom, '#h').textContent, 'Литейная');
    assert.equal($(dom, '#cnt').textContent, 'В наличии: 1');
    assert.equal($(dom, '#st').textContent, 'Статус: В наличии');
    assert.equal($(dom, '#btn').title, 'Повысить ранг');

    $(dom, '#btn').click();
    vm.show = true;
    await flush();
    assert.equal(vm.n, 2);
    assert.equal($(dom, '#cnt').textContent, 'В наличии: 2');
    assert.equal($(dom, '#cond').textContent, 'Продать');

    const sel = $(dom, '#sel');
    sel.value = 'Sell';
    sel.dispatchEvent(new win.Event('change'));
    await flush();
    assert.equal(vm.choice, 'Sell', 'v-model keeps the English value');
    assert.equal(sel.options[1].text, 'Продать');
  });
}

const SCOPED = {
  ...DICT,
  exact: { ...DICT.exact, Normal: 'Обычный', Rifle: 'Винтовка', Shuriken: 'Сюрикен' },
  scopes: [
    {
      selector: '.stats',
      exact: { Burst: 'Очередь', 'Normal Attack': 'Обычная атака', Spectral: 'Призрачный' },
      patterns: { '{0} Explosion': '{0}: взрыв', '{0} Riven Mod': 'Мод Разлома: {0}' },
    },
    { selector: '.ability', exact: {}, patterns: { '{0}) {1}': '{0}) {1}' } },
  ],
};

test('scoped translations apply only inside their element and win over global ones', () => {
  const dom = setup(`
    <div class="stats"><b id="a">Burst</b><b id="b" title="Normal Attack">Normal Attack</b><i id="c">Sell</i>
      <b id="d">Spectral Explosion</b><b id="e">Glass Explosion</b><b id="f">Rifle Riven Mod</b></div>
    <p id="g">Burst</p><p id="h">Spectral Explosion</p>
    <div class="ability"><span id="i">2) Shuriken</span><span id="j">3) Unknown Power</span></div>`, { dict: SCOPED });
  assert.equal($(dom, '#a').textContent, 'Очередь');
  assert.equal($(dom, '#b').textContent, 'Обычная атака');
  assert.equal($(dom, '#b').title, 'Обычная атака', 'attributes use the scope too');
  assert.equal($(dom, '#c').textContent, 'Продать', 'global translations still apply inside a scope');
  assert.equal($(dom, '#d').textContent, 'Призрачный: взрыв');
  assert.equal($(dom, '#e').textContent, 'Glass Explosion', 'no half-English result from a scoped pattern');
  assert.equal($(dom, '#f').textContent, 'Мод Разлома: Винтовка', 'placeholders use global translations too');
  assert.equal($(dom, '#g').textContent, 'Burst', 'outside the scope the word is left alone');
  assert.equal($(dom, '#h').textContent, 'Spectral Explosion');
  assert.equal($(dom, '#i').textContent, '2) Сюрикен');
  assert.equal($(dom, '#j').textContent, '3) Unknown Power');
});

test('descriptions loaded later translate what is already shown, without overriding interface strings', () => {
  const dom = setup('<p id="a">The Burston fires 3-round bursts.</p><p id="b">Sell</p><p id="c">Deals 25 damage for 3s.</p>');
  const api = dom.window.__AF_RU__;
  assert.ok(api.missing().includes('The Burston fires 3-round bursts.'));
  const added = api.addDictionary({
    exact: { 'The Burston fires 3-round bursts.': 'Бёрстон стреляет очередями по 3 выстрела.', Sell: 'Продажа' },
    patterns: { 'Deals {0} damage for {1}s.': 'Наносит {0} урона за {1} с.' },
  });
  assert.equal(added, 2);
  assert.equal($(dom, '#a').textContent, 'Бёрстон стреляет очередями по 3 выстрела.');
  assert.equal($(dom, '#b').textContent, 'Продать');
  assert.equal($(dom, '#c').textContent, 'Наносит 25 урона за 3 с.');
  assert.ok(!api.missing().includes('The Burston fires 3-round bursts.'));
});

test('the main window loads the descriptions file next to the localizer; other windows do not', () => {
  const pages = { 'main.html': 1, 'relicOverlay.html': 0 };
  for (const [page, expected] of Object.entries(pages)) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: `https://af.test/web/${page}`, runScripts: 'outside-only' });
    dom.window.eval(bundle(DICT, 'dev', '', { texts: true }));
    const scripts = [...dom.window.document.querySelectorAll('script[src]')].map((s) => s.src);
    assert.equal(scripts.length, expected, page);
    if (expected) assert.equal(scripts[0], 'https://af.test/web/assets/js/alecaframe-ru-texts.js');
  }
});

test('the descriptions bundle hands its dictionary to the running localizer', () => {
  const dom = setup('<p id="a">Long description.</p>');
  dom.window.eval(bundleTexts({ exact: { 'Long description.': 'Длинное описание.' }, patterns: {} }));
  assert.equal($(dom, '#a').textContent, 'Длинное описание.');
});

test('Russian locale files are valid', () => {
  const { errors, exact, scopes } = loadLocale('ru');
  assert.deepEqual(errors, []);
  assert.ok(Object.keys(exact).length > 0);
  assert.ok(scopes.some((s) => s.selector === '.foundryDetailsTopCustom' && s.exact.Burst === 'Очередь'));
});

test('scoped keys stay out of the global dictionary', () => {
  const { exact } = loadLocale('ru');
  for (const word of ['Burst', 'Charge', 'Active', 'Held', 'Alarming']) assert.ok(!(word in exact), word);
});

test('committed dist files are up to date (run `pnpm build`)', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const texts = loadTexts();
  const expected = bundle(loadLocale('ru'), pkg.version, readCss(), { texts: !!texts });
  assert.equal(fs.readFileSync(new URL('../dist/alecaframe-ru.js', import.meta.url), 'utf8'), expected);
  if (texts) assert.equal(fs.readFileSync(new URL('../dist/alecaframe-ru-texts.js', import.meta.url), 'utf8'), bundleTexts(texts));
});
