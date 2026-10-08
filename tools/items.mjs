// Generates locales/ru/90-items.json: English item names as AlecaFrame shows them -> official Russian names.
//
// Sources:
//  - AlecaFrame's own data (cdn.alecaframe.com/warframeData/json.zip): display names (custom/basic.json),
//    item/part structure (json/*.json) and the game's official localization (json/lang.json, from DE's exports).
//  - warframe.market items (api.warframe.market/v2/items): trade names, which AlecaFrame uses for inventory cards.
//    Their Russian names Title-Case every word ("Мистический Барьер"), so they are only used for the shape of
//    composite names ("Нова Прайм: Система (Чертёж)") and as a case-corrected fallback.
//
// Usage: node tools/items.mjs [--offline]   (--offline reuses the downloads cached in the OS temp dir)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocale, ROOT } from './lib.mjs';
import { CATEGORY_FILES, alecaFrameData, download, parseJson } from './data.mjs';

const OUT_FILE = '90-items.json';
const WFM_ITEMS_URL = 'https://api.warframe.market/v2/items';
// basic.json entries that are never shown as inventory or crafting items.
const SKIPPED_PATHS = ['/Lotus/Upgrades/Skins/', '/Lotus/Types/Challenges/', '/Lotus/Upgrades/Focus/', '/Lotus/Types/Items/ShipDecos/'];
const RELIC_ERAS = { Lith: 'Лит', Meso: 'Мезо', Neo: 'Нео', Axi: 'Акси', Requiem: 'Реквием', Vanguard: 'Авангард' };
const REFINEMENTS = { Intact: 'целая', Exceptional: 'исключительная', Flawless: 'безупречная', Radiant: 'сияющая' };
const BLUEPRINT = 'Чертёж';
const SET = 'Комплект';

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const CYRILLIC = /[А-Яа-яЁё]/;
const usable = (ru) => !!ru && CYRILLIC.test(ru) && !/[<>|{}]|\bTEST\b/i.test(ru);

const afData = await alecaFrameData();
const zipJson = afData.json;
const lang = zipJson('json/lang.json');
const basic = zipJson('custom/basic.json').items;
const wfmItems = parseJson(await download(WFM_ITEMS_URL, 'wfm-items-ru.json', { Language: 'ru', Platform: 'pc' })).data;

const official = (uniqueName) => {
  const ru = clean(lang[uniqueName]?.ru?.name);
  return usable(ru) ? ru.replace(/Чертеж/g, BLUEPRINT) : null;
};

// ---------------------------------------------------------------- structure

const itemsByUnique = new Map(); // uniqueName -> WFCD item
const partOf = new Map(); // part uniqueName -> { parent, short }
const partNames = new Map(); // English part name -> Map(Russian -> count)
for (const file of CATEGORY_FILES) {
  if (!afData.has(`json/${file}.json`)) continue;
  for (const item of zipJson(`json/${file}.json`)) {
    if (!item?.uniqueName) continue;
    itemsByUnique.set(item.uniqueName, item);
    for (const c of item.components ?? []) {
      if (!c?.uniqueName || !c.name || partOf.has(c.uniqueName)) continue;
      const full = clean(basic[c.uniqueName]?.name);
      // Shared resources (Orokin Cell, Neurodes) are components too, but are not named after the item.
      if (c.name !== 'Blueprint' && !full.startsWith(clean(item.name) + ' ')) continue;
      partOf.set(c.uniqueName, { parent: item.uniqueName, short: clean(c.name) });
      const ru = official(c.uniqueName);
      if (ru && !ru.includes(':')) {
        const counts = partNames.get(clean(c.name)) ?? new Map();
        counts.set(ru, (counts.get(ru) ?? 0) + 1);
        partNames.set(clean(c.name), counts);
      }
    }
  }
}
const mostCommon = (counts) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const partName = (en) => (en === 'Blueprint' ? BLUEPRINT : partNames.has(en) ? mostCommon(partNames.get(en)) : null);

