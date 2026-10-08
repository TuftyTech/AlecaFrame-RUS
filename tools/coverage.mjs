// Prints how much of strings/en.json is translated; --missing lists the gaps by file.
import fs from 'node:fs';
import path from 'node:path';
import { loadLocale, readStrings, ROOT } from './lib.mjs';

const strings = readStrings();
if (!strings) { console.error('strings/en.json not found, run `pnpm extract <AlecaFrame dir>` first'); process.exit(1); }
const dict = loadLocale('ru');
const ignored = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'ignore.json'), 'utf8'))).filter((k) => !k.startsWith('//')));
const keys = Object.keys(strings.strings).filter((k) => !ignored.has(k));
const missing = keys.filter((k) => !(k in dict.exact) && !(k in dict.patterns));
const pct = (((keys.length - missing.length) / keys.length) * 100).toFixed(1);
console.log(`AlecaFrame ${strings.alecaframeVersion}: ${keys.length - missing.length}/${keys.length} translated (${pct}%)`);
if (process.argv.includes('--missing')) {
  const byFile = {};
  for (const k of missing) (byFile[strings.strings[k].files[0]] ??= []).push(k);
  for (const [file, list] of Object.entries(byFile).sort()) console.log(`\n# ${file}\n${list.join('\n')}`);
}
