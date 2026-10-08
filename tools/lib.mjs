import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DICT_MARKER = '/*__AF_RU_DICT__*/ { exact: {}, patterns: {} }';
const CSS_MARKER = "/*__AF_RU_CSS__*/ ''";
const EXTRAS_CSS_MARKER = "/*__AF_RU_EXTRAS_CSS__*/ ''";
const EXTRAS_CSS_FILES = ['extras.css', 'theme-graphite.css'];
const placeholders = (s) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

/*
 * Merges locales/<lang>/*.json into { exact, patterns, scopes } and reports problems.
 * A key "@ <CSS selector>" holds translations that apply only inside matching elements.
 */
export function loadLocale(lang = 'ru', dir = path.join(ROOT, 'locales', lang)) {
  const exact = {};
  const patterns = {};
  const scopes = {};
  const errors = [];
  const origin = {};
  const add = (table, key, value, file, where) => {
    if (typeof value !== 'string' || !value.trim()) { errors.push(`${where}: empty translation`); return; }
    if (key !== key.replace(/\s+/g, ' ').trim()) errors.push(`${where}: key must be whitespace-normalized`);
    if (placeholders(key) !== placeholders(value)) errors.push(`${where}: placeholders differ ("${value}")`);
    const target = /\{\d+\}/.test(key) ? table.patterns : table.exact;
    const id = `${table.selector ?? ''}\u0000${key}`;
    if (key in target && target[key] !== value) errors.push(`${where}: conflicts with ${origin[id]}`);
    target[key] = value;
    origin[id] = file;
    if (!table.selector) origin[key] = file;
  };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: invalid JSON (${e.message})`);
      continue;
    }
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('//')) continue; // comments
      if (key.startsWith('@')) {
        const selector = key.slice(1).trim();
        if (!selector || !value || typeof value !== 'object') { errors.push(`${file}: "${key}" must map a CSS selector to translations`); continue; }
        const table = (scopes[selector] ??= { selector, exact: {}, patterns: {} });
        for (const [k, v] of Object.entries(value)) if (!k.startsWith('//')) add(table, k, v, file, `${file}: ${key} "${k}"`);
        continue;
      }
      add({ exact, patterns }, key, value, file, `${file}: "${key}"`);
    }
  }
  return { exact, patterns, scopes: Object.values(scopes), errors, origin };
}

/** Localizer (dictionary + layout CSS) followed by the optional features from src/extras.js. */
export function bundle(dict, version = 'dev', css = '', { texts = false } = {}) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'localizer.js'), 'utf8');
  if (!src.includes(DICT_MARKER) || !src.includes(CSS_MARKER)) throw new Error('markers not found in src/localizer.js');
  const payload = JSON.stringify({ version, texts, exact: dict.exact, patterns: dict.patterns, scopes: dict.scopes ?? [] });
  const localizer = src.replace(DICT_MARKER, () => payload).replace(CSS_MARKER, () => JSON.stringify(css));

  const extras = fs.readFileSync(path.join(ROOT, 'src', 'extras.js'), 'utf8');
  if (!extras.includes(EXTRAS_CSS_MARKER)) throw new Error('marker not found in src/extras.js');
  const extrasCss = EXTRAS_CSS_FILES.map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
  return localizer + '\n' + extras.replace(EXTRAS_CSS_MARKER, () => JSON.stringify(extrasCss));
}

export const TEXTS_FILE = path.join(ROOT, 'locales', 'ru', 'texts', 'descriptions.json');

/** Item descriptions (tools/texts.mjs): { exact, patterns }, or null before the first generation. */
export function loadTexts(file = TEXTS_FILE) {
  if (!fs.existsSync(file)) return null;
  const exact = {};
  const patterns = {};
  for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
    if (key.startsWith('//')) continue;
    (/\{\d+\}/.test(key) ? patterns : exact)[key] = value;
  }
  return { exact, patterns };
}

/** dist/alecaframe-ru-texts.js: hands the descriptions to the localizer already running in the page. */
export function bundleTexts(texts) {
  // JSON.parse of a string literal is much faster to start than an equally large object literal.
  const data = JSON.stringify(JSON.stringify(texts));
  return `/* AlecaFrame-RU: описания предметов (официальная локализация Warframe). */\n` +
    `(function (r) { if (r && r.addDictionary) r.addDictionary(JSON.parse(${data})); })(window.__AF_RU__);\n`;
}

export function readCss() {
  return fs.readFileSync(path.join(ROOT, 'src', 'alecaframe-ru.css'), 'utf8');
}

export function readStrings(file = path.join(ROOT, 'strings', 'en.json')) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export { ROOT };
