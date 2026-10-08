// Renders the AlecaFrame main window in headless Chrome (Overwolf API stubbed, no network)
// in English and Russian, clicks through the tabs, saves screenshots and lists
// elements whose text overflows only in Russian.
// Usage: node tools/preview.mjs <AlecaFrame dir> [outDir]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const appDir = path.resolve(process.argv[2] ?? 'vendor/AlecaFrame');
const webDir = fs.existsSync(path.join(appDir, 'web')) ? path.join(appDir, 'web') : appDir;
const outDir = path.resolve(process.argv[3] ?? 'preview-out');
const bundlePath = path.resolve('dist/alecaframe-ru.js');
fs.mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(webDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(webDir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Every overwolf.* access returns a callable no-op; callbacks never fire, so
// the UI renders its empty/loading state, which is enough to check labels.
const STUB = `(() => {
  const h = { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : P), apply: () => P, construct: () => P };
  const P = new Proxy(function () {}, h);
  window.overwolf = P;
})();`;

const TABS = ['tabFoundry', 'tabMasteryHelper', 'tabInventory', 'tabRelicPlanner', 'tabRivenExplorer', 'tabWarframeMarket', 'proAnalyticsTab', 'tabStats', 'tabAbout'];

function collectOverflows() {
  const out = [];
  const cssPath = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
      if (e.id) { parts.unshift('#' + e.id); break; }
      const cls = [...e.classList].slice(0, 2).join('.');
      const idx = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
      parts.unshift(e.tagName.toLowerCase() + (cls ? '.' + cls : '') + `:nth-child(${idx + 1})`);
    }
    return parts.join(' > ');
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length || !el.clientWidth) continue;
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
    if (!/[A-Za-zА-Яа-яЁё]{2}/.test(ownText)) continue;
    const clipsY = getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2;
    if (el.scrollWidth > el.clientWidth + 2 || clipsY) out.push({ path: cssPath(el), text: ownText.slice(0, 80), over: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight) });
  }
  return out;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/local/bin/google-chrome', args: ['--no-sandbox'] });
const results = {};
for (const lang of ['en', 'ru']) {
  const ctx = await browser.newContext({ viewport: { width: 1770, height: 800 } });
  await ctx.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  await ctx.addInitScript(STUB);
  if (lang === 'ru') await ctx.addInitScript({ path: bundlePath });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/main.html`, { waitUntil: 'load' });
  // Game data never arrives here, so the full-window loading modal would stay
  // up and swallow every click.
  await page.addStyleTag({ content: '#loadingScreen { display: none !important; }' });
  await page.waitForTimeout(1500);
  results[lang] = {};
  for (const tab of TABS) {
    const item = page.locator(`.menuItem[tabId="${tab}"]`);
    if (!(await item.count())) continue;
    await item.click({ force: true, timeout: 3000 });
    await page.waitForTimeout(400);
    const visible = await page.evaluate((id) => (document.getElementById(id)?.getClientRects().length ?? 0) > 0, tab);
    await page.screenshot({ path: path.join(outDir, `${lang}-${tab}.png`) });
    results[lang][tab] = { visible, overflows: await page.evaluate(collectOverflows) };
  }
  if (lang === 'ru') {
    const missing = await page.evaluate(() => window.__AF_RU__.missing());
    fs.writeFileSync(path.join(outDir, 'missing.txt'), missing.join('\n') + '\n');
    console.log(`ru: ${missing.length} untranslated texts seen (see missing.txt)`);
  }
  console.log(`${lang}: ${errors.length} page errors`, [...new Set(errors)].slice(0, 3));
  await ctx.close();
}
await browser.close();
server.close();

const report = [];
for (const [tab, ru] of Object.entries(results.ru)) {
  const enPaths = new Set((results.en[tab]?.overflows ?? []).map((o) => o.path));
  const fresh = ru.overflows.filter((o) => !enPaths.has(o.path));
  report.push(`## ${tab} (tab shown: ${ru.visible}; overflows en=${results.en[tab]?.overflows.length ?? '-'} ru=${ru.overflows.length}, new in ru=${fresh.length})`);
  for (const o of fresh) report.push(`  +${o.over}px  ${o.text}  ::  ${o.path}`);
}
fs.writeFileSync(path.join(outDir, 'overflow-report.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
