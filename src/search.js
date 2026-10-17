/*
 * AlecaFrame-RUS: Russian search in AlecaFrame's search fields.
 * AlecaFrame filters in its C# plugin by a substring of the English item name. A Russian query (or one
 * typed in the wrong keyboard layout) becomes the English fragment that finds the same items, and results
 * the fragment finds only by accident ("ash" inside "Flash") are dropped again. English queries pass as typed.
 * The plugin object is shared by every AlecaFrame window and is never modified: each window gets a wrapper.
 */
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AF_RU_SEARCH__) return;

  // Methods that take the query itself; every other method is checked for a JSON filter with "search".
  var RAW_QUERY_METHODS = { GetWFMarketSearchSuggestions: 1, GetRivenWeapons: 1 };
  var CYRILLIC = /[А-Яа-яЁё]/;
  var EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
  var RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбюё';
  // Relic codes typed with Russian letters: «лит а1» means «Lith A1».
  var LOOKALIKE = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x' };
  var MAX_CANDIDATE_NAMES = 24;
  var MAX_NARROW_NAMES = 400;
  var CACHE_SIZE = 64;

  var index = null;
  var cache = new Map();

  function normalize(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  function swapLayout(s, from, to) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var lower = c.toLowerCase();
      var at = from.indexOf(lower);
      out += at < 0 ? c : (c === lower ? to.charAt(at) : to.charAt(at).toUpperCase());
    }
    return out;
  }

  function foldToken(t) {
    if (!/\d/.test(t)) return t;
    var out = '';
    for (var i = 0; i < t.length; i++) out += LOOKALIKE[t.charAt(i)] || t.charAt(i);
    return out;
  }

  /** Lower-case words without punctuation; «ё» is «е», relic codes are Latin. */
  function tokenize(s) {
    return String(s).toLowerCase().replace(/ё/g, 'е').split(/[^0-9a-zа-я]+/).filter(Boolean).map(foldToken);
  }

  function itemNames() {
    var api = root.__AF_RU__;
    return api && typeof api.items === 'function' ? api.items() : {};
  }

  function buildIndex() {
    var names = itemNames();
    var list = [];
    var byName = new Map();
    Object.keys(names).forEach(function (en) {
      var entry = { en: en, lower: en.toLowerCase(), ru: names[en], words: tokenize(names[en] + ' ' + en) };
      list.push(entry);
      byName.set(entry.lower, entry);
    });
    return { list: list, byName: byName };
  }

  function getIndex() {
    if (!index || !index.list.length) index = buildIndex();
    return index;
  }

  function matchesTokens(words, tokens) {
    for (var i = 0; i < tokens.length; i++) {
      var found = false;
      for (var j = 0; j < words.length && !found; j++) found = words[j].lastIndexOf(tokens[i], 0) === 0;
      if (!found) return false;
    }
    return true;
  }

  function findItems(tokens) {
    var list = getIndex().list;
    var out = [];
    for (var i = 0; i < list.length; i++) if (matchesTokens(list[i].words, tokens)) out.push(list[i]);
    // Short names first: they make the best fragments and the best suggestions.
    return out.sort(function (a, b) { return a.ru.length - b.ru.length || (a.en < b.en ? -1 : 1); });
  }

  function englishHit(lower) {
    var list = getIndex().list;
    for (var i = 0; i < list.length; i++) if (list[i].lower.indexOf(lower) >= 0) return true;
    return false;
  }

  /** Contiguous word sequences of the best matches, as candidates for the substring sent to AlecaFrame. */
  function candidates(matches) {
    var seen = {};
    var out = [];
    for (var i = 0; i < matches.length && i < MAX_CANDIDATE_NAMES; i++) {
      var words = matches[i].en.split(' ');
      for (var from = 0; from < words.length; from++) {
        for (var to = from + 1; to <= words.length; to++) {
          var text = words.slice(from, to).join(' ');
          var lower = text.toLowerCase();
          if (lower.length < 2 || seen[lower]) continue;
          seen[lower] = true;
          out.push({ text: text, lower: lower });
        }
      }
    }
    return out;
  }

  /**
   * The fragment that finds most of the matched items and the fewest other items.
   * Returns { fragment, names (Set of lower-case English names), tokens, exact } or null.
   */
  function buildPlan(matches, tokens) {
    var names = new Set(matches.map(function (m) { return m.lower; }));
    var scored = candidates(matches).map(function (c) {
      var covered = 0;
      for (var i = 0; i < matches.length && i < MAX_NARROW_NAMES; i++) if (matches[i].lower.indexOf(c.lower) >= 0) covered++;
      c.covered = covered;
      return c;
    });
    var best = 0;
    scored.forEach(function (c) { if (c.covered > best) best = c.covered; });
    var list = getIndex().list;
    var top = scored.filter(function (c) { return c.covered === best; }).map(function (c) {
      var extra = 0;
      for (var i = 0; i < list.length; i++) if (list[i].lower.indexOf(c.lower) >= 0 && !names.has(list[i].lower)) extra++;
      c.extra = extra;
      return c;
    });
    top.sort(function (a, b) { return a.extra - b.extra || b.lower.length - a.lower.length; });
    if (!top.length) return null;
    return { fragment: top[0].text, names: names, tokens: tokens, exact: top[0].extra === 0 && best === Math.min(matches.length, MAX_NARROW_NAMES) };
  }

  function computePlan(query) {
    var q = normalize(query);
    if (!q) return null;
    if (!CYRILLIC.test(q)) {
      if (englishHit(q.toLowerCase())) return null;
      // «ytrjhf» is «некора» typed with the English layout.
      var swapped = swapLayout(q, EN_KEYS, RU_KEYS);
      var tokens = tokenize(swapped);
      var found = tokens.length ? findItems(tokens) : [];
      return found.length ? buildPlan(found, tokens) : null;
    }
    var ruTokens = tokenize(q);
    var matches = ruTokens.length ? findItems(ruTokens) : [];
    if (matches.length) return buildPlan(matches, ruTokens);
    // «ыщьф» is «soma» typed with the Russian layout.
    var latin = swapLayout(q, RU_KEYS, EN_KEYS);
    if (!CYRILLIC.test(latin) && englishHit(latin.toLowerCase())) return { fragment: latin, names: null, tokens: null, exact: true };
    return null;
  }

  /** What to send instead of the query, or null to leave it as typed. Cached per query. */
  function plan(query) {
    var key = normalize(query || '');
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    var result = null;
    try { result = computePlan(key); } catch (e) { result = null; }
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  }

  function wordStart(text, fragment) {
    for (var at = text.indexOf(fragment); at >= 0; at = text.indexOf(fragment, at + 1)) {
      if (at === 0 || !/[0-9a-z]/.test(text.charAt(at - 1))) return true;
    }
    return false;
  }

  function resultName(item) {
    if (typeof item === 'string') return item;
    return item && typeof item.name === 'string' ? item.name : null;
  }

  /** Keeps a result unless it is a known item whose names do not match the query. */
  function keepResult(p, item) {
    var name = resultName(item);
    if (name == null) return true;
    var lower = normalize(name).toLowerCase();
    if (p.names.has(lower)) return true;
    var entry = getIndex().byName.get(lower);
    // Not in the dictionary: kept when the fragment starts a word, so "Ash" keeps "Ash Skin" but not "Flash".
    if (!entry) return wordStart(lower, p.fragment.toLowerCase());
    if (matchesTokens(entry.words, p.tokens)) return true;
    // A set or relic is kept when it contains a matching part.
    if (typeof item === 'object' && p.names.size <= MAX_NARROW_NAMES) {
      var text = JSON.stringify(item).toLowerCase();
      var hit = false;
      p.names.forEach(function (n) { if (!hit && wordStart(text, n)) hit = true; });
      return hit;
    }
    return false;
  }

  /** Filters a JSON array returned by AlecaFrame; anything else is returned unchanged. */
  function narrow(p, json) {
    if (!p || p.exact || !p.names || typeof json !== 'string') return json;
    var list;
    try { list = JSON.parse(json); } catch (e) { return json; }
    if (!Array.isArray(list)) return json;
    var kept = list.filter(function (item) { return keepResult(p, item); });
    return kept.length === list.length ? json : JSON.stringify(kept);
  }

  function rewriteArgs(method, args) {
    var first = args[0];
    if (typeof first !== 'string') return null;
    if (RAW_QUERY_METHODS[method]) {
      var raw = plan(first);
      if (raw) args[0] = raw.fragment;
      return raw;
    }
    if (first.charAt(0) !== '{' || first.indexOf('"search"') < 0) return null;
    var filter = JSON.parse(first);
    if (!filter || typeof filter.search !== 'string') return null;
    var p = plan(filter.search);
    if (!p) return null;
    filter.search = p.fragment;
    args[0] = JSON.stringify(filter);
    return p;
  }

  function wrapCallback(p, args) {
    for (var i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] !== 'function') continue;
      var callback = args[i];
      args[i] = function (success, data) {
        var rest = Array.prototype.slice.call(arguments);
        if (success && typeof data === 'string') {
          try { rest[1] = narrow(p, data); } catch (e) { rest[1] = data; }
        }
        return callback.apply(this, rest);
      };
      return;
    }
  }

  function call(target, fn, method, original) {
    var args = Array.prototype.slice.call(original);
    try {
      var p = rewriteArgs(method, args);
      if (p && p.names && !p.exact) wrapCallback(p, args);
    } catch (e) {
      args = Array.prototype.slice.call(original);
    }
    return fn.apply(target, args);
  }

  var clients = new WeakMap();

  /** A view of AlecaFrame's plugin instance that rewrites search queries; the instance itself is untouched. */
  function wrapClient(client) {
    if (!client || (typeof client !== 'object' && typeof client !== 'function') || typeof Proxy !== 'function') return client;
    var known = clients.get(client);
    if (known) return known;
    var methods = {};
    var proxy = new Proxy(client, {
      get: function (target, prop) {
        var value = target[prop];
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        var cached = methods[prop];
        if (!cached || cached.original !== value) {
          cached = methods[prop] = function () { return call(target, value, prop, arguments); };
          cached.original = value;
        }
        return cached;
      },
    });
    clients.set(client, proxy);
    return proxy;
  }

  root.__AF_RU_SEARCH__ = {
    plan: plan,
    narrow: narrow,
    wrapClient: wrapClient,
    tokenize: tokenize,
    /** Items matching a Russian or English query (any layout), best first: [{ en, ru }]. */
    find: function (query, limit) {
      var q = normalize(query || '');
      if (!q) return [];
      var text = CYRILLIC.test(q) || englishHit(q.toLowerCase()) ? q : swapLayout(q, EN_KEYS, RU_KEYS);
      var tokens = tokenize(text);
      return tokens.length ? findItems(tokens).slice(0, limit || 50).map(function (m) { return { en: m.en, ru: m.ru }; }) : [];
    },
    reset: function () { index = null; cache.clear(); },
  };

  // The main window has every search field: build the index while idle, not on the first keystroke.
  if (/(^|\/)main\.html$/i.test((root.location && root.location.pathname) || '')) {
    var idle = root.requestIdleCallback || function (fn) { return root.setTimeout(fn, 1); };
    root.setTimeout(function () { idle(function () { try { getIndex(); } catch (e) { /* built on demand */ } }); }, 2000);
  }
})(typeof window !== 'undefined' ? window : null);
