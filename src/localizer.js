/*
 * AlecaFrame-RU: runtime localizer for AlecaFrame windows.
 * Only rewrites visible text (text nodes and a few text attributes).
 * Does not touch application logic, ads or subscription code.
 */
(function (root, dict, css) {
  'use strict';
  if (!root || !root.document || root.__AF_RU__) return;

  var doc = root.document;
  var TEXT_ATTRS = ['title', 'placeholder', 'aria-label', 'data-tippy-content'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  // .inventoryItemName: its innerText is read back as the warframe.market item name.
  // Ad slots: left exactly as delivered.
  var SKIP_SELECTOR = '[translate="no"], .notranslate, [contenteditable="true"], .inventoryItemName, #mainADinner, [class*="adAttr"], iframe';
  var LETTERS = /[A-Za-z]/;
  var CYRILLIC = /[А-Яа-яЁё]/;

  var exact = new Map(Object.entries(dict.exact || {}));
  var patterns = Object.keys(dict.patterns || {})
    .map(function (src) { return compilePattern(src, dict.patterns[src]); })
    .filter(Boolean)
    // Longer literal text first, so "Owned: {0} / {1}" wins over "Owned: {0}".
    .sort(function (a, b) { return b.literalLength - a.literalLength; });

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function compilePattern(src, dst) {
    var parts = src.split(/(\{\d+\})/);
    var re = '^';
    var order = [];
    var literalLength = 0;
    parts.forEach(function (p) {
      var m = /^\{(\d+)\}$/.exec(p);
      if (m) { re += '(.+?)'; order.push(Number(m[1])); }
      else { re += escapeRe(p); literalLength += p.length; }
    });
    if (!literalLength) return null;
    return { re: new RegExp(re + '$'), order: order, dst: dst, prefix: parts[0], literalLength: literalLength };
  }

  function normalize(s) { return s.replace(/\s+/g, ' ').trim(); }

  function translateNormalized(t) {
    var hit = exact.get(t);
    if (hit !== undefined) return hit;
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      if (p.prefix && t.lastIndexOf(p.prefix, 0) !== 0) continue;
      var m = p.re.exec(t);
      if (!m) continue;
      var values = [];
      p.order.forEach(function (idx, j) { values[idx] = m[j + 1]; });
      return p.dst.replace(/\{(\d+)\}/g, function (_, idx) {
        var v = values[Number(idx)];
        if (v === undefined) return '';
        var inner = exact.get(v.trim());
        return inner !== undefined ? inner : v;
      });
    }
    return null;
  }

  // Known text -> its translation (may equal the input, e.g. brand names); unknown -> null.
  function lookup(s) {
    if (typeof s !== 'string' || !LETTERS.test(s)) return null;
    var out = translateNormalized(normalize(s));
    if (out == null) return null;
    // A fragment after a link may need to start with a comma ("здесь, чтобы ..."),
    // so the space that separated the English words is dropped.
    var lead = /^[,.;:!?]/.test(out) ? '' : /^\s*/.exec(s)[0];
    return lead + out + /\s*$/.exec(s)[0];
  }

  /** Returns the Russian text (keeping surrounding whitespace) or null if there is nothing to change. */
  function translate(s) {
    var out = lookup(s);
    return out === s ? null : out;
  }

  // Remember what we wrote so our own mutations are not processed again.
  var writtenText = new WeakMap();
  var writtenAttr = new WeakMap();
  var stats = { text: 0, attrs: 0, missed: new Map() };
  var MAX_MISSES = 3000;

  function isSkippedElement(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP_TAGS[e.tagName]) return true;
    }
    return !!(el && el.nodeType === 1 && el.closest && el.closest(SKIP_SELECTOR));
  }

  function translateTextNode(node) {
    var value = node.nodeValue;
    if (writtenText.get(node) === value) return;
    // Raw Vue template text: translate the rendered result instead, so that
    // interpolated values can be translated too.
    if (value.indexOf('{{') !== -1) return;
    var out = lookup(value);
    if (out == null) {
      // Cyrillic means Vue re-created a node from an already translated template.
      if (stats.missed.size < MAX_MISSES && LETTERS.test(value) && !CYRILLIC.test(value)) {
        var key = normalize(value);
        stats.missed.set(key, (stats.missed.get(key) || 0) + 1);
      }
      return;
    }
    if (out === value) return;
    var parent = node.parentNode;
    // <option> without value="" takes its value from its text; pin the original.
    if (parent && parent.tagName === 'OPTION' && !parent.hasAttribute('value')) {
      parent.setAttribute('value', parent.text);
    }
    writtenText.set(node, out);
    node.nodeValue = out;
    stats.text++;
  }

  function translateAttr(el, name) {
    var value = el.getAttribute(name);
    if (!value) return;
    var written = writtenAttr.get(el);
    if (written && written[name] === value) return;
    var out;
    if (name === 'data-tippy-content' && /<\w/.test(value)) out = translateHtml(value);
    else out = translate(value);
    if (out == null || out === value) return;
    if (!written) { written = {}; writtenAttr.set(el, written); }
    written[name] = out;
    el.setAttribute(name, out);
    stats.attrs++;
  }

  function translateHtml(html) {
    var tpl = doc.createElement('template');
    tpl.innerHTML = html;
    var before = tpl.innerHTML;
    translateTree(tpl.content);
    return tpl.innerHTML === before ? null : tpl.innerHTML;
  }

  function translateElement(el) {
    for (var i = 0; i < TEXT_ATTRS.length; i++) {
      if (el.hasAttribute(TEXT_ATTRS[i])) translateAttr(el, TEXT_ATTRS[i]);
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) translateAttr(el, 'value');
  }

  var walkerFilter = {
    acceptNode: function (n) {
      if (n.nodeType === 1) {
        if (SKIP_TAGS[n.tagName] || (n.matches && n.matches(SKIP_SELECTOR))) return 2; // FILTER_REJECT
      }
      return 1; // FILTER_ACCEPT
    }
  };

  function translateTree(node) {
    if (!node) return;
    if (node.nodeType === 3) { translateTextNode(node); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (walkerFilter.acceptNode(node) === 2) return;
      translateElement(node);
      if (node.tagName === 'TEMPLATE') translateTree(node.content);
    }
    var walker = doc.createTreeWalker(node, 1 | 4, walkerFilter); // SHOW_ELEMENT | SHOW_TEXT
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) translateTextNode(n);
      else {
        translateElement(n);
        if (n.tagName === 'TEMPLATE') translateTree(n.content);
      }
    }
  }

  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'childList') {
        if (isSkippedElement(r.target)) continue;
        for (var j = 0; j < r.addedNodes.length; j++) translateTree(r.addedNodes[j]);
      } else if (r.type === 'characterData') {
        if (!isSkippedElement(r.target.parentNode)) translateTextNode(r.target);
      } else if (r.type === 'attributes') {
        if (r.attributeName === 'value' && !(r.target.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(r.target.type))) continue;
        if (!isSkippedElement(r.target)) translateAttr(r.target, r.attributeName);
      }
    }
  }

  function wrapDialog(name) {
    var original = root[name];
    if (typeof original !== 'function') return;
    root[name] = function (message) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof message === 'string') { var out = translate(message); if (out != null) args[0] = out; }
      return original.apply(this, args);
    };
  }

  function decorateDocument() {
    var html = doc.documentElement;
    if (!html) return false;
    html.setAttribute('lang', 'ru');
    if (css && !doc.getElementById('afru-style')) {
      var style = doc.createElement('style');
      style.id = 'afru-style';
      style.textContent = css;
      (doc.head || html).appendChild(style);
    }
    return true;
  }

  function start() {
    var target = doc.documentElement || doc;
    // Injected before parsing: <html>/<head> do not exist yet.
    if (!decorateDocument()) doc.addEventListener('DOMContentLoaded', decorateDocument);
    translateTree(target);
    // Written to Overwolf's per-window log; the launcher waits for this line.
    try { root.console.log('[AlecaFrame-RU] loaded v' + (dict.version || 'dev')); } catch (e) { /* no console */ }
    new root.MutationObserver(onMutations).observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TEXT_ATTRS.concat('value'),
    });
  }

  ['alert', 'confirm', 'prompt'].forEach(wrapDialog);
  root.__AF_RU__ = {
    version: dict.version || 'dev',
    translate: translate,
    translateTree: translateTree,
    stats: stats,
    /** Untranslated texts seen in this window, for reporting gaps in the dictionary. */
    missing: function () { return Array.from(stats.missed.keys()).sort(); },
  };
  start();
})(typeof window !== 'undefined' ? window : null, /*__AF_RU_DICT__*/ { exact: {}, patterns: {} }, /*__AF_RU_CSS__*/ '');