// Crafting trees call a built part after its item ("Ash Neuroptics"), a name no data file lists.
const builtParts = new Map(); // "Ash Neuroptics" -> { parent, short }
for (const part of partOf.values()) {
  const parentEn = clean(itemsByUnique.get(part.parent)?.name);
  // Parts that repeat their item's name ("Greater Madurai Lens" of "Eidolon Madurai Lens") are named in full already.
  const repeats = parentEn.split(' ').some((word) => word.length > 3 && part.short.includes(word));
  if (part.short !== 'Blueprint' && parentEn && !repeats) builtParts.set(`${parentEn} ${part.short}`, part);
}

// English display name -> uniqueNames (several entries can share a name).
const uniquesByName = new Map();
const addName = (name, uniqueName) => {
  if (!name) return;
  const list = uniquesByName.get(name) ?? [];
  if (!list.includes(uniqueName)) list.push(uniqueName);
  uniquesByName.set(name, list);
};
for (const [uniqueName, v] of Object.entries(basic)) addName(clean(v.name), uniqueName);
for (const [uniqueName, item] of itemsByUnique) addName(clean(item.name), uniqueName);

// --------------------------------------------------------------- case fixes

// How official names write each word when it is not the first one: proper nouns stay capitalized
// ("Гринир", "Корпуса"), common words do not ("Мистический барьер").
const wordCase = new Map();
for (const v of Object.values(lang)) {
  const ru = clean(v?.ru?.name);
  if (!usable(ru)) continue;
  for (const segment of ru.split(/: |\(|\)| - /)) {
    segment.trim().split(' ').slice(1).forEach((word) => {
      if (!/^[А-ЯЁа-яё]/.test(word)) return;
      const key = word.toLowerCase();
      const stat = wordCase.get(key) ?? { lower: 0, upper: 0 };
      if (word[0] === word[0].toLowerCase()) stat.lower++;
      else stat.upper++;
      wordCase.set(key, stat);
    });
  }
}
const SMALL_WORDS = new Set(['и', 'в', 'во', 'с', 'со', 'на', 'для', 'из', 'от', 'по', 'к', 'о', 'об', 'у', 'за', 'без', 'под', 'над']);

/** warframe.market capitalizes every word; restores sentence case within each name segment. */
function fixCase(ru) {
  return ru.replace(/Чертеж/g, BLUEPRINT).split(/(: |\(|\)| - )/).map((segment) => {
    const words = segment.split(' ');
    return words.map((word, i) => {
      if (i === 0 || !/^[А-ЯЁ][а-яё]/.test(word)) return word;
      const key = word.toLowerCase();
      if (SMALL_WORDS.has(key)) return key;
      const stat = wordCase.get(key);
      return stat && stat.lower > stat.upper ? key : word;
    }).join(' ');
  }).join('');
}

// ---------------------------------------------------------------- resolving

const cache = new Map();

/** Russian name for an English display name, or null when there is no reliable source. */
function resolve(en) {
  if (cache.has(en)) return cache.get(en);
  cache.set(en, null); // guards against cycles
  const ru = resolveUncached(en);
  cache.set(en, ru);
  return ru;
}

function resolveByUnique(uniqueName, en) {
  const part = partOf.get(uniqueName);
  if (part) {
    const parent = itemsByUnique.get(part.parent);
    const parentEn = clean(parent?.name);
    const parentRu = official(part.parent) ?? (parentEn ? resolve(parentEn) : null);
    if (parentRu && en.startsWith(parentEn + ' ')) {
      const rest = en.slice(parentEn.length + 1);
      if (rest === 'Blueprint') return `${parentRu} (${BLUEPRINT})`;
      const isBlueprint = rest.endsWith(' Blueprint') && part.short !== rest;
      const shortEn = isBlueprint ? rest.slice(0, -' Blueprint'.length) : rest;
      const own = official(uniqueName);
      const shortRu = own && !own.includes(':') ? own : partName(shortEn) ?? partName(part.short);
      if (own && own.includes(':')) return isBlueprint ? `${own} (${BLUEPRINT})` : own;
      if (shortRu) return `${parentRu}: ${shortRu}` + (isBlueprint ? ` (${BLUEPRINT})` : '');
    }
    return null;
  }
  const ru = official(uniqueName);
  // Several entries are named "<Item> Blueprint" in AlecaFrame while the game names them after the result.
  if (ru && en.endsWith(' Blueprint') && !ru.includes(BLUEPRINT)) return `${ru} (${BLUEPRINT})`;
  return ru;
}

