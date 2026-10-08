import fs from 'node:fs';
import path from 'node:path';
import { loadLocale, bundle, readStrings, readCss, ROOT } from './lib.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dict = loadLocale('ru');
if (dict.errors.length) {
  console.error(dict.errors.join('\n'));
  process.exit(1);
}
const strings = readStrings();
if (strings) {
  const stale = [...Object.keys(dict.exact), ...Object.keys(dict.patterns)].filter((k) => !(k in strings.strings));
  if (stale.length) console.warn(`${stale.length} translations are not in strings/en.json (kept; may come from runtime data):\n  ${stale.slice(0, 20).join('\n  ')}`);
}
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'alecaframe-ru.js'), bundle(dict, pkg.version, readCss()));
console.log(`dist/alecaframe-ru.js: ${Object.keys(dict.exact).length} strings + ${Object.keys(dict.patterns).length} patterns`);
