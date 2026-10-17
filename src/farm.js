/*
 * AlecaFrame-RUS: «Где фармить» tab in the main window.
 *  - A relic: where it drops (mission, rotation, chance) and the fissures that open it right now.
 *  - A Prime part or set: which relics give it (rarity, chance) and whether each relic still drops.
 *  - Always: active fissures by era (normal, Steel Path, Void Storms), fast missions first, and the
 *    eras you own most relics of.
 * Queries are Russian or English in any keyboard layout (src/search.js). Data: api.warframestat.us
 * (DE's drop tables and world state, open CORS).
 */
(function (root) {
  'use strict';
  var extras = root && root.__AF_RU_EXTRAS__;
  if (!extras || extras.page !== 'main' || root.__AF_RU_FARM__) return;

  var doc = root.document;
  var el = extras.el;
  var TAB_ID = 'afruTabFarm';
  var ERAS = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
  var ERA_RU = { Lith: 'Лит', Meso: 'Мезо', Neo: 'Нео', Axi: 'Акси', Requiem: 'Реквием', Omnia: 'Омния', Vanguard: 'Авангард' };
  // Missions the community uses to open relics quickly: one relic in a few minutes.
  var FAST_MISSIONS = { Capture: 1, Exterminate: 1, Sabotage: 1, Rescue: 1 };
  var RELIC_NAME = /^(Lith|Meso|Neo|Axi|Requiem|Vanguard) (\S+) Relic$/i;
  var RELIC_PLACE = / Relic(?: \((?:Intact|Exceptional|Flawless|Radiant)\))?$/;
  var RARITY_RU = { Common: 'Обычная', Uncommon: 'Необычная', Rare: 'Редкая', Legendary: 'Легендарная', 'Very Common': 'Очень частая' };
  var config = {
    api: 'https://api.warframestat.us',
    fissuresTtlMs: 60 * 1000,
    requestTimeoutMs: 15000,
    maxLocations: 12,
    maxRelicChecks: 16,
  };

  var state = { query: '', selected: null, fissureFilter: 'all', fissures: null, fissuresAt: 0, owned: null, ownedAt: 0 };
  var dropCache = new Map();

  function ru(text) {
    var api = root.__AF_RU__;
    var out = api && typeof api.translate === 'function' ? api.translate(text) : null;
    return out || text;
  }

  function fetchJson(path) {
    if (typeof root.fetch !== 'function') return Promise.reject(new Error('no fetch'));
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = root.setTimeout(function () { reject(new Error('timeout')); }, config.requestTimeoutMs);
    });
    var request = root.fetch(config.api + path).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
    return Promise.race([request, timeout]).then(
      function (data) { root.clearTimeout(timer); return data; },
      function (e) { root.clearTimeout(timer); throw e; });
  }

  /** Drop table rows mentioning the name, cached for the session. */
  function drops(name) {
    var key = name.toLowerCase();
    if (!dropCache.has(key)) {
      var request = fetchJson('/drops/search/' + encodeURIComponent(name)).then(function (rows) {
        return Array.isArray(rows) ? rows : [];
      });
      request.catch(function () { dropCache.delete(key); });
      dropCache.set(key, request);
    }
    return dropCache.get(key);
  }

  // "Mercury/Apollodorus (Survival), Rot B" -> { planet, node, mission, rotation }
  function parsePlace(place) {
    var m = /^([^/]+)\/(.+?) \(([^)]+)\)(?:, Rot ([A-D]))?$/.exec(String(place || ''));
    if (!m) return { raw: String(place || '').replace(/, Rot ([A-D])/, ', ротация $1') };
    return { planet: m[1], node: m[2], mission: m[3], rotation: m[4] || '' };
  }

  function placeLabel(p) {
    if (p.raw) return p.raw;
    return ru(p.mission) + ' · ' + p.node + ' (' + ru(p.planet) + ')';
  }

  function percent(chance) {
    var n = Number(chance);
    return n >= 10 ? Math.round(n) + '%' : (Math.round(n * 100) / 100) + '%';
  }

  function timeLeft(expiry) {
    var ms = Date.parse(expiry) - Date.now();
    if (!(ms > 0)) return 'завершается';
    var min = Math.round(ms / 60000);
    return min >= 60 ? Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин' : min + ' мин';
  }

  function relicEra(name) {
    var m = RELIC_NAME.exec(name || '');
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null;
  }

  function relicLabel(name) {
    var m = RELIC_NAME.exec(name || '');
    return m ? 'Реликвия ' + (ERA_RU[relicEra(name)] || m[1]) + ' ' + m[2] : ru(name);
  }

  // ------------------------------------------------------------------ data

  function loadFissures(force) {
    if (!force && state.fissures && Date.now() - state.fissuresAt < config.fissuresTtlMs) return Promise.resolve(state.fissures);
    return fetchJson('/pc/fissures').then(function (list) {
      state.fissures = (Array.isArray(list) ? list : []).filter(function (f) { return f && f.active !== false && Date.parse(f.expiry) > Date.now(); });
      state.fissuresAt = Date.now();
      return state.fissures;
    });
  }

  function marketClient() {
    try {
      var client = root.plugin && typeof root.plugin.get === 'function' ? root.plugin.get() : null;
      return client && typeof client.getFilteredInventory === 'function' ? client : null;
    } catch (e) { return null; }
  }

  /** Owned relics per era from AlecaFrame's inventory: { Lith: 12, ... } or null when unavailable. */
  function loadOwnedRelics() {
    if (state.owned && Date.now() - state.ownedAt < 5 * 60 * 1000) return Promise.resolve(state.owned);
    var client = marketClient();
    if (!client) return Promise.resolve(null);
    var filter = {
      type: 'relics', search: '', order: 'name', orderLargerToSmaller: false, yesnoFilters: JSON.stringify({}), onlyOwned: true,
    };
    return new Promise(function (resolve) {
      var done = false;
      var timer = root.setTimeout(function () { finish(null); }, config.requestTimeoutMs);
      function finish(value) { if (done) return; done = true; root.clearTimeout(timer); resolve(value); }
      try {
        client.getFilteredInventory(JSON.stringify(filter), true, function (success, data) {
          if (!success) { finish(null); return; }
          var counts = {};
          var total = 0;
          try {
            JSON.parse(data).forEach(function (item) {
              var m = /^(Lith|Meso|Neo|Axi|Requiem)\b/i.exec(item && item.name || '');
              if (!m) return;
              var era = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
              var amount = Number(item.amountOwned);
              amount = amount > 0 ? amount : 1;
              counts[era] = (counts[era] || 0) + amount;
              total += amount;
            });
          } catch (e) { finish(null); return; }
          state.owned = total ? counts : null;
          state.ownedAt = Date.now();
          finish(state.owned);
        });
      } catch (e) { finish(null); }
    });
  }

  // --------------------------------------------------------------- render

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function badge(text, kind) { return el('span', { 'class': 'afru-badge' + (kind ? ' ' + kind : '') }, [text]); }

  function message(text, kind) { return el('div', { 'class': 'afru-farmMessage' + (kind ? ' ' + kind : '') }, [text]); }

  function fissureMatches(f) {
    if (state.fissureFilter === 'normal') return !f.isHard && !f.isStorm;
    if (state.fissureFilter === 'hard') return !!f.isHard;
    if (state.fissureFilter === 'storm') return !!f.isStorm;
    return true;
  }

  function sortFissures(list) {
    return list.slice().sort(function (a, b) {
      var fa = FAST_MISSIONS[a.missionType] ? 0 : 1;
      var fb = FAST_MISSIONS[b.missionType] ? 0 : 1;
      return fa - fb || Date.parse(b.expiry) - Date.parse(a.expiry);
    });
  }

  function nodeName(f) {
    return String(f.node || '').replace(/\(([^)]+)\)$/, function (_, planet) { return '(' + ru(planet) + ')'; });
  }

  function fissureRow(f) {
    var badges = [];
    if (FAST_MISSIONS[f.missionType]) badges.push(badge('быстро', 'fast'));
    if (f.isHard) badges.push(badge('Стальной Путь', 'hard'));
    if (f.isStorm) badges.push(badge('Буря Бездны', 'storm'));
    var node = nodeName(f);
    return el('div', { 'class': 'afru-fissure' }, [
      el('span', { 'class': 'afru-fissureMission' }, [ru(f.missionType || f.missionTypeKey || '?')]),
      el('span', { 'class': 'afru-fissureNode' }, [node + (f.enemy ? ' · ' + ru(f.enemy) : '')]),
      el('span', { 'class': 'afru-fissureBadges' }, badges),
      el('span', { 'class': 'afru-fissureLeft' }, [timeLeft(f.expiry)]),
    ]);
  }

  /** Active fissures of the eras, grouped by era; Omnia accepts relics of every era. */
  function fissureGroups(eras) {
    var list = (state.fissures || []).filter(fissureMatches);
    return eras.map(function (era) {
      var rows = sortFissures(list.filter(function (f) { return f.tier === era; }));
      return el('div', { 'class': 'afru-fissureGroup' }, [
        el('div', { 'class': 'afru-fissureEra' }, [
          ERA_RU[era] || era,
          el('span', { 'class': 'afru-count' }, [String(rows.length)]),
          era === 'Omnia' ? el('span', { 'class': 'afru-hint' }, ['подходит любая реликвия']) : null,
        ].filter(Boolean)),
      ].concat(rows.length ? rows.map(fissureRow) : [message('Сейчас нет таких разрывов', 'muted')]));
    });
  }

  function filterChips(onChange) {
    var options = [['all', 'Все'], ['normal', 'Обычные'], ['hard', 'Стальной Путь'], ['storm', 'Бури Бездны']];
    return el('div', { 'class': 'afru-chips', role: 'group', 'aria-label': 'Тип разрывов' }, options.map(function (o) {
      var chip = el('button', { type: 'button', 'class': 'afru-filter' + (state.fissureFilter === o[0] ? ' selected' : ''), 'aria-pressed': String(state.fissureFilter === o[0]) }, [o[1]]);
      chip.addEventListener('click', function () { state.fissureFilter = o[0]; onChange(); });
      return chip;
    }));
  }

  function ownedSummary(owned) {
    if (!owned) return null;
    var fissures = (state.fissures || []).filter(function (f) { return !f.isStorm; });
    var best = null;
    ERAS.slice(0, 5).forEach(function (era) {
      var count = owned[era] || 0;
      if (!count) return;
      var open = fissures.filter(function (f) { return f.tier === era && !f.isHard; });
      var fast = open.filter(function (f) { return FAST_MISSIONS[f.missionType]; });
      var score = count * (fast.length ? 3 : open.length ? 1 : 0);
      if (score && (!best || score > best.score)) best = { era: era, count: count, fissure: sortFissures(fast.length ? fast : open)[0], score: score };
    });
    var chips = ERAS.slice(0, 5).filter(function (era) { return owned[era]; }).map(function (era) {
      return badge(ERA_RU[era] + ': ' + owned[era]);
    });
    return el('div', { 'class': 'afru-farmCard' }, [
      el('div', { 'class': 'afru-farmCardTitle' }, ['Ваши реликвии']),
      el('div', { 'class': 'afru-chips' }, chips),
      best ? el('div', { 'class': 'afru-farmAdvice' }, [
        'Сейчас выгоднее открывать ' + ERA_RU[best.era] + ' (' + best.count + ' шт.): ' +
        ru(best.fissure.missionType) + ' · ' + nodeName(best.fissure) + ', ещё ' + timeLeft(best.fissure.expiry) + '.',
      ]) : message('Для ваших реликвий сейчас нет обычных разрывов.', 'muted'),
    ]);
  }

  function locationsTable(rows) {
    var sorted = rows.slice().sort(function (a, b) { return Number(b.chance) - Number(a.chance); });
    var shown = sorted.slice(0, config.maxLocations);
    var table = el('div', { 'class': 'afru-table', role: 'table' }, [
      el('div', { 'class': 'afru-tr head', role: 'row' }, ['Где', 'Ротация', 'Редкость', 'Шанс'].map(function (h) {
        return el('span', { role: 'columnheader' }, [h]);
      })),
    ].concat(shown.map(function (row) {
      var p = parsePlace(row.place);
      return el('div', { 'class': 'afru-tr', role: 'row' }, [
        el('span', { role: 'cell' }, [placeLabel(p)]),
        el('span', { role: 'cell' }, [p.rotation || '–']),
        el('span', { role: 'cell' }, [RARITY_RU[row.rarity] || row.rarity || '–']),
        el('span', { role: 'cell', 'class': 'num' }, [percent(row.chance)]),
      ]);
    })));
    if (sorted.length > shown.length) table.appendChild(message('Ещё ' + (sorted.length - shown.length) + ' мест с меньшим шансом.', 'muted'));
    return table;
  }

  function renderRelic(target, name) {
    var era = relicEra(name);
    target.appendChild(message('Загрузка таблиц выпадения…', 'muted'));
    Promise.all([drops(name), loadFissures().catch(function () { return null; })]).then(function (res) {
      if (state.selected !== name) return;
      clear(target);
      var rows = res[0].filter(function (r) { return String(r.item).toLowerCase() === name.toLowerCase() && !/Relic$/.test(r.place); });
      // The drop tables list the contents of an intact relic.
      var contents = res[0].filter(function (r) { return String(r.place).toLowerCase() === name.toLowerCase(); });
      target.appendChild(el('h3', { 'class': 'afru-farmTitle' }, [relicLabel(name)]));
      target.appendChild(el('div', { 'class': 'afru-farmCard' }, [
        el('div', { 'class': 'afru-farmCardTitle' }, ['Где добыть']),
        rows.length ? locationsTable(rows) : message('Убрана в Хранилище: сейчас не выпадает. Купите у игроков на warframe.market ' +
          'или дождитесь её возвращения (Prime Resurgence у Варзии).', 'warn'),
      ]));
      if (contents.length) {
        target.appendChild(el('div', { 'class': 'afru-farmCard' }, [
          el('div', { 'class': 'afru-farmCardTitle' }, ['Что внутри (целая)']),
          el('div', { 'class': 'afru-rewards' }, contents.sort(function (a, b) { return Number(b.chance) - Number(a.chance); }).map(function (r) {
            return el('div', { 'class': 'afru-reward', 'data-rarity': r.rarity || '' }, [
              el('span', null, [ru(r.item)]), el('span', { 'class': 'num' }, [percent(r.chance)]),
            ]);
          })),
        ]));
      }
      if (era && era !== 'Vanguard') {
        target.appendChild(el('div', { 'class': 'afru-farmCard' }, [
          el('div', { 'class': 'afru-farmCardTitle' }, ['Где открыть сейчас']),
          state.fissures ? el('div', { 'class': 'afru-fissureGroups' }, fissureGroups([era, 'Omnia'])) : message('Нет связи с api.warframestat.us.', 'warn'),
        ]));
      }
    }, function () {
      if (state.selected !== name) return;
      clear(target);
      target.appendChild(message('Не удалось загрузить таблицы выпадения (api.warframestat.us). Проверьте интернет и попробуйте ещё раз.', 'warn'));
    });
  }

  function renderItem(target, name) {
    var base = name.replace(/ Set$/, '');
    target.appendChild(message('Загрузка таблиц выпадения…', 'muted'));
    drops(base).then(function (all) {
      if (state.selected !== name) return;
      var lower = name.toLowerCase();
      var prefix = base.toLowerCase() + ' ';
      // A set ("Nova Prime Set"), a base name ("Nova Prime") or a part named without "Blueprint" stands for its parts.
      var exactHit = all.some(function (r) { return String(r.item).toLowerCase() === lower; });
      var rows = all.filter(function (r) {
        var item = String(r.item).toLowerCase();
        return item === lower || (!exactHit && item.indexOf(prefix) === 0);
      });
      // Intact relics only: "Lith N1 Relic (Radiant)" rows repeat the same relic with refined chances.
      var fromRelics = rows.filter(function (r) { return /Relic$/.test(r.place); });
      var direct = rows.filter(function (r) { return !RELIC_PLACE.test(r.place); });
      var relics = [];
      fromRelics.forEach(function (r) { if (relics.indexOf(r.place) < 0) relics.push(r.place); });
      return Promise.all(relics.slice(0, config.maxRelicChecks).map(function (relic) {
        return drops(relic).then(function (list) {
          return list.some(function (x) { return String(x.item).toLowerCase() === relic.toLowerCase() && !/Relic$/.test(x.place); });
        }, function () { return null; });
      })).then(function (available) {
        if (state.selected !== name) return;
        clear(target);
        target.appendChild(el('h3', { 'class': 'afru-farmTitle' }, [ru(name)]));
        if (fromRelics.length) {
          var dropping = {};
          relics.forEach(function (relic, i) { dropping[relic] = available[i]; });
          var sorted = fromRelics.slice().sort(function (a, b) {
            return (dropping[b.place] === true) - (dropping[a.place] === true) || Number(b.chance) - Number(a.chance);
          });
          target.appendChild(el('div', { 'class': 'afru-farmCard' }, [
            el('div', { 'class': 'afru-farmCardTitle' }, ['Из реликвий']),
            el('div', { 'class': 'afru-table', role: 'table' }, [
              el('div', { 'class': 'afru-tr head', role: 'row' }, ['Реликвия', 'Часть', 'Редкость', 'Сейчас'].map(function (h) {
                return el('span', { role: 'columnheader' }, [h]);
              })),
            ].concat(sorted.map(function (r) {
              var link = el('button', { type: 'button', 'class': 'afru-link' }, [relicLabel(r.place)]);
              link.addEventListener('click', function () { select(r.place); });
              var status = dropping[r.place];
              return el('div', { 'class': 'afru-tr', role: 'row' }, [
                el('span', { role: 'cell' }, [link]),
                el('span', { role: 'cell' }, [ru(r.item)]),
                el('span', { role: 'cell' }, [(RARITY_RU[r.rarity] || r.rarity || '–') + ' · ' + percent(r.chance)]),
                el('span', { role: 'cell' }, [status === true ? badge('выпадает', 'fast') : status === false ? badge('в Хранилище', 'vaulted') : '–']),
              ]);
            }))),
          ]));
        }
        if (direct.length) {
          target.appendChild(el('div', { 'class': 'afru-farmCard' }, [
            el('div', { 'class': 'afru-farmCardTitle' }, ['Выпадает в миссиях']),
            locationsTable(direct),
          ]));
        }
        if (!fromRelics.length && !direct.length) {
          target.appendChild(message('В таблицах выпадения DE этого предмета нет: его покупают, крафтят или получают за задания.', 'muted'));
        }
      });
    }).catch(function () {
      if (state.selected !== name) return;
      clear(target);
      target.appendChild(message('Не удалось загрузить таблицы выпадения (api.warframestat.us). Проверьте интернет и попробуйте ещё раз.', 'warn'));
    });
  }

  var ui = null;

  function renderOverview() {
    if (!ui) return;
    clear(ui.overview);
    ui.overview.appendChild(el('div', { 'class': 'afru-farmHeader' }, [
      el('h3', { 'class': 'afru-farmTitle' }, ['Разрывы Бездны сейчас']),
      filterChips(renderOverview),
    ]));
    if (!state.fissures) { ui.overview.appendChild(message('Загрузка…', 'muted')); return; }
    var owned = ownedSummary(state.owned);
    if (owned) ui.overview.appendChild(owned);
    ui.overview.appendChild(el('div', { 'class': 'afru-fissureGroups' }, fissureGroups(ERAS)));
  }

  function renderDetails() {
    if (!ui) return;
    clear(ui.details);
    if (!state.selected) return;
    if (RELIC_NAME.test(state.selected)) renderRelic(ui.details, state.selected);
    else renderItem(ui.details, state.selected);
  }

  function select(name) {
    state.selected = name;
    if (ui) { ui.suggestions.hidden = true; clear(ui.suggestions); }
    renderDetails();
  }

  // Relics and Prime items first: the rest rarely drops from tables.
  function suggestions(query) {
    var search = root.__AF_RU_SEARCH__;
    if (!search) return [];
    return search.find(query, 200).filter(function (m) { return !/\(Veiled\)$|Riven Mod/.test(m.en); }).sort(function (a, b) {
      var ra = RELIC_NAME.test(a.en) || / Prime\b/.test(a.en) ? 0 : 1;
      var rb = RELIC_NAME.test(b.en) || / Prime\b/.test(b.en) ? 0 : 1;
      return ra - rb;
    }).slice(0, 10);
  }

  function renderSuggestions() {
    clear(ui.suggestions);
    var list = state.query ? suggestions(state.query) : [];
    ui.suggestions.hidden = !list.length;
    list.forEach(function (m) {
      var option = el('button', { type: 'button', 'class': 'afru-suggestion', role: 'option' }, [
        el('span', null, [m.ru]), el('span', { 'class': 'afru-hint' }, [m.en]),
      ]);
      option.addEventListener('mousedown', function (e) { e.preventDefault(); });
      option.addEventListener('click', function () { ui.input.value = m.ru; state.query = m.ru; select(m.en); });
      ui.suggestions.appendChild(option);
    });
  }

  function refresh(force) {
    loadFissures(force).then(renderOverview, function () {
      if (!ui) return;
      clear(ui.overview);
      ui.overview.appendChild(message('Не удалось загрузить разрывы (api.warframestat.us). Проверьте интернет.', 'warn'));
    });
    loadOwnedRelics().then(function () { if (state.fissures) renderOverview(); });
  }

  function isVisible() { return !!(ui && ui.tab.offsetParent !== null && ui.tab.style.display !== 'none'); }

  function buildTab() {
    var input = el('input', {
      id: 'afruFarmSearch', type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Реликвия или предмет: «лит а1», «нова прайм каркас», «akstiletto»',
      'aria-label': 'Реликвия или предмет', 'aria-controls': 'afruFarmSuggestions',
    });
    var list = el('div', { id: 'afruFarmSuggestions', 'class': 'afru-suggestions', role: 'listbox' });
    list.hidden = true;
    var details = el('div', { 'class': 'afru-farmDetails', 'aria-live': 'polite' });
    var overview = el('div', { 'class': 'afru-farmOverview' });
    var tab = el('div', { id: TAB_ID, 'class': 'tab afru-farm', translate: 'no' }, [
      el('div', { 'class': 'afru-farmSearch' }, [input, list]),
      details,
      overview,
    ]);
    tab.style.display = 'none';
    var timer = null;
    input.addEventListener('input', function () {
      root.clearTimeout(timer);
      timer = root.setTimeout(function () { state.query = input.value.trim(); renderSuggestions(); }, 120);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      var first = suggestions(input.value.trim())[0];
      if (first) { input.value = first.ru; select(first.en); }
    });
    input.addEventListener('blur', function () { root.setTimeout(function () { list.hidden = true; }, 150); });
    input.addEventListener('focus', function () { if (list.firstChild) list.hidden = false; });
    ui = { tab: tab, input: input, suggestions: list, details: details, overview: overview };
    return tab;
  }

  function setupFarmTab() {
    var menu = doc.querySelector('.topMenuGroup > .menuItem[tabid="tabRelicPlanner"]');
    var anchor = doc.getElementById('tabRelicPlanner');
    if (!menu || !anchor || typeof root.menuPressed !== 'function') return false;
    if (doc.getElementById(TAB_ID)) return true;
    var item = el('div', { 'class': 'menuItem', tabid: TAB_ID, translate: 'no' }, [
      el('div', { 'class': 'menuItemIcon relicPlanner afru-farmIcon' }),
      'Где фармить',
    ]);
    item.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    item.addEventListener('click', function (e) {
      root.menuPressed(e);
      refresh(false);
    });
    menu.parentNode.insertBefore(item, menu.nextSibling);
    anchor.parentNode.insertBefore(buildTab(), anchor.nextSibling);
    root.setInterval(function () { if (isVisible()) refresh(false); }, 30 * 1000);
    return true;
  }

  root.__AF_RU_FARM__ = {
    config: config,
    state: state,
    parsePlace: parsePlace,
    relicLabel: relicLabel,
    select: select,
    refresh: refresh,
    suggestions: suggestions,
  };
  extras.whenReady([setupFarmTab]);
})(typeof window !== 'undefined' ? window : null);
