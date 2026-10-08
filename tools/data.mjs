// Downloads shared by the generators (tools/items.mjs, tools/texts.mjs), cached in the OS temp dir.
// `--offline` on the command line reuses the cached copies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import lzma from 'lzma';

export const CACHE = path.join(os.tmpdir(), 'alecaframe-ru-items');
export const AF_DATA_URL = 'https://cdn.alecaframe.com/warframeData/json.zip';
const DE_EXPORT = 'https://content.warframe.com/PublicExport';
const offline = process.argv.includes('--offline');

// Categories that AlecaFrame lists as items (cosmetics, glyphs, quests and star chart nodes are not shown as items).
export const CATEGORY_FILES = [
  'Warframes', 'Primary', 'Secondary', 'Melee', 'Arch-Gun', 'Arch-Melee', 'Archwing', 'Sentinels',
  'SentinelWeapons', 'Pets', 'Railjack', 'Mods', 'Arcanes', 'Relics', 'Resources', 'Misc', 'Gear', 'Fish',
];

export async function download(url, file, headers = {}) {
  const target = path.join(CACHE, file);
  if (offline && fs.existsSync(target)) return fs.readFileSync(target);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(target, buf);
  return buf;
}

/** Minimal reader for regular (non-zip64) archives: file name -> () => Buffer. */
export function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    files.set(name, () => {
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}

export const parseJson = (buf) => JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));

/** AlecaFrame's game data archive: name -> parsed JSON (throws for a missing file). */
export async function alecaFrameData() {
  const zip = readZip(await download(AF_DATA_URL, 'json.zip'));
  const json = (name) => {
    const entry = zip.get(name);
    if (!entry) throw new Error(`${name} not found in ${AF_DATA_URL}`);
    return parseJson(entry());
  };
  return { has: (name) => zip.has(name), json };
}

// DE's export files are one-line JSON with raw line breaks inside strings.
const CONTROL = { '\r': '\\r', '\n': '\\n', '\t': '\\t' };
function parseExport(text) {
  try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/[\r\n\t]/g, (c) => CONTROL[c])); }
}

/** The game's public export (content.warframe.com/PublicExport) in one language: { ExportWeapons: {...}, ... }. */
export async function deExports(lang, names) {
  const index = String(lzma.decompress(await download(`${DE_EXPORT}/index_${lang}.txt.lzma`, `de-index-${lang}.lzma`)));
  const out = {};
  for (const name of names) {
    const entry = index.split(/\r?\n/).find((line) => line.startsWith(`${name}_${lang}.json!`));
    if (!entry) throw new Error(`${name}_${lang}.json is not in DE's export index`);
    const buf = await download(`${DE_EXPORT}/Manifest/${entry}`, `de-${name}-${lang}.json`);
    out[name] = parseExport(buf.toString('utf8').replace(/^\uFEFF/, ''));
  }
  return out;
}
