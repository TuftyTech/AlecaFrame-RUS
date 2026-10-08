import fs from 'node:fs';
import path from 'node:path';
import { loadLocale, loadTexts, bundle, bundleTexts, readStrings, readCss, ROOT } from './lib.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dict = loadLocale('ru');
if (dict.errors.length) {
  console.error(dict.errors.join('\n'));
  process.exit(1);
}
const strings = readStrings();
if (strings) {
  // Item names come from game data at runtime, not from AlecaFrame's markup.
  const stale = [...Object.keys(dict.exact), ...Object.keys(dict.patterns)]
    .filter((k) => !(k in strings.strings) && dict.origin[k] !== '90-items.json');
  if (stale.length) console.warn(`${stale.length} translations are not in strings/en.json (kept; may come from runtime data):\n  ${stale.slice(0, 20).join('\n  ')}`);
}
const texts = loadTexts();
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'alecaframe-ru.js'), bundle(dict, pkg.version, readCss(), { texts: !!texts }));
const scoped = dict.scopes.reduce((n, s) => n + Object.keys(s.exact).length + Object.keys(s.patterns).length, 0);
console.log(`dist/alecaframe-ru.js: ${Object.keys(dict.exact).length} strings + ${Object.keys(dict.patterns).length} patterns + ${scoped} scoped`);
if (texts) {
  fs.writeFileSync(path.join(dist, 'alecaframe-ru-texts.js'), bundleTexts(texts));
  console.log(`dist/alecaframe-ru-texts.js: ${Object.keys(texts.exact).length} descriptions + ${Object.keys(texts.patterns).length} patterns`);
}
