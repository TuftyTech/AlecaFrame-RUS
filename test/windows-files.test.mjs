import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = (dir, ext) =>
  fs.readdirSync(path.join(root, dir)).filter((f) => ext.some((e) => f.endsWith(e))).map((f) => path.join(dir, f));

const scripts = [...list('windows', ['.ps1', '.psm1']), ...list('test', ['.ps1'])];
const commands = list('.', ['.cmd']);

const hasBom = (buf) => buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const bareLf = (text) => /(^|[^\r])\n/.test(text);

// PowerShell 5.1 reads a script without BOM as ANSI, which breaks every Cyrillic string.
test('PowerShell scripts are UTF-8 with BOM and CRLF', () => {
  assert.ok(scripts.length >= 5);
  for (const file of scripts) {
    const buf = fs.readFileSync(path.join(root, file));
    assert.ok(hasBom(buf), `${file}: missing UTF-8 BOM`);
    assert.ok(!bareLf(buf.toString('utf8')), `${file}: LF line endings`);
  }
});

test('cmd files are ASCII with CRLF', () => {
  assert.deepEqual(commands.map((f) => path.basename(f)).sort(), ['Install.cmd', 'Start.cmd', 'Uninstall.cmd']);
  for (const file of commands) {
    const text = fs.readFileSync(path.join(root, file), 'latin1');
    assert.ok(!/[^\x00-\x7f]/.test(text), `${file}: non-ASCII characters`);
    assert.ok(!bareLf(text), `${file}: LF line endings`);
  }
});

test('every file the installer copies exists', () => {
  const module = fs.readFileSync(path.join(root, 'windows', 'AlecaFrameRU.psm1'), 'utf8');
  const required = module.match(/\$script:AppFiles = @\(([^)]*)\)/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.ok(required.length >= 4);
  for (const rel of required) assert.ok(fs.existsSync(path.join(root, ...rel.split('\\'))), `${rel} is missing`);
});
