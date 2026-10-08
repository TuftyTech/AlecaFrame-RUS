// Collects user-visible English strings from an installed AlecaFrame UI
// (HTML templates, inline/linked scripts) into strings/en.json.
// Usage: node tools/extract.mjs <path-to-AlecaFrame-version-dir>
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const appDir = path.resolve(process.argv[2] ?? 'vendor/AlecaFrame');
const webDir = fs.existsSync(path.join(appDir, 'web')) ? path.join(appDir, 'web') : appDir;
const outFile = path.resolve('strings/en.json');

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE']);
const TEXT_ATTRS = ['title', 'placeholder', 'aria-label', 'data-tippy-content'];
// Third-party bundles have no AlecaFrame UI text.
const SKIP_JS = /(^|\/)(external|tippy)\/|signalr\.js$|jquery|toastify\.js$|tilt\.jquery\.js$|ga\.js$/;
// Calls whose string arguments are selectors, storage keys, logs, etc.
const NON_UI_CALLEE = /^(console\.\w+|\$|jQuery|document\.\w+|\w+\.(getElementsByClassName|getElementById|querySelector(All)?|addClass|removeClass|hasClass|toggleClass|attr|prop|data|css|on|off|one|trigger|is|find|closest|parents?|children|addEventListener|removeEventListener|setAttribute|getAttribute|removeAttribute|includes|startsWith|endsWith|indexOf|split|replace|replaceAll|match|localeCompare|getItem|setItem|removeItem|send|invoke|postMessage)|ga|gtag|overwolf\..*|plugin\..*|localStorage\..*|fetch|require|Date|RegExp|parseInt|parseFloat)$/;

const found = new Map();
function add(key, file, type) {
  if (!key) return;
  const entry = found.get(key) ?? { files: new Set(), types: new Set() };
  entry.files.add(file);
  entry.types.add(type);
  found.set(key, entry);
}

// Vue merges text and {{ }} interpolations into one text node, so a template
// like "Owned: {{n}}" becomes the pattern "Owned: {0}".
export function toKey(raw, placeholderRe = /\{\{[\s\S]*?\}\}/g) {
  let i = 0;
  const key = raw.replace(/\s+/g, ' ').trim().replace(placeholderRe, () => `{${i++}}`);
  const literal = key.replace(/\{\d+\}/g, ' ');
  if (!/[A-Za-z]{2,}/.test(literal)) return null;
  if (/^\{\d+\}$/.test(key)) return null;
  if (/[A-Za-z0-9+/=]{60,}/.test(key)) return null; // inline base64 images
  return key;
}

