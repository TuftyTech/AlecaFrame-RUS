// Generates locales/ru/texts/descriptions.json: the descriptions AlecaFrame shows in item details
// (items, components, abilities, passives, mod and arcane levels) -> the game's official Russian text.
//
// Sources: AlecaFrame's own data (which English texts it shows) and DE's public export in English and
// Russian (content.warframe.com/PublicExport), matched by the item's uniqueName.
//
// Usage: node tools/texts.mjs [--offline]   (--offline reuses the downloads cached in the OS temp dir)
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_FILES, alecaFrameData, deExports } from './data.mjs';
import { loadLocale, ROOT, TEXTS_FILE } from './lib.mjs';

const EXPORTS = ['ExportWeapons', 'ExportWarframes', 'ExportUpgrades', 'ExportResources', 'ExportSentinels', 'ExportRelicArcane', 'ExportGear'];
const CYRILLIC = /[А-Яа-яЁё]/;
const LETTERS = /[A-Za-z]/;
const TOKEN = /\|[A-Z_]+\|/g;

const normalize = (s) => s.replace(/\s+/g, ' ').trim();
// Some texts carry "\n" as two characters instead of a line break.
const lines = (s) => s.replace(/\\[rn]/g, '\n').split(/\r?\n/).map(normalize).filter(Boolean);
const stripTags = (s) => s.replace(/<[^<>]+>/g, '');
const matchKey = (s) => normalize(stripTags(s.replace(/\\[rn]/g, ' ')));

// ------------------------------------------------------------ DE: English -> Russian

const [en, ru] = [await deExports('en', EXPORTS), await deExports('ru', EXPORTS)];
const candidates = new Map(); // matchKey(en) -> Map(ru -> count)
const lowerCandidates = new Map();

function pair(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) { a.forEach((x, i) => pair(x, b[i])); return; }
  if (typeof a !== 'string' || typeof b !== 'string' || !CYRILLIC.test(b)) return;
  const key = matchKey(a);
  if (!LETTERS.test(key)) return;
  for (const [map, k] of [[candidates, key], [lowerCandidates, key.toLowerCase()]]) {
    const counts = map.get(k) ?? new Map();
    counts.set(b, (counts.get(b) ?? 0) + 1);
    map.set(k, counts);
  }
}

for (const name of EXPORTS) {
  for (const [list, enEntries] of Object.entries(en[name])) {
    if (!Array.isArray(enEntries)) continue;
    const id = (x) => x.uniqueName ?? x.abilityUniqueName;
    const ruById = new Map((ru[name][list] ?? []).map((x) => [id(x), x]));
    for (const a of enEntries) {
      const b = ruById.get(id(a));
      if (!b) continue;
      pair(a.description, b.description);
      pair(a.passiveDescription, b.passiveDescription);
      pair(a.abilityName, b.abilityName);
      (a.abilities ?? []).forEach((x, i) => {
        pair(x.abilityName, b.abilities?.[i]?.abilityName);
        pair(x.description, b.abilities?.[i]?.description);
      });
      (a.levelStats ?? []).forEach((x, i) => pair(x.stats, b.levelStats?.[i]?.stats));
    }
  }
}

const mostCommon = (counts) => counts && [...counts].sort((x, y) => y[1] - x[1])[0][0];
const official = (s) => mostCommon(candidates.get(matchKey(s))) ?? mostCommon(lowerCandidates.get(matchKey(s).toLowerCase())) ?? null;

// ----------------------------------------------------- AlecaFrame: what is on screen

const af = await alecaFrameData();
const shown = new Set();
const show = (s) => { if (typeof s === 'string' && LETTERS.test(s)) shown.add(s); };
for (const file of CATEGORY_FILES) {
  if (!af.has(`json/${file}.json`)) continue;
  for (const item of af.json(`json/${file}.json`)) {
    show(item?.description);
    show(item?.passiveDescription);
    for (const a of item?.abilities ?? []) { show(a?.name); show(a?.description); }
    for (const level of item?.levelStats ?? []) for (const stat of level?.stats ?? []) show(stat);
    for (const c of item?.components ?? []) show(c?.description);
  }
}

// Interface strings and item names win: they are already translated for their own meaning.
const ui = loadLocale('ru');
const out = {};
let missing = 0;

function put(key, value) {
  if (!LETTERS.test(key) || key in ui.exact || key === value || key in out) return;
  out[key] = value;
}

/** AlecaFrame fills |DAMAGE|-style tokens with numbers before showing some texts. */
function putWithTokens(key, value) {
  const tokens = [...new Set(key.match(TOKEN) ?? [])];
  if (!tokens.length || tokens.some((t) => !value.includes(t))) return;
  const toPattern = (s) => tokens.reduce((acc, t, i) => acc.split(t).join(`{${i}}`), s.replace(/[{}]/g, ''));
  put(toPattern(key), toPattern(value));
}

for (const s of [...shown].sort()) {
  const target = official(s);
  if (!target) { missing++; continue; }
  const value = normalize(stripTags(target.replace(/\\[rn]/g, ' ')));
  for (const key of new Set([normalize(s), normalize(stripTags(s))])) {
    put(key, value);
    putWithTokens(key, value);
  }
  // Mod levels are shown line by line.
  const enLines = lines(s);
  const ruLines = lines(target);
  if (enLines.length > 1 && enLines.length === ruLines.length) {
    enLines.forEach((line, i) => put(line, normalize(stripTags(ruLines[i]))));
  }
}

const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
fs.mkdirSync(path.dirname(TEXTS_FILE), { recursive: true });
fs.writeFileSync(TEXTS_FILE, JSON.stringify({
  '// Описания предметов, способностей и уровней модов. Сгенерировано tools/texts.mjs из официальной локализации Warframe; не править вручную.': '',
  ...sorted,
}, null, 2) + '\n');
const size = (fs.statSync(TEXTS_FILE).size / 1024 / 1024).toFixed(1);
console.log(`${path.relative(ROOT, TEXTS_FILE)}: ${Object.keys(sorted).length} texts, ${size} MB (${missing} shown texts have no Russian source)`);
