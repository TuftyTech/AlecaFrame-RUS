// Shared pieces of the headless-Chrome previews: a static server for the AlecaFrame
// web folder, an Overwolf API stub and the probe for text that does not fit.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const CHROME = process.env.CHROME ?? '/usr/local/bin/google-chrome';

export function webDirOf(appDir) {
  return fs.existsSync(path.join(appDir, 'web')) ? path.join(appDir, 'web') : appDir;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };

export async function serveStatic(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Every overwolf.* access returns a callable no-op whose callbacks never fire, so
// pages render their empty/loading state. An earlier init script may provide real
// behavior in window.__AFRU_MOCK__ = { plugin: {...}, overwolf: { windows: {...}, ... } }.
export const OVERWOLF_STUB = `(() => {
  const h = { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : P), apply: () => P, construct: () => P };
  const P = new Proxy(function () {}, h);
  const mock = window.__AFRU_MOCK__ || {};
  const withFallback = (obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : P) });
  const native = withFallback(mock.plugin || {});
  const plugin = withFallback({ get: () => native });
  const spaces = {};
  for (const [name, fns] of Object.entries(mock.overwolf || {})) spaces[name] = withFallback(fns);
  spaces.windows = withFallback(Object.assign({ getMainWindow: () => withFallback({ plugin }) }, (mock.overwolf || {}).windows));
  window.overwolf = new Proxy({}, { get: (t, k) => spaces[k] || P });
})();`;

/** Runs in the page: visible elements (inside `scope`, if given) whose own text is clipped. */
export function collectOverflows(scope) {
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
  for (const el of document.querySelectorAll(scope ? `${scope} *` : 'body *')) {
    if (!el.getClientRects().length || !el.clientWidth) continue;
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
    if (!/[A-Za-zА-Яа-яЁё]{2}/.test(ownText)) continue;
    const clipsY = getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2;
    if (el.scrollWidth > el.clientWidth + 2 || clipsY) out.push({ path: cssPath(el), text: ownText.slice(0, 80), over: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight) });
  }
  return out;
}