const ERA_RE = Object.keys(RELIC_ERAS).join('|');
const RELIC_RE = new RegExp(`^(${ERA_RE}) ([A-Z]+\\d+) Relic$`);
const REFINED_RELIC_RE = new RegExp(`^(${ERA_RE}) ([A-Z]+\\d+) (${Object.keys(REFINEMENTS).join('|')})$`);

// warframe.market sometimes types a Cyrillic letter inside a Latin code ("Лит С19" for "Lith S19").
const LOOKALIKES = { А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X' };
function fixLookalikes(ru, en) {
  const latin = new Set(en.split(/[\s()]+/));
  return ru.replace(/[A-ZА-ЯЁ]+\d[\w\d]*/g, (token) => {
    const fixed = token.replace(/[АВСЕНКМОРТХ]/g, (c) => LOOKALIKES[c]);
    return latin.has(fixed) ? fixed : token;
  });
}

// ...and the game's own data has Latin letters inside Russian words ("Cцена", "ПOM-2").
const CYRILLIC_LOOKALIKES = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' };
function fixMixedWords(ru) {
  return ru.replace(/[A-Za-zА-Яа-яЁё]+/g, (word) => (/[А-Яа-яЁё]/.test(word) && /[A-Za-z]/.test(word)
    ? word.replace(/[ABCEHKMOPTXaceopxy]/g, (c) => CYRILLIC_LOOKALIKES[c])
    : word));
}

// Some official names are stored in capitals ("ОСКОЛОК АРХОНТА").
function fromCapitals(ru) {
  return ru.split(/(: |\(|\)| - )/).map((segment) => segment.split(' ').map((word, i) => {
    if (!/^[А-ЯЁ-]+$/.test(word) || !/[А-ЯЁ]{2}/.test(word)) return word;
    const lower = word.toLowerCase();
    const stat = wordCase.get(lower);
    // Only words that official names clearly treat as proper nouns ("Архонта", "Орокин") keep a capital.
    return i === 0 || (stat && stat.upper > stat.lower * 2) ? word[0] + lower.slice(1) : lower;
  }).join(' ')).join('');
}
const isShouting = (ru) => ru.split(/: |\(|\)| - /).some((segment) => {
  const letters = segment.replace(/[^А-Яа-яЁё]/g, '');
  return letters.length >= 4 && letters === letters.toUpperCase();
});

function polish(ru, en) {
  const out = fixMixedWords(fixLookalikes(ru, en));
  if (!isShouting(out)) return out;
  const wfm = wfmByName.get(en);
  return wfm && !isShouting(wfm.ru) ? fixCase(fixMixedWords(wfm.ru)) : fromCapitals(out);
}

function resolveUncached(en) {
  // Relic codes stay in Latin letters, as in the game ("Реликвия Лит G9").
  const relic = RELIC_RE.exec(en);
  if (relic) return `Реликвия ${RELIC_ERAS[relic[1]]} ${relic[2]}`;
  const refined = REFINED_RELIC_RE.exec(en);
  if (refined) return `${RELIC_ERAS[refined[1]]} ${refined[2]} (${REFINEMENTS[refined[3]]})`;
  for (const uniqueName of uniquesByName.get(en) ?? []) {
    const ru = resolveByUnique(uniqueName, en);
    if (ru) return ru;
  }
  const built = builtParts.get(en);
  if (built) {
    const parentRu = official(built.parent) ?? resolve(clean(itemsByUnique.get(built.parent)?.name));
    const shortRu = partName(built.short);
    if (parentRu && shortRu) return `${parentRu}: ${shortRu}`;
  }
  if (en.endsWith(' Set')) {
    const base = resolve(en.slice(0, -' Set'.length));
    if (base) return `${base}: ${SET}`;
  }
  if (en.endsWith(' Blueprint')) {
    // A bare part ("Systems Blueprint" in a crafting tree) is the generic part, not an item of that name.
    const baseEn = en.slice(0, -' Blueprint'.length);
    const base = partName(baseEn) ?? resolve(baseEn);
    if (base) return `${base} (${BLUEPRINT})`;
  }
  const wfm = wfmByName.get(en);
  if (wfm) {
    const ru = official(wfm.gameRef);
    // Same name as the game: take the game's spelling and case.
    if (ru && ru.toLowerCase().replace(/ё/g, 'е') === wfm.ru.toLowerCase().replace(/ё/g, 'е')) return ru;
    fromMarket.add(en);
    return fixCase(wfm.ru);
  }
  return null;
}
const fromMarket = new Set();

const wfmByName = new Map();
for (const item of wfmItems) {
  const en = clean(item.i18n?.en?.name);
  const ru = clean(item.i18n?.ru?.name);
  if (en && usable(ru)) wfmByName.set(en, { ru, gameRef: item.gameRef });
}

// ------------------------------------------------------------------ output

const names = new Set(wfmByName.keys());
for (const [uniqueName, v] of Object.entries(basic)) {
  const en = clean(v.name);
  if (!en || (SKIPPED_PATHS.some((p) => uniqueName.startsWith(p)) && !wfmByName.has(en))) continue;
  names.add(en);
}
for (const item of itemsByUnique.values()) names.add(clean(item.name));
for (const en of partNames.keys()) names.add(en).add(`${en} Blueprint`);
for (const en of builtParts.keys()) names.add(en);

// Interface strings win: the same English text may already have a translation for its UI meaning.
const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afru-ui-'));
for (const f of fs.readdirSync(path.join(ROOT, 'locales', 'ru'))) {
  if (f.endsWith('.json') && f !== OUT_FILE) fs.copyFileSync(path.join(ROOT, 'locales', 'ru', f), path.join(uiDir, f));
}
const ui = loadLocale('ru', uiDir);
fs.rmSync(uiDir, { recursive: true, force: true });

const out = {};
let unresolved = 0;
for (const en of [...names].sort((a, b) => a.localeCompare(b, 'en'))) {
  if (!en || !/[A-Za-z]/.test(en) || /\{\d+\}/.test(en) || en in ui.exact) continue;
  // A bare part name ("Stock", "Barrel") is a foundry component label, not the unrelated item of that name.
  const found = en.length > 1 ? partName(en) ?? resolve(en) : null;
  if (!found) { unresolved++; continue; }
  const ru = polish(found, en);
  if (ru !== en) out[en] = ru;
}

const header = {
  '// Названия предметов. Сгенерировано tools/items.mjs из официальной локализации Warframe (данные AlecaFrame) и warframe.market; не править вручную.': '',
};
const file = path.join(ROOT, 'locales', 'ru', OUT_FILE);
fs.writeFileSync(file, JSON.stringify({ ...header, ...out }, null, 2) + '\n');
console.log(`${path.relative(ROOT, file)}: ${Object.keys(out).length} names (${unresolved} without a Russian source, left in English)`);
const corrected = [...fromMarket].filter((en) => out[en]);
console.log(`${corrected.length} names come from warframe.market with case corrected` + (process.argv.includes('--report') ? ':\n' + corrected.map((en) => `  ${en} -> ${out[en]}`).join('\n') : ' (--report lists them)'));
