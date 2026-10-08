// Renders the AlecaFrame main window in headless Chrome (Overwolf API stubbed, no network)
// in English and Russian, clicks through the tabs, saves screenshots and lists
// elements whose text overflows only in Russian.
// Usage: node tools/preview.mjs <AlecaFrame dir> [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, OVERWOLF_STUB, collectOverflows, serveStatic, webDirOf } from './harness.mjs';

const appDir = path.resolve(process.argv[2] ?? 'vendor/AlecaFrame');
const outDir = path.resolve(process.argv[3] ?? 'preview-out');
const bundlePath = path.resolve('dist/alecaframe-ru.js');
fs.mkdirSync(outDir, { recursive: true });

const server = await serveStatic(webDirOf(appDir));
const { base } = server;

const TABS = ['tabFoundry', 'tabMasteryHelper', 'tabInventory', 'tabRelicPlanner', 'tabRivenExplorer', 'tabWarframeMarket', 'proAnalyticsTab', 'tabStats', 'tabAbout'];

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const results = {};
for (const lang of ['en', 'ru']) {
  const ctx = await browser.newContext({ viewport: { width: 1770, height: 800 } });
  await ctx.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  await ctx.addInitScript(OVERWOLF_STUB);
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
