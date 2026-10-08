import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DICT_MARKER = '/*__AF_RU_DICT__*/ { exact: {}, patterns: {} }';
const CSS_MARKER = "/*__AF_RU_CSS__*/ ''";
const placeholders = (s) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

/** Merges locales/<lang>/*.json into { exact, patterns } and reports problems. */
export function loadLocale(lang = 'ru', dir = path.join(ROOT, 'locales', lang)) {
  const exact = {};
  const patterns = {};
  const errors = [];
  const origin = {};
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
      const where = `${file}: "${key}"`;
      if (typeof value !== 'string' || !value.trim()) { errors.push(`${where}: empty translation`); continue; }
      if (key !== key.replace(/\s+/g, ' ').trim()) errors.push(`${where}: key must be whitespace-normalized`);
      if (placeholders(key) !== placeholders(value)) errors.push(`${where}: placeholders differ ("${value}")`);
      const target = /\{\d+\}/.test(key) ? patterns : exact;
      if (key in target && target[key] !== value) errors.push(`${where}: conflicts with ${origin[key]}`);
      target[key] = value;
      origin[key] = file;
    }
  }
  return { exact, patterns, errors, origin };
}

export function bundle(dict, version = 'dev', css = '') {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'localizer.js'), 'utf8');
  if (!src.includes(DICT_MARKER) || !src.includes(CSS_MARKER)) throw new Error('markers not found in src/localizer.js');
  const payload = JSON.stringify({ version, exact: dict.exact, patterns: dict.patterns });
  return src.replace(DICT_MARKER, () => payload).replace(CSS_MARKER, () => JSON.stringify(css));
}

export function readCss() {
  return fs.readFileSync(path.join(ROOT, 'src', 'alecaframe-ru.css'), 'utf8');
}

export function readStrings(file = path.join(ROOT, 'strings', 'en.json')) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export { ROOT };