function looksLikeUiText(s) {
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/^(https?:|wss?:|data:|\.\.?\/|#|\.|\[|\/|\?|,|X:\/\/)/.test(s) || /:\/\/|sprite\.svg/.test(s)) return false;
  if (/^:\w+:$/.test(s)) return false; // discord emoji codes
  if (/^(url|calc|rgba?|translate|scale)\(/.test(s)) return false;
  if (/(^|\s)[a-z]+[A-Z]\w*/.test(s)) return false; // camelCase identifiers
  if (/^[\w$.-]+$/.test(s) && !/^[A-Z][a-z]+$/.test(s) && !/^[A-Z]{2,5}$/.test(s)) return false; // identifiers, classes, keys
  if (/^[a-z][\w-]*(\s+[a-z][\w-]*)*$/.test(s) && /-|[a-z][A-Z]/.test(s)) return false; // css class lists
  if (/[{};]|=>|\$\(|function\s*\(|\w\(\)/.test(s)) return false;
  if (/^[a-z-]+:\s*[\w#.%-]+;?$/.test(s)) return false; // inline css (lowercase property, unlike "Error: X")
  if (/\.(png|webp|jpg|gif|svg|html|js|css|json|dat)$/i.test(s)) return false;
  if (/^[A-Z][a-z]+([A-Z][a-z0-9]+)+$/.test(s)) return false; // PascalCase identifiers
  return true;
}

function extractHtmlFragment(html, file, type) {
  const frag = JSDOM.fragment(html);
  walkDom(frag, file, type);
}

function walkDom(root, file, type = 'html') {
  for (const node of root.childNodes) {
    if (node.nodeType === 3) {
      add(toKey(node.nodeValue), file, type);
      for (const m of node.nodeValue.matchAll(/\{\{([\s\S]*?)\}\}/g)) if (/['"`]/.test(m[1])) extractVueExpression(m[1], file);
    } else if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT') {
        if (!node.getAttribute('src') && node.textContent.trim()) extractJs(node.textContent, file);
        continue;
      }
      if (SKIP_TAGS.has(node.tagName)) continue;
      for (const { name, value } of node.attributes) {
        if (/^(:|v-bind:|v-html$|v-text$|v-if$|v-else-if$|v-show$)/.test(name) && /['"`]/.test(value)) extractVueExpression(value, file);
      }
      for (const attr of TEXT_ATTRS) {
        const v = node.getAttribute(attr);
        if (!v || v.includes('{{')) continue;
        if (/<\w/.test(v)) extractHtmlFragment(v, file, 'attr');
        else add(toKey(v), file, 'attr');
      }
      if (node.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(node.getAttribute('type') ?? '')) {
        add(toKey(node.getAttribute('value') ?? ''), file, 'attr');
      }
      walkDom(node.tagName === 'TEMPLATE' ? node.content : node, file, type);
    }
  }
}

// String literals inside Vue expressions, e.g. {{ vaulted ? 'Vaulted' : 'Unvaulted' }}.
function extractVueExpression(expr, file) {
  extractJs(`(${expr.replace(/\s+\|\s+\w+$/, '')})`, file, 'vue', true);
}

function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    const prop = node.computed ? '*' : node.property.name;
    return `${calleeName(node.object)}.${prop}`;
  }
  if (node.type === 'CallExpression') return calleeName(node.callee);
  return '?';
}

// "a" + x + "b" -> "a{0}b"; returns null if the chain has no string literal.
function flattenConcat(node, parts = []) {
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    flattenConcat(node.left, parts);
    flattenConcat(node.right, parts);
  } else parts.push(node);
  return parts;
}

const PH = '\u0001';
function partsToTemplate(parts) {
  let out = '';
  let hasString = false;
  for (const p of parts) {
    if (p.type === 'Literal' && typeof p.value === 'string') { out += p.value; hasString = true; }
    else if (p.type === 'TemplateLiteral') {
      p.quasis.forEach((q, i) => { out += q.value.cooked ?? ''; if (i < p.expressions.length) out += PH; });
      hasString = true;
    } else out += PH;
  }
  return hasString ? out : null;
}

function addJsString(tpl, file, type = 'js') {
  if (tpl == null) return;
  if (/<[a-zA-Z/][^>]*>/.test(tpl)) {
    // HTML built in JS: the browser splits it into text nodes, extract those.
    let i = 0;
    const html = tpl.replaceAll(PH, () => `{{p${i++}}}`);
    try { extractHtmlFragment(html, file, 'js-html'); } catch { /* malformed fragment */ }
    return;
  }
  const key = toKey(tpl, new RegExp(PH, 'g'));
  if (key && looksLikeUiText(key.replace(/\{\d+\}/g, 'X'))) add(key, file, type);
}

function extractJs(code, file, type = 'js', quiet = false) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true });
  } catch (e) {
    if (!quiet) console.warn(`! ${file}: ${e.message}`);
    return;
  }
  // acorn-walk visits children before parents, so mark the pieces of every
  // "a" + x + "b" chain up front; the chain itself is extracted as one pattern.
  const consumed = new WeakSet();
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors[ancestors.length - 2];
    if (node.type === 'BinaryExpression' && node.operator === '+' && !(parent?.type === 'BinaryExpression' && parent.operator === '+')) {
      flattenConcat(node).forEach((p) => consumed.add(p));
    }
  });
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    if (consumed.has(node)) return;
    const parent = ancestors[ancestors.length - 2];
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === 'CallExpression' && a.arguments.includes(ancestors[i + 1]) && NON_UI_CALLEE.test(calleeName(a.callee))) return;
    }
    if (parent?.type === 'MemberExpression' && parent.computed && parent.property === node) return; // obj["key"]
    if (parent?.type === 'Property' && parent.key === node) return;
    if (parent?.type === 'BinaryExpression' && /^[=!]==?$/.test(parent.operator)) return; // comparisons
    if (parent?.type === 'SwitchCase') return;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      if (parent?.type === 'BinaryExpression' && parent.operator === '+') return; // handled by the outermost chain
      addJsString(partsToTemplate(flattenConcat(node)), file, type);
    } else if (node.type === 'TemplateLiteral') {
      addJsString(partsToTemplate([node]), file, type);
    } else if (node.type === 'Literal' && typeof node.value === 'string') {
      addJsString(node.value, file, type);
    }
  });
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? filesUnder(p) : [p];
  });
}

const files = filesUnder(webDir).sort();
for (const abs of files) {
  const rel = path.relative(webDir, abs).replaceAll('\\', '/');
  if (rel.endsWith('.html')) {
    const dom = new JSDOM(fs.readFileSync(abs, 'utf8'));
    const doc = dom.window.document;
    add(toKey(doc.title), rel, 'html');
    walkDom(doc.documentElement, rel);
  } else if (rel.endsWith('.js') && !SKIP_JS.test(rel)) {
    extractJs(fs.readFileSync(abs, 'utf8'), rel);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const out = {
  alecaframeVersion: manifest?.meta?.version ?? null,
  strings: Object.fromEntries(
    [...found.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { files: [...v.files].sort(), types: [...v.types].sort() }]),
  ),
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
const byType = {};
for (const v of found.values()) for (const t of v.types) byType[t] = (byType[t] ?? 0) + 1;
console.log(`AlecaFrame ${out.alecaframeVersion}: ${found.size} strings`, byType);
