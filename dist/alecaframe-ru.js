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
})(typeof window !== 'undefined' ? window : null, {"version":"0.3.0","exact":{"All":"Все","Any":"Любой","Yes":"Да","No":"Нет","None":"Нет","OK":"Норм.","OK!":"ОК!","Close":"Закрыть","Back":"Назад","Go back":"Назад","Go!":"Вперёд!","Search":"Поиск","Settings":"Настройки","Status":"Статус","Status:":"Статус:","Type":"Тип","Type:":"Тип:","Name":"Название","Item":"Предмет","Amount":"Количество","Total":"Всего","Total:":"Всего:","Level":"Уровень","Level:":"Уровень:","Details":"Подробнее","Default":"По умолчанию","Custom":"Своё","Other":"Другое","Misc":"Разное","Auto":"Авто","Normal":"Обычный","Basic":"Базовый","Small":"Маленький","Medium":"Средний","Large":"Большой","Easy":"Легко","Never":"Никогда","Date":"Дата","User":"Пользователь","Username":"Имя пользователя","Link":"Привязать","here":"здесь","or":"или","Tip:":"Совет:","Price:":"Цена:","Rank:":"Ранг:","Rarity:":"Редкость:","Version:":"Версия:","Mode:":"Режим:","Speed:":"Скорость:","Min:":"Мин.:","Max:":"Макс.:","Avg:":"Сред.:","Average":"Среднее","Value":"Значение","Range":"Диапазон","Optional":"Необязательно","(Optional)":"(необязательно)","Required":"Обязательно","Mandatory":"Обязательно","Missing":"Не хватает","Owned":"В наличии","Coming soon":"Скоро","Beta":"Бета","Premium":"Премиум","Subscribe":"Подписаться","Discord":"Discord","Overwolf":"Overwolf","FAQ":"FAQ","Try again":"Повторить","Copy to clipboard":"Копировать в буфер","Click again to confirm":"Нажмите ещё раз для подтверждения","Don't show again":"Больше не показывать","Connecting...":"Подключение...","Log in":"Войти","Log out":"Выйти","Sign up":"Регистрация","Platinum":"Платина","Platinum:":"Платина:","Ducats":"Дукаты","Ducats:":"Дукаты:","Credits":"Кредиты","Credits:":"Кредиты:","Endo":"Эндо","Endo:":"Эндо:","Aya":"Айя","Aya:":"Айя:","Warframe":"Варфрейм","Primary":"Основное","Secondary":"Вторичное","Melee":"Ближний бой","Companion":"Компаньон","Arch":"Арк-снаряжение","Modular":"Модульное","Kitgun":"Китган","Zaw":"Зо","Pistol":"Пистолет","Rifle":"Винтовка","Shotgun":"Дробовик","Weapon":"Оружие","Weapon:":"Оружие:","Prime":"Прайм","Incarnon":"Инкарнон","Mods":"Моды","Arcanes":"Мистификаторы","Relics":"Реликвии","Relics:":"Реликвии:","Sets":"Наборы","Parts":"Части","Components":"Компоненты","Lith":"Лит","Meso":"Мезо","Neo":"Нео","Axi":"Акси","Intact":"Целая","Exceptional":"Исключительная","Flawless":"Безупречная","Radiant":"Сияющая","Int.":"Цел.","Exc.":"Искл.","Fla.":"Безуп.","Rad.":"Сиян.","Grineer":"Гринир","Corpus":"Корпус","Infested":"Заражённые","Orokin":"Орокин","Corrupted":"Порабощённые","Sentient":"Сентиенты","Narmer":"Нармер","Murmur":"Шёпот","Amalgam":"Амальгамы","Duviri":"Дувири","Duviri:":"Дувири:","Ceres":"Церера","Earth":"Земля","EARTH":"ЗЕМЛЯ","Eris":"Эрида","Europa":"Европа","Jupiter":"Юпитер","Lua":"Луна","Mars":"Марс","Neptune":"Нептун","Phobos":"Фобос","Pluto":"Плутон","Saturn":"Сатурн","Sedna":"Седна","Uranus":"Уран","Venus":"Венера","Void":"Бездна","Zariman":"Заримань","Kuva Fort.":"Крепость Кувы","Omnia":"Омния","CETUS":"ЦЕТУС","VALLIS":"ДОЛИНА СФЕР","CAMBION":"КАМБИОН","Alchemy":"Алхимия","Assault":"Штурм","Capture":"Захват","Defense":"Оборона","Disruption":"Разрушение","Excavation":"Раскопки","Extermin.":"Зачистка","Hive":"Улей","Intercep.":"Перехват","Mobile Def.":"Моб. оборона","Rescue":"Спасение","Sabotage":"Диверсия","Spy":"Шпионаж","Survival":"Выживание","Void Casc.":"Каскад Бездны","Void Flood":"Затопление Бездны","Steel Path":"Стальной Путь","Steel path":"Стальной Путь","The Circuit":"Цепь","Sortie":"Вылазка","Daily sorties":"Ежедневные вылазки","Arbitration":"Арбитраж","Archon":"Охота на Архонта","Bounties":"Задания","Sanctuary":"Святилище","Lich":"Лич","Prime Resurgence":"Возрождение Праймов","Prime resurgence":"Возрождение Праймов","Void fissures":"Разрывы Бездны","Mastery":"Мастерство","MR:":"РМ:","Buy":"Купить","Sell":"Продать","BUY":"КУПИТЬ","SELL":"ПРОДАТЬ","WTB":"Куплю","WTS":"Продам","WTB:":"Куплю:","WTS:":"Продам:","Trade":"Сделка","TRADE":"ОБМЕН","Online":"В сети","Offline":"Не в сети","In-Game":"В игре","Mod":"Мод","Relic":"Реликвия","Next":"Далее","Finish":"Готово","Unvaulted":"Вне Хранилища","AlecaFrame":"AlecaFrame","*Subscribing through Overwolf gives you the perks of the first Patreon tier (Themes, no ads and beta access)":"*Подписка через Overwolf даёт преимущества первого уровня Patreon (темы, отсутствие рекламы и доступ к бета-версиям)","1. Join the AlecaFrame Patreon":"1. Станьте патроном AlecaFrame на Patreon","2. Link your Patreon account":"2. Привяжите аккаунт Patreon","5 new items found":"Найдено 5 новых предметов","A special thanks to the Patreon 'AlecaFrame Enjoyer' supporters for making AlecaFrame possible: Sainan, Skunk616, uSouLz, 哦 哇, StaggyBaby, Shawn Dozier, Vanitas0292, Andrew Barnett, Namielle, Magic Man and Gibonalke.":"Отдельное спасибо патронам уровня «AlecaFrame Enjoyer», благодаря которым существует AlecaFrame: Sainan, Skunk616, uSouLz, 哦 哇, StaggyBaby, Shawn Dozier, Vanitas0292, Andrew Barnett, Namielle, Magic Man и Gibonalke.","Abilities":"Способности","Add new row":"Добавить строку","Adorned":"Украшенный","AlecaFrame can also automatically mark WFMarket listings as sold whenever you trade an item.":"AlecaFrame также может автоматически отмечать лоты на WFMarket как проданные после каждой сделки.","AlecaFrame has a lot of features, lets explore them together!":"В AlecaFrame много возможностей — давайте разберёмся вместе!","AlecaFrame is a third party app and is not affiliated with Digital Extremes.":"AlecaFrame — стороннее приложение, не связанное с Digital Extremes.","AlecaFrame recently had issues detecting the rewards from a relic. These are some things you can try to fix it:":"Недавно AlecaFrame не смог распознать награды из реликвии. Вот что можно попробовать:","Amber stars:":"Янтарные звёзды:","And we are done here, just make sure that the connection to the game is working to get the most out of the app!":"На этом всё! Чтобы получить максимум от приложения, убедитесь, что соединение с игрой работает.","Attack type:":"Тип атаки:","Awesome!":"Отлично!","Baro Ki'Teer will arrive soon":"Баро Ки'Тиир скоро прибудет","Base armor:":"Базовая броня:","Base energy:":"Базовая энергия:","Base health:":"Базовое здоровье:","Base shield:":"Базовые щиты:","Blocking angle:":"Угол блока:","Blueprints needed:":"Нужны чертежи:","Buy from WFMarket":"Купить на WFMarket","Can be crafted":"Можно создать","Changelog:":"Список изменений:","Check the FAQ in our":"Загляните в FAQ на нашем","Close anyway":"Всё равно закрыть","Cold:":"Холод:","Combo duration:":"Длительность комбо:","Connection checklist:":"Проверка соединения:","Copy your Warframe UI scaling settings to AlecaFrame:":"Перенесите в AlecaFrame настройки масштаба интерфейса Warframe:","Crafting tree":"Дерево создания","Crit %:":"Шанс крит.:","Crit mult:":"Множ. крит.:","Cyan stars:":"Голубые звёзды:","Daily resets (Standing caps, SP alerts,...):":"Ежедневные сбросы (репутация, тревоги СП...):","Daily sortie:":"Ежедневная вылазка:","Day:":"День:","Do you want AlecaFrame to remember the 'Auto' mode setting when restarted?":"Запоминать режим «Авто» после перезапуска AlecaFrame?","Drop locations:":"Где выпадает:","Expected value:":"Ожидаемая ценность:","Failed to download the latest game data.":"Не удалось загрузить актуальные игровые данные.","Fass:":"Фасс:","Fire rate:":"Скорострельность:","Foundry":"Литейная","GET":"ПОЛУЧИТЬ","Heavy cast time:":"Время тяжёлой атаки:","Help/About":"Справка","Hide completed:":"Скрыть завершённые:","If after following this checklist you are still having issues, feel free to ask for help on":"Если после этой проверки проблема осталась, попросите помощи на","If it still doesn't work, try entering/leaving a relay 4-5 times":"Если всё ещё не работает, зайдите на реле и выйдите 4–5 раз","If you click on a relic, you can also see detailed information such as drop locations and customized reward probabilities.":"Нажав на реликвию, вы увидите подробности: где она выпадает и шансы наград под ваши условия.","If you click on any Warframe or Weapon in the foundry, you can see more details and where each component can be obtained.":"Нажмите на любой варфрейм или оружие в литейной, чтобы увидеть подробности и где добыть каждый компонент.","If you close AlecaFrame, the relic overlay won't show up.":"Если закрыть AlecaFrame, оверлей реликвий не появится.","If you connect your WFMarket account, you can create listings with 1 click!":"Привяжите аккаунт WFMarket, чтобы создавать лоты в один клик!","In the next tab, you can check your rivens, see how perfect they are and create listings with 1 click!":"На следующей вкладке — ваши моды Разлома: насколько они хороши, и выставление на продажу в один клик!","Inventory":"Инвентарь","Item details":"О предмете","Last upgrade:":"Последнее улучшение:","Link account":"Привязать аккаунт","Loading game data...":"Загрузка игровых данных...","Loading void fissures...":"Загрузка разрывов Бездны...","Made with ❤️ in 🇪🇸 🇪🇺. © 2021-2026 Alejandro Cabrerizo. All rights reserved":"Сделано с ❤️ в 🇪🇸 🇪🇺. © 2021-2026 Alejandro Cabrerizo. Все права защищены","Mag. size/Ammo:":"Магазин / боезапас:","Magnificent":"Великолепный","Mastery helper":"Помощник мастерства","Max. time:":"Макс. время:","Maximum crafting time if you don't paralelize blueprint construction.":"Максимальное время создания, если строить чертежи по очереди.","Message copied!":"Сообщение скопировано!","Min. time:":"Мин. время:","Minimum time it would take by paralelize blueprint construction.":"Минимальное время, если строить чертежи параллельно.","Mod type:":"Тип мода:","More details are currently not supported for this item":"Подробности для этого предмета пока не поддерживаются","Next rotation in:":"Следующая ротация через:","Night:":"Ночь:","No ads, more features and support the development!":"Без рекламы, больше функций и поддержка разработки!","No blueprints missing":"Все чертежи есть","No components were found for this item":"Для этого предмета не найдено компонентов","No crafting tree found for this item":"Для этого предмета нет дерева создания","No drops were found for this item":"Для этого предмета не найдено источников","No resources missing":"Все ресурсы есть","Once you open a relic in-game or need to choose a relic, you will see an overlay with useful information to help you make the best choice.":"Когда вы открываете реликвию в игре или выбираете её, появится оверлей с подсказками, которые помогут сделать лучший выбор.","Passive:":"Пассивная:","Please check your internet connection or ask for help on":"Проверьте подключение к интернету или попросите помощи на","Polarities:":"Полярности:","POST BUY":"ВЫСТАВИТЬ: КУПЛЮ","POST SELL":"ВЫСТАВИТЬ: ПРОДАМ","Range:":"Дальность:","Relic overview":"Обзор реликвии","Relic planner":"Реликвии","Relic refinement tier:":"Уровень улучшения реликвии:","Reload time:":"Перезарядка:","Req.":"Треб.","Reset timers":"Таймеры сброса","Resources needed:":"Нужны ресурсы:","Revealed":"Раскрыт","Riven disposition:":"Предрасположенность к модам Разлома:","Rivens":"Моды Разлома","Run speed:":"Скорость бега:","Scaling issues detected in the relic overlay":"В оверлее реликвий обнаружены проблемы с масштабом","Select a component to see more information here":"Выберите компонент, чтобы увидеть подробности","Select an item in your inventory to see its WFMarket listings here":"Выберите предмет в инвентаре, чтобы увидеть его лоты на WFMarket","server or ask for help there":"сервере или попросите помощи там","Shot type:":"Тип выстрела:","Squad size:":"Размер отряда:","Stats":"Статистика","Status %:":"Шанс статуса:","Subscribe through Overwolf":"Подписаться через Overwolf","Support the development":"Поддержать разработку","Support the development of AlecaFrame":"Поддержите разработку AlecaFrame","The final tab shows your current WFMarket listings, allows you to quickly edit or remove then and even to automatically remove/fix the ones where you don't own the items anymore.":"Последняя вкладка показывает ваши лоты на WFMarket: их можно быстро изменить, удалить, а также автоматически убрать или исправить те, где предметов у вас уже нет.","The first tab is the Foundry, where you can check your overall progress in the game and what you need to complete everything else.":"Первая вкладка — Литейная: здесь виден общий прогресс и что нужно, чтобы завершить остальное.","The next tab is the Inventory, where you can see all the tradeable items in your inventory and their average price.":"Следующая вкладка — Инвентарь: все ваши предметы для обмена и их средняя цена.","The Warframe overlay needs to be enabled in Overwolf settings":"В настройках Overwolf должен быть включён оверлей для Warframe","This item can't be traded":"Этот предмет нельзя обменять","This relic seems to be vaulted":"Похоже, эта реликвия в Хранилище","This tab is called the \"Relic planner\", where you can easily check which relic is the most profitable or recommended for you.":"Эта вкладка — «Реликвии»: здесь легко понять, какая реликвия самая выгодная или рекомендуемая для вас.","Timers & Events":"Таймеры и события","Total from 0:":"Всего с нуля:","Trading Analytics":"Аналитика торговли","Try using borderless mode instead of fullscreen":"Используйте оконный режим без рамки вместо полноэкранного","Units:":"Единицы:","Unrevealed":"Не раскрыт","Used for crafting:":"Используется для создания:","Using old data":"Используются старые данные","Vome:":"Воум:","Warframe connection troubleshooter":"Диагностика соединения с Warframe","Warframe is open and you are logged in":"Warframe запущен, и вы вошли в аккаунт","Warframe Market":"Warframe Market","Warframe needs to be opened after Overwolf":"Warframe нужно запускать после Overwolf","Warframe should NOT run as admin":"Warframe НЕ должен запускаться от администратора","Warm:":"Тепло:","Weekly resets (Archons, Circuit, Traders,...):":"Еженедельные сбросы (Архонты, Цепь, торговцы...):","Welcome to AlecaFrame":"Добро пожаловать в AlecaFrame","Welcome to AlecaFrame!":"Добро пожаловать в AlecaFrame!","WF data not ready":"Данные игры не готовы","WF data OK!":"Данные игры в порядке!","WFMarket":"WFMarket","WFMarket search:":"Поиск на WFMarket:","Wiki link":"Ссылка на вики","Wiki Link":"Ссылка на вики","Wiki/Docs":"Вики / документация","Wow! It seems like everything is working now.":"Ура! Похоже, теперь всё работает.","You CAN DISABLE IT in the settings menu if you prefer to do it manually.":"Это МОЖНО ОТКЛЮЧИТЬ в настройках, если предпочитаете делать это вручную.","Your overwolf install is OK":"Установка Overwolf в порядке","Arcane levels":"Уровни мистификаторов","Mod levels":"Уровни модов","Extra capacity:":"Доп. вместимость:","% of prime unlocks":"% открытых праймов","Check for updates":"Проверить обновления","Item in the foundry":"Предмет в литейной","Mastered":"Освоено","Subsumed into the Helminth System":"Поглощён Гельминтом","Troubleshoot":"Диагностика","Warframe connection not ready":"Соединение с Warframe не готово","WF connection not ready, using old data.":"Соединение с игрой не готово, используются старые данные.","Come back whenever you have something to sell or check that the connection to the game is working properly":"Возвращайтесь, когда будет что продать, или проверьте соединение с игрой","Contains archon shards":"Содержит осколки Архонта","Enough mastery":"Хватает мастерства","Favorite":"Избранное","Helminth done":"Скормлено Гельминту","Incarnon genesis":"Генезис Инкарнона","Ready to build":"Можно строить","Subsumed":"Поглощён","Unmastered":"Не освоено","Used for crafting":"Используется для создания","Vaulted":"В Хранилище","Your inventory seems empty.":"Похоже, ваш инвентарь пуст.","DEMO mode enabled":"Включён ДЕМО-режим","DEMO mode is enabled. Please disable it in the settings tab to access the market":"Включён ДЕМО-режим. Отключите его в настройках, чтобы пользоваться рынком","Item owned/mastered":"Предмет есть / освоен","Marked as favorite":"В избранном","Missing information":"Нет данных","Mod leveled up":"Мод прокачан","Total of current selection":"Итого по выбранному","Vault status":"Статус Хранилища","WFMarket order placed":"Заказ на WFMarket размещён","% of parts owned":"% собранных частей",">1 owned":"Больше одного","All parts":"Все части","Change order":"Изменить сортировку","Complete (Sets)":"Полные (наборы)","Ducanator":"Дуканатор","Ducats/Platinum":"Дукаты / платина","Equipped (Mods only)":"Установлены (только моды)","Item crafted":"Предмет создан","Leveled up (Mods & Arcanes)":"Прокачаны (моды и мистификаторы)","Lvl:":"Ур.:","Minimum platinum":"Минимум платины","Only owned":"Только имеющиеся","Order placed":"Заказ размещён","Part type":"Тип части","Set complete":"Набор собран","WARNING: This might make the app slugish on slow computers":"ВНИМАНИЕ: на слабых компьютерах приложение может работать медленнее","Continue later":"Продолжить позже","Harrow chassis:":"Каркас Харроу:","New items":"Новые предметы","Best ways to level up mastery:":"Лучшие способы поднять мастерство:","Companions:":"Компаньоны:","From relics":"Из реликвий","Game content":"Игровой контент","Intrinsics":"Навыки Рейлджека","Junctions:":"Узлы:","No ideas were found 😔. Try using other filters.":"Идей не нашлось 😔. Попробуйте другие фильтры.","Normal:":"Обычный:","Railjack:":"Рейлджек:","Star chart":"Звёздная карта","Steel p. junctions:":"Узлы Стального Пути:","Steel path:":"Стальной Путь:","Warframes / Archwings:":"Варфреймы / арчвинги:","Weapons:":"Оружие:","With platinum":"За платину","Expected profits for the selected squad size.":"Ожидаемая прибыль для выбранного размера отряда.","Loading relics...":"Загрузка реликвий...","Push your current filters to the overlay.":"Передать текущие фильтры в оверлей.","The current filters will now be used in the overlay":"Текущие фильтры теперь используются в оверлее",">= 10 copies":"10 копий и больше","50 results shown. Use different filters or click":"Показано 50 результатов. Измените фильтры или нажмите","All items mastered/owned":"Все предметы освоены / есть","All rewards owned":"Все награды есть","Analyzing your relics might take some time depending on the size of your inventory.":"Анализ реликвий может занять время — зависит от размера инвентаря.","Best to upgrade - Ducats":"Выгоднее улучшать — дукаты","Best to upgrade - Platinum":"Выгоднее улучшать — платина","Come back whenever the connection to the game is working properly":"Возвращайтесь, когда соединение с игрой заработает","Ducats profit":"Прибыль в дукатах","Ducats vs void traces efficiency (To radiant)":"Дукаты к Отголоскам Бездны (до сияющей)","Missing items (Best for MR)":"Недостающие предметы (лучше для РМ)","No relics could be found in your inventory":"В инвентаре не найдено реликвий","Order first":"Сначала","Platinum profit":"Прибыль в платине","Platinum vs void traces efficiency (To radiant)":"Платина к Отголоскам Бездны (до сияющей)","Relic tier":"Эпоха реликвии","Reload everything":"Перезагрузить всё","Squad:":"Отряд:","Start now":"Начать","to show everything.":", чтобы показать всё.","Updated data is available":"Доступны новые данные","Email:":"Эл. почта:","Fix all missing items":"Исправить все отсутствующие","If you login to WFMarket with steam, please add an email/password to your WFMarket account (":"Если вы входите на WFMarket через Steam, добавьте в аккаунт WFMarket почту и пароль (","Login into":"Вход в","Lowest price:":"Мин. цена:","Missing items":"Отсутствующие предметы","My contracts":"Мои контракты","My orders":"Мои заказы","No WFMarket contracts were found with those filters":"По этим фильтрам контракты на WFMarket не найдены","No WFMarket orders were found with those filters":"По этим фильтрам заказы на WFMarket не найдены","Order type":"Тип заказа","Password:":"Пароль:","Please try again later or check Discord for updates":"Попробуйте позже или следите за новостями в Discord","Remove all contracts":"Удалить все контракты","Remove all orders":"Удалить все заказы","Set all contracts invisible":"Скрыть все контракты","Set all contracts visible":"Показать все контракты","Set all orders invisible":"Скрыть все заказы","Set all orders visible":"Показать все заказы","Warframe.Market is down/very slow":"Warframe.Market недоступен или очень медленный","You login data is only used once and won't be stored":"Данные для входа используются один раз и не сохраняются","Missing items detected. Click here to remove them":"Найдены отсутствующие предметы. Нажмите, чтобы удалить их","Auction":"Аукцион","Best attributes:":"Лучшие свойства:","Best bad attrs:":"Лучшие минусы:","Buyout price:":"Цена выкупа:","Description (Optional):":"Описание (необязательно):","Direct sale":"Прямая продажа","Drain:":"Стоимость:","Import to Riven.market":"Импорт на Riven.market","In Riven.Market":"На Riven.Market","In WFMarket":"На WFMarket","List on Riven.Market:":"Выставить на Riven.Market:","List on WFMarket:":"Выставить на WFMarket:","Min. MR:":"Мин. РМ:","Min. reputation:":"Мин. репутация:","Modifiers:":"Модификаторы:","No similar rivens found":"Похожих модов Разлома не найдено","Private":"Скрытый","Public":"Публичный","Rerolls:":"Перебросы:","Riven details":"Мод Разлома: подробности","Selling price:":"Цена продажи:","Similar rivens:":"Похожие моды Разлома:","Starting price:":"Стартовая цена:","Use lvl. 8 stats":"Показатели 8-го уровня","Visibility:":"Видимость:","Add sniper config":"Добавить конфигурацию снайпера","Add to Sniper:":"Добавить в снайпер:","Attribute":"Свойство","Attribute price and popularity:":"Цена и популярность свойства:","Average riven price":"Средняя цена мода Разлома","Change your filters or make sure that the connection to the game is working properly.":"Измените фильтры или проверьте соединение с игрой.","Discord webhook URL:":"URL вебхука Discord:","Disposition":"Предрасположенность","Enter a name for the config":"Введите название конфигурации","Enter a WFMarket riven ID or URL here":"Вставьте ID или ссылку мода Разлома с WFMarket","Finder":"Поиск","How perfect the random component for each stat is":"Насколько удачна случайная часть каждого показателя","Lowest WFMarket price:":"Мин. цена на WFMarket:","Min similar %:":"Мин. сходство, %:","Minimum similarity %:":"Минимальное сходство, %:","No rivens were found with those filters":"По этим фильтрам моды Разлома не найдены","No sniper configurations found":"Конфигураций снайпера нет","Please select a weapon first":"Сначала выберите оружие","Req. negative:":"Нужен минус:","Required MR":"Нужный РМ","Rerolls":"Перебросы","Riven grade":"Оценка мода Разлома","Riven.Market":"Riven.Market","Slots used:":"Занято слотов:","Sniper":"Снайпер","Sniper settings:":"Настройки снайпера:","Stat perfectness":"Идеальность показателей","Subscribe to get more config slots":"Оформите подписку, чтобы получить больше слотов","Subscribe to see exact prices for each attribute":"Оформите подписку, чтобы видеть точные цены каждого свойства","Unveiled stash":"Раскрытые","Veiled stash":"Нераскрытые","WFMarket riven lookup:":"Поиск мода Разлома на WFMarket:","You can create custom configurations in the 'Finder' tab":"Свои конфигурации можно создать на вкладке «Поиск»","Your notification slots:":"Ваши слоты уведомлений:","Generating import string. This might take a few seconds...":"Создаём строку импорта. Это займёт несколько секунд...","Base":"База","Edit contract":"Изменить контракт","List on WFMarket":"Выставить на WFMarket","Select a weapon":"Выберите оружие","\"Custom Menu Scale\" value:":"Значение «Свой масштаб меню»:","Apply themes to overlays":"Применять темы к оверлеям","Autodetect":"Определить автоматически","Automatically move AlecaFrame to a secondary monitor on startup":"При запуске переносить AlecaFrame на второй монитор","Community themes":"Темы сообщества","Copy relic reward data to clipboard when a relic is opened":"Копировать награды реликвии в буфер при её открытии","Don't show \"remember Auto status\" window when changing 'Auto' mode":"Не спрашивать о запоминании режима «Авто» при его смене","Empty to disable":"Оставьте пустым, чтобы отключить","Enable 'Stats' tab":"Включить вкладку «Статистика»","Enable notification sounds":"Звуки уведомлений","Enable relic recommendations overlay":"Оверлей рекомендаций реликвий","Enable relic rewards overlay":"Оверлей наград реликвий","Enable riven overlays":"Оверлеи модов Разлома","Enable trade finished detection/overlay":"Распознавание завершённых сделок и оверлей","Export all my data:":"Экспорт всех моих данных:","Export as theme file":"Экспорт в файл темы","Export to desktop":"Экспорт на рабочий стол","Full (Best)":"Полный (лучший)","General":"Общие","Hide Founders Program items (Excalibur Prime, Skana Prime and Lato Prime)":"Скрыть предметы программы основателей (Excalibur Prime, Skana Prime и Lato Prime)","If you have changed any in-game settings recently, please restart the game before autodetecting":"Если вы недавно меняли настройки в игре, перезапустите её перед автоопределением","Import from clipboard":"Импорт из буфера","Include levels that need formas in the Mastery Helper":"Учитывать в помощнике мастерства уровни, требующие форм","Legacy (ONLY <=1080p)":"Старый (ТОЛЬКО до 1080p)","Message template (accepts Discord pings):":"Шаблон сообщения (можно упоминания Discord):","Minutes ahead of world cycle change to send the notifications:":"За сколько минут до смены цикла мира присылать уведомления:","New Warframe conversation notifications:":"Уведомления о новых диалогах в Warframe:","Notifications":"Уведомления","Only send message notifications when Warframe is in the background":"Уведомлять о сообщениях, только когда Warframe в фоне","Open themes folder":"Открыть папку тем","Overlays":"Оверлеи","Release channel:":"Канал обновлений:","Remember WFM 'Auto' status when AlecaFrame is restarted":"Запоминать статус WFM «Авто» после перезапуска AlecaFrame","Send notifications through Discord":"Отправлять уведомления в Discord","Send notifications through Windows":"Отправлять уведомления Windows","Sharing":"Публикация","Show account ducats and platinum on relic overlay":"Показывать дукаты и платину аккаунта в оверлее реликвий","Show all items by default in the Foundry, Inventory and Relic tabs":"По умолчанию показывать все предметы в литейной, инвентаре и реликвиях","Show warning when trying to close the main app window":"Предупреждать при закрытии главного окна","Take mod rank into account for the WFM 'missing items' check":"Учитывать ранг мода при проверке «отсутствующих предметов» WFM","Theme author:":"Автор темы:","Theme customization":"Настройка темы","Theme name:":"Название темы:","Themes":"Темы","Themes are only available to supporters":"Темы доступны только поддержавшим проект","Timer and Relic notifications:":"Уведомления о таймерах и реликвиях:","Use <PLAYER_NAME> as the placeholder for the Warframe username":"<PLAYER_NAME> подставляет имя игрока Warframe","Use <WFM_MESSAGE> as the placeholder for the WFMarket message content":"<WFM_MESSAGE> подставляет текст сообщения WFMarket","Warframe \"Menu Scale\" settings:":"Настройка «Масштаб меню» в Warframe:","Warframe.Market message notifications:":"Уведомления о сообщениях Warframe.Market:","30 days":"30 дней","7 days":"7 дней","90 days":"90 дней","Account data:":"Данные аккаунта:","An error has occurred or you have no recorded stats.":"Произошла ошибка, или у вас ещё нет статистики.","Chart disabled in this link":"График отключён в этой ссылке","Copy my API token":"Скопировать мой API-токен","Create public link":"Создать публичную ссылку","Data export & API":"Экспорт данных и API","Download AlecaFrame":"Скачать AlecaFrame","Export data as CSV":"Экспорт в CSV","Export data as JSON":"Экспорт в JSON","For more information about the stats API, please check the FAQ channel on Discord":"Подробнее об API статистики — в канале FAQ на Discord","Generate link":"Создать ссылку","Generate token":"Создать токен","Get your own stats":"Получить свою статистику","Only 50 trades are shown. Try using different filters or click":"Показано только 50 сделок. Измените фильтры или нажмите","Please come back later or click":"Загляните позже или нажмите","Purchase":"Покупка","Sale":"Продажа","The stats tab is disabled.":"Вкладка статистики отключена.","Timeframe:":"Период:","to try again.":", чтобы повторить.","Trade history":"История сделок","Trade history is disabled in this link":"История сделок отключена в этой ссылке","Trade history is only available if the game language is set to English":"История сделок доступна, только если язык игры — английский","Trades:":"Сделки:","You can enable it in the settings menu and then click":"Включите её в настройках, а затем нажмите","Your personal stats:":"Ваша статистика:","Change":"Изменение","Daily trades":"Сделок в день","Days played":"Дней в игре","Generating link, please wait...":"Создаём ссылку, подождите...","Personal token copied to clipboard. Please be careful with it!":"Личный токен скопирован в буфер. Никому его не показывайте!","Relics opened":"Открыто реликвий","Expenses":"Расходы","More info":"Подробнее","Premium features are only available to Patreon T2+ supporters":"Премиум-функции доступны только патронам уровня T2 и выше","Profit":"Прибыль","Profit:":"Прибыль:","Purchases":"Покупки","Revenue":"Выручка","Sales":"Продажи","Top trading partners":"Частые партнёры по сделкам","Top Warframe.Market items (last 7 days)":"Топ предметов Warframe.Market (7 дней)","Total expenses:":"Всего расходов:","Total revenue:":"Всего выручки:","Total value":"Общая стоимость","Unit price":"Цена за шт.","Volume (Day)":"Объём (за день)","Your Trade history stats":"Статистика ваших сделок","Background 1":"Фон 1","Background 2":"Фон 2","Background 3":"Фон 3","Buy - Active":"Купить — нажата","Buy - Hover":"Купить — наведение","Card":"Карточка","Card - Active":"Карточка — нажата","Card - Hover":"Карточка — наведение","Icons":"Значки","Icons on BG":"Значки на фоне","Navigation":"Навигация","Navigation - Active":"Навигация — нажата","Navigation - Hover":"Навигация — наведение","Sell - Active":"Продать — нажата","Sell - Hover":"Продать — наведение","Tab":"Вкладка","Tab - Active":"Вкладка — активна","Tab - Hover":"Вкладка — наведение","Text":"Текст","Text on BG":"Текст на фоне","The themes folder will open soon":"Папка тем сейчас откроется","Theme applied!":"Тема применена!","Duration:":"Длительность:","Output items:":"Результат:","If this is marked with an X, it means that your Overwolf install is corrupt. ONLY if marked with a X, please reinstall Overwolf or ask for help on Discord.":"Крестик здесь означает, что установка Overwolf повреждена. ТОЛЬКО в этом случае переустановите Overwolf или попросите помощи в Discord.","Make sure the game is running and you are logged into your game account":"Убедитесь, что игра запущена и вы вошли в аккаунт","Make sure the Warframe overlay is enabled. Open the Overwolf settings menu, then go to Overlay & Hotkeys and finally make sure Warframe is enabled. You WILL NEED TO RESTART THE GAME after you change this.":"Убедитесь, что оверлей для Warframe включён: настройки Overwolf → «Overlay & Hotkeys» → Warframe включён. После изменения ОБЯЗАТЕЛЬНО ПЕРЕЗАПУСТИТЕ ИГРУ.","Make sure you are not starting Steam/Launcher/Game as an admin.":"Убедитесь, что Steam, лаунчер и игра запускаются не от администратора.","Sometimes it is neccessary to complete a few missions before Overwolf detects the game":"Иногда Overwolf распознаёт игру только после нескольких миссий","Warframe needs to be started AFTER Overwolf/AlecaFrame":"Warframe нужно запускать ПОСЛЕ Overwolf и AlecaFrame","UNKNOWN error":"НЕИЗВЕСТНАЯ ошибка","Block user":"Заблокировать","Blocked players":"Заблокированные игроки","button to refresh it":", чтобы обновить его","Casual":"Без напряга","Connecting to the matchmaking servers...":"Подключение к серверам подбора...","Create a squad":"Создать отряд","Create squad":"Создать отряд","Each squad shows what its purpose is, the reputation of its leader and the requirements/goals of the squad":"У каждого отряда указаны цель, репутация лидера, требования и задачи","Failed to connect to the matchmaking servers.":"Не удалось подключиться к серверам подбора.","I confirm that my report is relevant and thruthful":"Подтверждаю, что жалоба обоснована и правдива","I have read and agree to these rules":"Я прочитал(а) правила и согласен(на) с ними","If the opposite happens, you can block that user from joining your squads or send a report if they were breaking the rules":"Если всё наоборот — заблокируйте игрока, чтобы он не попадал в ваши отряды, или пожалуйтесь, если он нарушал правила","If you are joining a squad, first make sure that you meet the requirements and have enough resources (relics,...) to complete the goals":"Прежде чем вступать в отряд, убедитесь, что подходите под требования и у вас хватает ресурсов (реликвий и т. п.) для задач","If you had a good time with other players, you can increase their reputation with the + button.":"Если с игроками было приятно играть, повысьте им репутацию кнопкой +.","If you have a friend that isn't using AlecaFrame, you can add them as a Guest if there is a slot available":"Друга без AlecaFrame можно добавить гостем, если есть свободное место","If you meet someone your don't like, you can always block them from joining your squads. You should only report someone if they are breaking the rules listed here or their behaviour is clearly making everyone's experience worse.":"Если игрок вам не понравился, его всегда можно заблокировать. Жалуйтесь, только если он нарушает перечисленные здесь правила или явно портит игру всем остальным.","If you think this is a mistake or you want to appeal it, please do it on":"Если считаете это ошибкой или хотите обжаловать решение, обратитесь на","Join squad":"Вступить","Max squad size:":"Макс. размер отряда:","No extra requirements":"Без доп. требований","No spam or advertising in squad titles or chat messages":"Никакого спама и рекламы в названиях отрядов и чате","No squads found":"Отряды не найдены","NSFW, racial slurs, propaganda, politics, harassment, racism, discrimination, and other offensive behaviors are not allowed in squad titles and chat messages":"В названиях отрядов и чате запрещены NSFW, расовые оскорбления, пропаганда, политика, травля, расизм, дискриминация и прочее оскорбительное поведение","On the left you can see a list of all squads that are looking for members.":"Слева — список всех отрядов, которые ищут участников.","On the right side you can see your current reputation and account status. If your reputation gets too low or are reported for breaking the rules, your account might get banned from using TennoFinder":"Справа — ваша репутация и статус аккаунта. Если репутация станет слишком низкой или на вас пожалуются за нарушения, доступ к TennoFinder могут закрыть","Once you join a squad, you can use the chat to talk to the other members":"В отряде можно общаться с участниками в чате","Optimized":"На скорость","Part or relic name":"Часть или реликвия","Player username:":"Имя игрока:","Please login or have your Warframe data recognized at least once to see your account information here":"Войдите или дождитесь, пока данные Warframe распознаются хотя бы раз, чтобы видеть здесь сведения об аккаунте","Positive review":"Положительный отзыв","Reason:":"Причина:","Recent players":"Недавние игроки","Recommended. Nothing too serious, just respect the requirements and have fun.":"Рекомендуется. Ничего серьёзного — соблюдайте требования и получайте удовольствие.","Remember that you are responsible for their actions, and you can also be reported for any rules your guests break":"Помните: вы отвечаете за гостей, и на вас тоже могут пожаловаться, если они нарушат правила","Remove positive review":"Убрать положительный отзыв","Report a user":"Пожаловаться на игрока","Report user":"Пожаловаться","Reports must be truthful and should contain enough information to make a decision on the case (screenshots, chat logs,...)":"Жалобы должны быть правдивыми и содержать достаточно сведений для решения (скриншоты, логи чата и т. п.)","Reputation:":"Репутация:","Room title:":"Название отряда:","Rules":"Правила","Select the purpose of this squad:":"Выберите цель отряда:","Send report":"Отправить жалобу","Squads should be, by default, hosted in English. Similar to 1), this doesn't apply if all members are ok with something else":"По умолчанию в отрядах общаются на английском. Как и в п. 1, это не действует, если все участники согласны на другой язык","TennoFinder - Squad search":"TennoFinder — поиск отряда","TennoFinder is probably down for maintenance, but if this error continues for a while, please ask for help on":"Вероятно, TennoFinder на обслуживании. Если ошибка не проходит, попросите помощи на","TennoFinder rules and ToS":"Правила и условия TennoFinder","The squad list hasn't been updated for a long time. Please use the":"Список отрядов давно не обновлялся. Нажмите кнопку","This squad focused on speed and efficiency.":"Отряд нацелен на скорость и эффективность.","Try using different filters or create your own squad":"Измените фильтры или создайте свой отряд","Unblock user":"Разблокировать","Unless agreed otherwise, your main focus while on the squad should be to complete the objectives. It is highly recommended that you set yourself to 'Offline' in WFMarket to avoid slowing down the other players of the squad.":"Если не договорились иначе, главное в отряде — выполнить задачи. Настоятельно рекомендуем поставить статус «Не в сети» на WFMarket, чтобы не задерживать остальных.","Welcome to TennoFinder":"Добро пожаловать в TennoFinder","Welcome to TennoFinder!":"Добро пожаловать в TennoFinder!","When creating your own squad, you can choose the goals and requirements of your squad.":"Создавая свой отряд, вы сами выбираете его цели и требования.","When you join a squad, you are responsible for making sure you can complete the tasks listed in the title/requirements. Multiple offences will result in a ban. If you are close to meeting the requirements, it is allowed to join the squad and ask in the chat if everyone is ok with your situation.":"Вступая в отряд, вы отвечаете за то, что сможете выполнить задачи из названия и требований. За повторные нарушения — бан. Если вы почти подходите под требования, можно вступить и спросить в чате, все ли не против.","Why are you reporting this user? (English only):":"Почему вы жалуетесь на игрока? (только на английском):","You can filter the available squads by searching for any term (title, goals,...) or you can also create your own one":"Отряды можно отфильтровать поиском по любому слову (название, цели и т. п.) или создать свой","Your account is currently banned from using TennoFinder.":"Ваш доступ к TennoFinder сейчас заблокирован.","+ Add guest":"+ Добавить гостя","Failed to connect to the TennoFinder servers.":"Не удалось подключиться к серверам TennoFinder.","Squad chat:":"Чат отряда:","Squad members:":"Участники отряда:","TennoFinder - In squad":"TennoFinder — в отряде","TennoFinder might be down for maintenance or an unexpected error occurred.":"TennoFinder может быть на обслуживании, или произошла непредвиденная ошибка.","The host has disbanded this squad":"Лидер распустил отряд","This slot is empty":"Место свободно","You have been kicked from this squad":"Вас исключили из отряда","Farming":"Фарм","Grand bosses":"Крупные боссы","Items/relics to farm:":"Что фармить (предметы/реликвии):","Lich type:":"Тип Лича:","Relics allowed:":"Разрешённые реликвии:","Requirements (optional):":"Требования (необязательно):","Requirements:":"Требования:","Sanctuary type:":"Тип Святилища:","Squad type:":"Тип отряда:","There are many filters filters available. You can try the name of a Warframe, weapon, a part, 'Any Lith', 'Radiant',...":"Фильтров много: попробуйте варфрейм, оружие, часть, «Any Lith», «Radiant» и т. п.","There are many filters filters available. You can try the name of any resource, including minerals, endo, ...":"Фильтров много: попробуйте любой ресурс, включая минералы, эндо и т. п.","VRC Relics":"Реликвии VRC","Which bounties do you want to farm:":"Какие задания фармить:","You can (optionally) specify any required Warframes for the mission":"Можно указать варфреймы, обязательные для миссии","You can also specify a minimum length (specially useful for The Circuit) and/or any required Warframes":"Также можно указать минимальную длительность (особенно полезно для Цепи) и/или обязательные варфреймы","You can also specify a minimum length and/or any required Warframes":"Также можно указать минимальную длительность и/или обязательные варфреймы","You can select which boss you want to kill and (optionally) if any special Warframe is required":"Выберите босса и, при желании, обязательный варфрейм","Disconnected from the server.":"Соединение с сервером потеряно.","Disconnected from the server. Trying to reconnect...":"Соединение с сервером потеряно. Переподключение...","Invite command copied to clipboard.":"Команда приглашения скопирована в буфер.","Message too long!":"Слишком длинное сообщение!","Failed to block player":"Не удалось заблокировать игрока","Failed to join squad. This squad is probably full or doesn't exist anymore":"Не удалось вступить. Скорее всего, отряд заполнен или уже распущен","Failed to remove player review":"Не удалось убрать отзыв","Failed to report player":"Не удалось отправить жалобу","Failed to review player":"Не удалось оставить отзыв","Failed to unblock player":"Не удалось разблокировать игрока","Not currently available":"Сейчас недоступно","Player blocked. You can unblock them from the 'Blocked players' list":"Игрок заблокирован. Разблокировать можно в списке «Заблокированные игроки»","Player reported successfully":"Жалоба отправлена","Player review removed":"Отзыв убран","Player reviewed":"Отзыв оставлен","Player unblocked successfully.":"Игрок разблокирован.","Squad is full":"Отряд заполнен","You can only create/join 1 squad at the same time!":"Можно создать или вступить только в 1 отряд одновременно!","You can only join 1 squad at the same time":"Можно состоять только в 1 отряде одновременно","You need to accept the terms before reporting a player":"Чтобы пожаловаться, примите условия","You need to write a reason for reporting the player":"Укажите причину жалобы","Banned":"Заблокирован","Add at least one enemy to see the damage comparison":"Добавьте хотя бы одного врага, чтобы сравнить урон","AFBuilds":"AFBuilds","AOE":"По области","Build Simulator":"Симулятор билдов","Damage mitigation:":"Снижение урона:","Damage source:":"Источник урона:","Direct":"Прямой","Edit enemies":"Изменить врагов","Enemy setup":"Набор врагов","Enemy setup editor":"Редактор набора врагов","Enemy setup too easy":"Набор врагов слишком лёгкий","Enemy setup too hard":"Набор врагов слишком сложный","Game NPCs":"Враги из игры","Get sharing link":"Получить ссылку","Load build":"Загрузить билд","Mod browser":"Каталог модов","New build":"Новый билд","Only 100 results are shown. Try using different filters or click":"Показано только 100 результатов. Измените фильтры или нажмите","Preset:":"Шаблон:","Remove ads and support the developement":"Убрать рекламу и поддержать проект","Results":"Результаты","Save build":"Сохранить билд","Save preset":"Сохранить шаблон","Select a mod slot to see the damage comparison":"Выберите ячейку мода, чтобы сравнить урон","Setup:":"Набор:","Status effects:":"Эффекты статуса:","to show all of them.":", чтобы показать все.","TTK (Time To Kill):":"TTK (время убийства):","Zoom:":"Масштаб:","AlecaFrame Notification":"Уведомление AlecaFrame","AlecaFrame relic":"Реликвия AlecaFrame","Crafted":"Создано","Not crafted":"Не создано","Use Ctrl+TAB to interact with the overlay":"Ctrl+TAB — взаимодействие с оверлеем","E. profits:":"Ож. прибыль:","Press Ctrl + Tab to interact with the overlay":"Нажмите Ctrl + Tab для взаимодействия с оверлеем","Recommended relics":"Рекомендуемые реликвии","Bad":"Плохо","Ctr+Tab":"Ctrl+Tab","Good":"Хорошо","Great":"Отлично","Press":"Нажмите","to interact with the overlay":"для взаимодействия с оверлеем","complete":"завершена","Enter message here (optional)":"Введите сообщение (необязательно)","Give reputation to user":"Повысить репутацию игроку","in WFMarket:":"на WFMarket:","marked as sold":"отмечены как проданные","The following items will be":"Следующие предметы будут","Trade with":"Сделка с","Overlay not enabled":"Оверлей не включён","You can also disable this window in the settings menu":"Это окно можно отключить в настройках","positive review":"положительный отзыв","Unsupported Warframe language detected. For the time being, only English, French, Spanish and German are supported.":"Язык Warframe не поддерживается: AlecaFrame распознаёт награды только на английском, французском, испанском и немецком. Чтобы окно реликвии работало, переключите язык игры, например на английский.","Couldn't get relic data in time":"Не удалось вовремя распознать награды реликвии","Requiem relics are not supported yet":"Реликвии Реквиема пока не поддерживаются","Requiem relics are not supported":"Реликвии Реквиема не поддерживаются","Could not find any rewards. Please make sure your WARFRAME SCALING SETTINGS are up to date in AlecaFrame or ask for help in Discord.":"Награды не найдены. Проверьте, что в настройках AlecaFrame указан тот же МАСШТАБ МЕНЮ, что и в Warframe, или спросите в Discord.","Please make sure your WARFRAME SCALING SETTINGS are up to date in AlecaFrame or check FAQ T9 in our Discord for more help.":"Проверьте, что в настройках AlecaFrame указан тот же МАСШТАБ МЕНЮ, что и в Warframe. Подробнее — FAQ T9 в Discord AlecaFrame.","An unknown error was detected (NWD)":"Неизвестная ошибка (NWD)","Added 'favorite' icons to the relic overlay.":"В оверлей реликвий добавлены значки «избранное».","Added 'set' entry to remaining weapons in the foundry details dialog":"В окно подробностей литейной для остального оружия добавлена строка «набор»","Added a helminth tracker to the foundry (With its respective filter)":"В литейную добавлен трекер Гельминта (с отдельным фильтром)","Added a new setting to prevent AlecaFrame from moving itself automatically to a secondary monitor on startup":"Новая настройка: запрет автоматического переноса AlecaFrame на второй монитор при запуске","Added a new window to help users fix common scaling issues":"Новое окно для исправления типичных проблем с масштабом","Added a search bar to find listings for any item in WFMarket":"Добавлен поиск лотов WFMarket по любому предмету","Added a tracker for the current Circuit rotation.":"Добавлен трекер текущей ротации Цепи.","Added a WFMarket icon next to each riven to indicate whether a contract already exists. Suggested by @stevens":"Рядом с каждым модом Разлома — значок WFMarket, если контракт уже есть. Идея @stevens","Added current void fissures (with customizable notifications) and reset timers":"Добавлены текущие разрывы Бездны (с настраиваемыми уведомлениями) и таймеры сбросов","Added more detailed error messages when posting rivens to WFMarket":"Подробнее сообщения об ошибках при выставлении модов Разлома на WFMarket","Added more error messages for WFMarket":"Больше сообщений об ошибках WFMarket","Added support for faction emotes in the inventory tab":"Во вкладке инвентаря поддерживаются эмоции фракций","Added support for in-app changelogs (Like this one :D)":"Добавлены списки изменений в приложении (как этот :D)","Added support for K-Drives and Amps in the foundry (modular tab)":"В литейной поддерживаются К-драйвы и усилители (вкладка модульного)","Added support for more Baro Ki'Teer items":"Поддерживается больше предметов Баро Ки'Тиира","Added support for pet imprints in the inventory tab":"Во вкладке инвентаря поддерживаются отпечатки питомцев","Added support for scenes and landing craft parts":"Поддерживаются сцены и части десантных кораблей","Added the \"Favorite\" filter to the foundry":"В литейную добавлен фильтр «Избранное»","Added the \"Used for crafting\" filter to the foundry":"В литейную добавлен фильтр «Используется для создания»","Added WFMarket message notifications":"Добавлены уведомления о сообщениях WFMarket","Archon shards in a Warframe are now shown in the foundry. Implemented by @atomeistee":"Осколки Архонта в варфрейме теперь видны в литейной. Реализовал @atomeistee","Aya is now also tracked in the stats tab":"Айя теперь учитывается во вкладке статистики","Changed rivens to use the new 'x1.15' system in faction damage attributes":"Моды Разлома используют новую систему «x1.15» для урона по фракциям","Crafting trees! Rendering implemented by @f4nat1c":"Деревья создания! Отрисовку сделал @f4nat1c","Fixed a few bugs related to parts being built in the Foundry":"Исправлено несколько ошибок с частями, строящимися в литейной","Fixed an issue with component ownership for weapons made of other weapons":"Исправлен учёт компонентов для оружия, создаваемого из другого оружия","Fixed max mod levels in Railjack mods":"Исправлены максимальные уровни модов Рейлджека","Fixed some negative attributes showing a grade opposite than expected":"Исправлена обратная оценка у некоторых отрицательных свойств","Fixed some non-tradeable parts appearing in the inventory sets tab":"Непередаваемые части больше не появляются во вкладке наборов инвентаря","Fixed some scroll bars appearing when not needed":"Убраны лишние полосы прокрутки","Fixed the \"New items\" notification not working on some accounts. Reported by @leeryway":"Исправлено уведомление «Новые предметы» на некоторых аккаунтах. Сообщил @leeryway","Fixed the name of some components where its prefix would appear twice":"Исправлены названия компонентов с дублирующимся префиксом","Fixed the picture of some weapon components (such as stocks)":"Исправлены изображения некоторых частей оружия (например, прикладов)","Fixed wrong Shedu Chassis icon":"Исправлен значок каркаса Шеду","If the relic recommendation overlay fails to detect the relic type it will now automatically close.":"Оверлей рекомендаций реликвий теперь закрывается сам, если не распознал тип реликвии.","Improve OCR response time significantly":"Распознавание текста (OCR) стало значительно быстрее","Improved the looks of the mods section in the inventory tab.":"Улучшен вид раздела модов во вкладке инвентаря.","Items will be automatically marked as sold in WFMarket when a sale is completed. You can also +rep or report a user there.":"После сделки предметы автоматически отмечаются проданными на WFMarket. Там же можно повысить репутацию игроку или пожаловаться.","New 'Mastery helper' tab":"Новая вкладка «Помощник мастерства»","New 'Riven Finder' tab. Detailed riven info, good rolls and find your dream riven in the market":"Новая вкладка «Поиск модов Разлома»: подробности, удачные свойства и поиск мода мечты на рынке","New 'Riven Sniper' tab. Get notified whenever a riven your want is listed online":"Новая вкладка «Снайпер модов Разлома»: уведомление, как только нужный мод выставят на продажу","New main window layout":"Новый вид главного окна","New overlay for chat rivens (Only English supported)":"Новый оверлей для модов Разлома в чате (только английский)","New overlay for riven rerolling (Only English supported)":"Новый оверлей для переброса модов Разлома (только английский)","New tab: TennoFinder (Squads). Find squads to open relics, kill bosses and many other things way faster than using the in-game chat!":"Новая вкладка TennoFinder (отряды): ищите отряды для реликвий, боссов и многого другого гораздо быстрее, чем через игровой чат!","New Trading Analytics tab (Premium only)":"Новая вкладка «Аналитика торговли» (только Премиум)","New visuals in the relic overlay to show the set price. Implemented by @f4nat1c":"Новое отображение цены набора в оверлее реликвий. Реализовал @f4nat1c","Opening requiem relics won't trigger the relic rewards overlay anymore.":"Реликвии Реквиема больше не вызывают оверлей наград.","Reduced relic overlay size when subscribed. (Ad space removed completelly)":"Для подписчиков оверлей реликвий стал меньше (место под рекламу убрано полностью)","Removed Parallax Blueprint from the Parallax set. Suggested by @Scholar_Andrew":"Чертёж Параллакса убран из набора Параллакса. Идея @Scholar_Andrew","See which relics can drop a blueprint when hovering over a part in the foundry":"При наведении на часть в литейной видно, из каких реликвий выпадает чертёж","Some weapon parts (Ambassador) weren't recongized in the sets tab":"Некоторые части оружия (Ambassador) не распознавались во вкладке наборов","The relic planner now shows all relic tiers in the same slot. Suggested by @Scholar_Andrew and @WalfHero":"Вкладка «Реликвии» показывает все уровни улучшения в одной ячейке. Идея @Scholar_Andrew и @WalfHero","The relic reward overlay should now adapt better to weird scale/resolution combinations":"Оверлей наград лучше подстраивается под необычные сочетания масштаба и разрешения","The spaced reserved for an ad will now be hidden if the user is subscribed":"Место под рекламу скрывается, если у пользователя есть подписка","The WFMarket panel will now show a 'Connecting...' overlay if WFMarket is having issues":"Панель WFMarket показывает «Подключение...», если у WFMarket проблемы","You can now change the zoom level of the main window.":"Теперь можно менять масштаб главного окна.","You can now fav relics":"Реликвии можно добавлять в избранное","You can now see all relics (including not owned) in the relic planner.":"Во вкладке «Реликвии» видны все реликвии, включая отсутствующие.","You can now see mods that you don't own in the inventory tab. Suggested by @Why Wholesuhm?":"Во вкладке инвентаря видны моды, которых у вас нет. Идея @Why Wholesuhm?","You can now support AlecaFrame in Patreon and get new exclusive perks!":"Теперь AlecaFrame можно поддержать на Patreon и получить эксклюзивные бонусы!","Your rivens (and attributes) are now given a grade depending on how good they are. (Based on @44bananas excelent work)":"Моды Разлома и их свойства получают оценку качества (на основе отличной работы @44bananas)","Your Warframe scaling settings can now be detected automatically":"Настройки масштаба Warframe теперь определяются автоматически"},"patterns":{"Total: {0}":"Всего: {0}","{0} owned":"В наличии: {0}","MR: {0}":"РМ: {0}","{0} Relic":"Реликвия {0}","Error: {0}":"Ошибка: {0}","{0}-pack":"Набор из {0}","AlecaFrame just updated to version {0}!":"AlecaFrame обновлён до версии {0}!","(Rank {0})":"(ранг {0})","{0} / {1} XP":"{0} / {1} опыта","+{0} XP":"+{0} опыта","({0} needed)":"(нужно {0})","{0} (Veiled)":"{0} (нераскрытый)","Create a {0} squad":"Создать отряд: {0}","Guest by {0}":"Гость игрока {0}","Failed to get mod browser update: {0}":"Не удалось обновить каталог модов: {0}","Send {0}":"Отправить {0}","An error has ocurred on GetRelicWindowData: {0}":"Ошибка при получении данных реликвии: {0}","A general error has ocurred when doing relic work: {0}":"Ошибка при обработке реликвии: {0}","An general error has ocurred when doing relic work: {0}":"Ошибка при обработке реликвии: {0}"}}, "/* AlecaFrame-RU: layout fixes for longer Russian labels.\n   Only spacing/sizing, scoped to html[lang=\"ru\"]; colors and themes are not touched.\n   Each rule comes from tools/preview.mjs overflow report. */\n\n/* Stats → trade history filters: the 357px panel squeezed \"Продажа/Покупка/Сделка\". */\nhtml[lang=\"ru\"] .statsFilterTypeHolder .topSetting.stats {\n    padding-right: 4px;\n}\n");

/*
 * AlecaFrame-RU: optional features on top of the translation.
 *  - «Графит»: our own dark color theme over AlecaFrame's CSS variables.
 *  - Inventory: manual price refresh from warframe.market through AlecaFrame's
 *    own market client (plugin.GetBuySellWindowData, the call behind the WTS/WTB panel).
 *  - Relic reward overlay: live prices for the detected rewards, and no "best"
 *    highlight while no reward has a known price.
 *  - Main window: optional collapse of the ad block into its Patreon line (off by default).
 * Settings live in localStorage under "afru.*" and are shared by every AlecaFrame window.
 * The subscription status and AlecaFrame's own theme data are never touched.
 */
(function (root, css) {
  'use strict';
  if (!root || !root.document || root.__AF_RU_EXTRAS__) return;

  var doc = root.document;
  var page = (/([^/\\]+)\.html?$/i.exec((root.location && root.location.pathname) || '') || [])[1] || '';
  var OVERLAY_PAGES = { InGameNotification: 1, relicOverlay: 1, relicRecommendation: 1, rivenOverlay: 1, tradeFinishedNotification: 1 };
  var isOverlay = !!OVERLAY_PAGES[page];

  var PREFIX = 'afru.';
  var PRICE_CACHE_KEY = PREFIX + 'prices';
  var DEFAULTS = { theme: 'default', themeOverlays: true, relicLivePrices: true, collapseAds: false };
  var THEMES = { graphite: 1 };
  var REFINEMENTS = { intact: 'I', exceptional: 'E', flawless: 'F', radiant: 'R' };
  var config = {
    priceTtlMs: 60 * 60 * 1000,
    maxCachedPrices: 3000,
    // warframe.market allows about 3 requests per second.
    requestGapMs: 350,
    requestTimeoutMs: 15000,
    setupPollMs: 100,
    setupPollLimit: 600,
  };

  function now() { return Date.now(); }
  function warn(message, error) {
    try { root.console.warn('[AlecaFrame-RU] ' + message, error || ''); } catch (e) { /* no console */ }
  }

  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    });
    return node;
  }

  // ---------------------------------------------------------------- settings

  function storage() { try { return root.localStorage || null; } catch (e) { return null; } }
  function readRaw(key) {
    var s = storage();
    try { return s ? s.getItem(key) : null; } catch (e) { return null; }
  }
  function writeRaw(key, value) {
    var s = storage();
    try {
      if (!s) return;
      if (value == null) s.removeItem(key);
      else s.setItem(key, value);
    } catch (e) { warn('cannot save ' + key, e); }
  }

  function getSetting(name) {
    var raw = readRaw(PREFIX + name);
    if (raw == null) return DEFAULTS[name];
    return typeof DEFAULTS[name] === 'boolean' ? raw === 'true' : raw;
  }
  function setSetting(name, value) { writeRaw(PREFIX + name, String(value)); }

  // ------------------------------------------------------------------- theme

  function injectStyle() {
    if (!css || doc.getElementById('afru-extras-style')) return true;
    var parent = doc.head || doc.documentElement;
    if (!parent) return false;
    var style = doc.createElement('style');
    style.id = 'afru-extras-style';
    style.textContent = css;
    parent.appendChild(style);
    return true;
  }

  function applyTheme() {
    var html = doc.documentElement;
    if (!html) return;
    var theme = getSetting('theme');
    var active = THEMES[theme] && (!isOverlay || getSetting('themeOverlays'));
    if (active) html.setAttribute('data-afru-theme', theme);
    else html.removeAttribute('data-afru-theme');
  }

  // --------------------------------------------------------------------- ads

  function adsCollapsed() { return page === 'main' && getSetting('collapseAds'); }

  // AlecaFrame keeps its only OwAd in the implicit global `currentAd`. While the block is
  // collapsed the ad is removed, as AlecaFrame itself does under its modals, so nothing
  // keeps loading where nobody can see it.
  var ad = { instance: null, refresh: null, ready: false, removed: false };

  function syncAdPlayback() {
    var instance = ad.instance;
    if (!instance || !ad.refresh || !ad.ready) return;
    try {
      if (adsCollapsed() && !ad.removed) { ad.removed = true; instance.removeAd(); }
      else if (!adsCollapsed() && ad.removed) { ad.removed = false; ad.refresh.call(instance); }
    } catch (e) { warn('cannot switch the ad block', e); }
  }

  function adoptAd(instance) {
    ad.instance = instance;
    ad.refresh = null;
    ad.ready = false;
    ad.removed = false;
    if (!instance || typeof instance.refreshAd !== 'function' || typeof instance.removeAd !== 'function') return;
    var refresh = ad.refresh = instance.refreshAd;
    // AlecaFrame refreshes the ad after its modals close; keep it removed while collapsed.
    instance.refreshAd = function () { if (!adsCollapsed()) return refresh.apply(instance, arguments); };
    if (typeof instance.addEventListener === 'function') {
      // OwAd accepts API calls only after this event.
      instance.addEventListener('ow_internal_rendered', function () { ad.ready = true; syncAdPlayback(); });
    } else {
      ad.ready = true;
    }
  }

  function watchAdInstance() {
    var current = root.currentAd;
    try {
      Object.defineProperty(root, 'currentAd', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (value) { current = value; adoptAd(value); },
      });
    } catch (e) { warn('cannot watch the ad block', e); return; }
    if (current) adoptAd(current);
  }

  function applyAdLayout() {
    var html = doc.documentElement;
    if (html && page === 'main') {
      if (adsCollapsed()) html.setAttribute('data-afru-ads', 'collapsed');
      else html.removeAttribute('data-afru-ads');
    }
    syncAdPlayback();
  }

  function setAdsCollapsed(collapsed) {
    setSetting('collapseAds', collapsed);
    applyAdLayout();
    syncSettingsUi();
  }

  function setupAdStrip() {
    var block = doc.querySelector('.adCointainerWithSubscribe');
    if (!block) return false;
    if (block.querySelector('.afru-adExpand')) return true;
    var expand = el('button', {
      type: 'button', 'class': 'afru-adExpand', translate: 'no',
      title: 'Развернуть рекламный блок. Свернуть снова: Настройки → AlecaFrame-RU.',
    }, ['Показать']);
    expand.addEventListener('click', function () { setAdsCollapsed(false); });
    block.appendChild(expand);
    return true;
  }

  // ------------------------------------------------------------------ prices

  function priceKey(name, variant) {
    return String(name).replace(/\s+/g, ' ').trim().toLowerCase() + '|' + (variant == null ? '' : variant);
  }
  function isFresh(entry) { return !!entry && typeof entry.t === 'number' && now() - entry.t < config.priceTtlMs; }

  function readPriceCache() {
    try {
      var data = JSON.parse(readRaw(PRICE_CACHE_KEY) || '{}');
      return data && typeof data === 'object' ? data : {};
    } catch (e) { return {}; }
  }
  var priceCache = readPriceCache();

  function savePriceCache() {
    var kept = {};
    Object.keys(priceCache)
      .filter(function (k) { return isFresh(priceCache[k]); })
      .sort(function (a, b) { return priceCache[b].t - priceCache[a].t; })
      .slice(0, config.maxCachedPrices)
      .forEach(function (k) { kept[k] = priceCache[k]; });
    priceCache = kept;
    writeRaw(PRICE_CACHE_KEY, JSON.stringify(kept));
  }
  function freshPrice(key) { return isFresh(priceCache[key]) ? priceCache[key] : null; }

  /**
   * Lowest sell and highest buy price from AlecaFrame's warframe.market listings
   * ("platimun" is AlecaFrame's spelling). For items with variants (mod rank,
   * relic refinement) only listings of that variant count. Packs count per unit
   * and only when there are no single-item listings.
   */
  function pickPrices(data, variant) {
    function prices(list) {
      if (!Array.isArray(list)) return [];
      var valid = list.filter(function (l) { return l && Number(l.platimun) > 0; });
      var hasVariants = valid.some(function (l) { return l.specialValue != null && l.specialValue !== ''; });
      if (variant != null && hasVariants) {
        valid = valid.filter(function (l) { return String(l.specialValue) === String(variant); });
      }
      var singles = valid.filter(function (l) { return !(Number(l.tradeAmount) > 1); });
      if (singles.length) return singles.map(function (l) { return Number(l.platimun); });
      return valid.map(function (l) { return Math.round(Number(l.platimun) / Number(l.tradeAmount)); });
    }
    var sell = prices(data && data.sellListings);
    var buy = prices(data && data.buyListings);
    return {
      s: sell.length ? Math.min.apply(Math, sell) : null,
      b: buy.length ? Math.max.apply(Math, buy) : null,
    };
  }

  function marketClient() {
    try {
      var client = root.plugin && typeof root.plugin.get === 'function' ? root.plugin.get() : null;
      return client && typeof client.GetBuySellWindowData === 'function' ? client : null;
    } catch (e) { return null; }
  }

  var lastRequestAt = 0;
  var requestChain = Promise.resolve();

  /** Calls GetBuySellWindowData one request at a time; resolves to { data } or { error }. */
  function requestListings(name) {
    var job = requestChain.then(function () {
      var wait = Math.max(0, lastRequestAt + config.requestGapMs - now());
      return new Promise(function (resolve) { root.setTimeout(resolve, wait); });
    }).then(function () {
      lastRequestAt = now();
      return new Promise(function (resolve) {
        var client = marketClient();
        if (!client) { resolve({ error: 'unavailable' }); return; }
        var settled = false;
        var timer = root.setTimeout(function () { finish({ error: 'timeout' }); }, config.requestTimeoutMs);
        function finish(result) {
          if (settled) return;
          settled = true;
          root.clearTimeout(timer);
          resolve(result);
        }
        try {
          client.GetBuySellWindowData(name, function (success, json) {
            if (!success) { finish({ error: 'notfound' }); return; }
            try { finish({ data: JSON.parse(json) }); } catch (e) { finish({ error: 'parse' }); }
          });
        } catch (e) { finish({ error: 'call' }); }
      });
    });
    requestChain = job;
    return job;
  }

  /** Resolves to { entry: { s, b, t } } or { error }. Prices are cached for every window. */
  function fetchPrice(name, variant) {
    return requestListings(name).then(function (res) {
      if (!res.data) return { error: res.error };
      var p = pickPrices(res.data, variant);
      if (p.s == null && p.b == null) return { error: 'nolistings' };
      var entry = { s: p.s, b: p.b, t: now() };
      priceCache[priceKey(name, variant)] = entry;
      savePriceCache();
      return { entry: entry };
    });
  }

  function clearPrices() {
    priceCache = {};
    writeRaw(PRICE_CACHE_KEY, null);
  }

  // --------------------------------------------------------------- inventory

  function itemVariant(item) {
    if (item.type === 'mod' || item.type === 'arcane') return String(item.currentModRank == null ? 0 : item.currentModRank);
    if (item.isRelic || item.type === 'relic') {
      var m = /\b(intact|exceptional|flawless|radiant)\b/i.exec(item.name || '');
      return m ? REFINEMENTS[m[1].toLowerCase()] : 'I';
    }
    return null;
  }

  function inventoryItems() {
    var items = root.inventoryApp && root.inventoryApp.items;
    return items && typeof items.length === 'number' ? items : [];
  }

  function cachedEntryFor(item) {
    return item && item.name ? freshPrice(priceKey(item.name, itemVariant(item))) : null;
  }

  function applyCachedPrices() {
    var items = inventoryItems();
    for (var i = 0; i < items.length; i++) {
      var entry = cachedEntryFor(items[i]);
      if (!entry) continue;
      if (entry.s != null && items[i].sellPrice !== entry.s) items[i].sellPrice = entry.s;
      if (entry.b != null && items[i].buyPrice !== entry.b) items[i].buyPrice = entry.b;
    }
    markFreshCards();
  }

  // Cards follow the items order (v-for); the name check guards against a render in progress.
  function markFreshCards() {
    var app = root.inventoryApp;
    var mark = function () {
      var items = inventoryItems();
      var cards = doc.querySelectorAll('#inventoryObjectContainer > .inventoryObject');
      for (var i = 0; i < cards.length; i++) {
        var label = cards[i].querySelector('.inventoryItemName');
        var item = items[i];
        var matches = item && label && label.textContent.trim() === String(item.name).trim();
        if (matches && cachedEntryFor(item)) cards[i].setAttribute('data-afru-fresh', '');
        else cards[i].removeAttribute('data-afru-fresh');
      }
    };
    if (app && typeof app.$nextTick === 'function') app.$nextTick(mark);
    else root.setTimeout(mark, 0);
  }

  var refreshRun = null;
  var lastRefresh = null;

  function formatTime(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function renderChip() {
    var chip = doc.getElementById('afruPriceRefresh');
    if (!chip) return;
    var label = chip.querySelector('.afru-chipLabel');
    var meta = chip.querySelector('.afru-chipMeta');
    if (refreshRun) {
      var percent = refreshRun.total ? Math.round((100 * refreshRun.done) / refreshRun.total) : 0;
      chip.setAttribute('data-state', 'running');
      chip.setAttribute('aria-busy', 'true');
      chip.style.setProperty('--afru-progress', percent + '%');
      label.textContent = 'Обновление цен';
      meta.textContent = refreshRun.done + ' / ' + refreshRun.total;
      chip.title = 'Загружаются текущие заказы warframe.market. Нажмите, чтобы остановить.';
      return;
    }
    chip.removeAttribute('aria-busy');
    chip.setAttribute('data-state', lastRefresh && lastRefresh.error ? 'error' : 'idle');
    label.textContent = 'Обновить цены';
    if (!lastRefresh) {
      meta.textContent = '';
      chip.title = 'Загрузить текущие цены warframe.market (игроки онлайн) для показанных предметов. ' +
        'Зелёная точка на карточке — цена обновлена.';
    } else if (lastRefresh.error) {
      meta.textContent = 'нет связи';
      chip.title = 'AlecaFrame не ответил на запрос к warframe.market. Проверьте, что игра и AlecaFrame запущены, и попробуйте ещё раз.';
    } else {
      meta.textContent = formatTime(lastRefresh.at);
      chip.title = (lastRefresh.stopped ? 'Остановлено в ' : 'Обновлено в ') + formatTime(lastRefresh.at) + ': ' +
        lastRefresh.updated + ' из ' + lastRefresh.total + '.' +
        (lastRefresh.failed ? ' Без заказов на warframe.market: ' + lastRefresh.failed + '.' : '') +
        ' Зелёная точка на карточке — цена обновлена. Нажмите, чтобы обновить снова.';
    }
  }

  /** Refreshes prices of the items shown in the Inventory tab; a second call stops the run. */
  function refreshInventoryPrices() {
    if (refreshRun) { refreshRun.stopped = true; return Promise.resolve(); }
    var seen = {};
    var jobs = [];
    var items = inventoryItems();
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || !item.name) continue;
      var variant = itemVariant(item);
      var key = priceKey(item.name, variant);
      if (seen[key]) continue;
      seen[key] = true;
      jobs.push({ name: item.name, variant: variant });
    }
    if (!jobs.length) return Promise.resolve();

    var run = refreshRun = { done: 0, total: jobs.length, updated: 0, failed: 0, stopped: false, unavailable: false };
    renderChip();
    return new Promise(function (resolve) {
      (function next(index) {
        if (run.stopped || index >= jobs.length) {
          refreshRun = null;
          lastRefresh = {
            at: now(), updated: run.updated, total: run.total, failed: run.failed,
            stopped: run.stopped && !run.unavailable, error: run.unavailable && !run.updated ? 'unavailable' : null,
          };
          renderChip();
          resolve();
          return;
        }
        fetchPrice(jobs[index].name, jobs[index].variant).then(function (res) {
          run.done++;
          if (res.entry) { run.updated++; applyCachedPrices(); }
          else if (res.error === 'unavailable') { run.unavailable = true; run.stopped = true; }
          else run.failed++;
          renderChip();
          next(index + 1);
        });
      })(0);
    });
  }

  function buildChip() {
    var chip = el('div', {
      id: 'afruPriceRefresh', 'class': 'afru-chip', role: 'button', tabindex: '0', translate: 'no', 'data-state': 'idle',
    }, [
      el('span', { 'class': 'afru-chipIcon', 'aria-hidden': 'true' }),
      el('span', { 'class': 'afru-chipLabel' }, ['Обновить цены']),
      el('span', { 'class': 'afru-chipMeta', 'aria-live': 'polite' }),
      el('span', { 'class': 'afru-chipProgress', 'aria-hidden': 'true' }),
    ]);
    chip.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    chip.addEventListener('click', function () { refreshInventoryPrices(); });
    chip.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refreshInventoryPrices(); }
    });
    return chip;
  }

  function setupInventory() {
    var app = root.inventoryApp;
    var bar = doc.querySelector('#tabInventory .foundryTopSettingsSide.right');
    if (!app || typeof app.$watch !== 'function' || !bar) return false;
    if (!doc.getElementById('afruPriceRefresh')) bar.insertBefore(buildChip(), bar.firstChild);
    app.$watch('items', applyCachedPrices);
    applyCachedPrices();
    renderChip();
    return true;
  }

  // ---------------------------------------------------------- settings tab

  function syncSettingsUi() {
    var theme = doc.getElementById('afruTheme');
    if (theme) theme.value = THEMES[getSetting('theme')] ? getSetting('theme') : 'default';
    var overlays = doc.getElementById('afruThemeOverlays');
    if (overlays) overlays.checked = getSetting('themeOverlays');
    var live = doc.getElementById('afruRelicLive');
    if (live) live.checked = getSetting('relicLivePrices');
    var ads = doc.getElementById('afruCollapseAds');
    if (ads) ads.checked = getSetting('collapseAds');
  }

  function checkboxRow(id, text, extraClass) {
    return el('label', { 'class': 'settingsCheckBoxHolder' + (extraClass ? ' ' + extraClass : ''), 'for': id }, [
      el('input', { id: id, 'class': 'settingsCheckBoxHolderBox', type: 'checkbox' }),
      text,
    ]);
  }

  function buildSettingsTab() {
    var themeSelect = el('select', { id: 'afruTheme', 'class': 'settingsSelect' }, [
      el('option', { value: 'default' }, ['Стандартная AlecaFrame']),
      el('option', { value: 'graphite' }, ['Графит — нейтральная тёмная']),
    ]);
    var clearButton = el('button', { 'class': 'buttonSettingsTest', type: 'button' }, ['Сбросить сохранённые цены']);
    var clearStatus = el('span', { 'class': 'afru-settingsStatus', 'aria-live': 'polite' });

    var tab = el('div', { id: 'afruSettingsTab', 'class': 'settingsTab', translate: 'no' }, [
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Оформление']),
        el('label', { 'class': 'settingsCheckBoxHolder', 'for': 'afruTheme' }, ['Тема:', themeSelect]),
        checkboxRow('afruThemeOverlays', 'Применять тему к оверлеям в игре', 'indent'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Пока тема AlecaFrame-RU включена, она заменяет выбранную тему AlecaFrame.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Главное окно']),
        checkboxRow('afruCollapseAds', 'Сворачивать рекламный блок'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Блок сжимается в узкую полоску со ссылкой на Patreon, освободившееся место занимают таймеры. ' +
          'Пока блок свёрнут, реклама не загружается. Развернуть: кнопка «Показать» на полоске.',
        ]),
      ]),
      el('div', { 'class': 'settingsGroup' }, [
        el('span', { 'class': 'settingsTitle' }, ['Цены warframe.market']),
        checkboxRow('afruRelicLive', 'Уточнять цены наград в окне реликвии по текущим заказам'),
        el('div', { 'class': 'settingsCheckBoxHolder indent small' }, [
          'Кнопка «Обновить цены» во вкладке «Инвентарь» берёт заказы игроков онлайн через встроенный в AlecaFrame ' +
          'клиент warframe.market. Обновлённые цены хранятся 1 час.',
        ]),
        el('div', { 'class': 'settingsCheckBoxHolder' }, [clearButton, clearStatus]),
      ]),
    ]);

    themeSelect.addEventListener('change', function () { setSetting('theme', themeSelect.value); applyTheme(); });
    tab.querySelector('#afruThemeOverlays').addEventListener('change', function (e) { setSetting('themeOverlays', e.target.checked); });
    tab.querySelector('#afruRelicLive').addEventListener('change', function (e) { setSetting('relicLivePrices', e.target.checked); });
    tab.querySelector('#afruCollapseAds').addEventListener('change', function (e) { setAdsCollapsed(e.target.checked); });
    clearButton.addEventListener('click', function () {
      clearPrices();
      lastRefresh = null;
      renderChip();
      if (root.inventoryApp && typeof root.inventoryApp.refresh === 'function') {
        try { root.inventoryApp.refresh(); } catch (e) { warn('inventory refresh failed', e); }
      }
      clearStatus.textContent = 'Готово: показаны цены AlecaFrame';
    });
    return tab;
  }

  function setupSettingsTab() {
    var modal = doc.getElementById('modalSettings');
    var header = modal && modal.querySelector('.mainTabHeader');
    var body = modal && modal.querySelector('.mainTabBody');
    if (!root.settingsApp || !header || !body) return false;
    if (doc.getElementById('afruSettingsTab')) return true;

    var tab = buildSettingsTab();
    var button = el('div', { 'class': 'tabHeaderOption', tabid: 'afruSettingsTab', translate: 'no' }, ['AlecaFrame-RU']);
    // Same behavior as AlecaFrame's doTabHeaderWork(), whose handlers also hide this tab.
    button.addEventListener('click', function () {
      Array.prototype.forEach.call(header.children, function (c) { c.classList.remove('selected'); });
      Array.prototype.forEach.call(body.children, function (c) { c.classList.remove('shown'); });
      button.classList.add('selected');
      tab.classList.add('shown');
      syncSettingsUi();
    });
    header.appendChild(button);
    body.appendChild(tab);
    syncSettingsUi();
    return true;
  }

  // ----------------------------------------------------------- relic overlay

  function bestPlatinum(relics) {
    var best = 0;
    for (var i = 0; relics && i < relics.length; i++) {
      var p = Number(relics[i] && relics[i].platinum);
      if (p > best) best = p;
    }
    return best;
  }

  function refreshRelicPrices(list) {
    var app = root.relicsApp;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      (function (relic) {
        if (!relic || !relic.name || relic.detected === false) return;
        var cached = freshPrice(priceKey(relic.name, null));
        if (cached) { if (cached.s != null) relic.platinum = cached.s; return; }
        fetchPrice(relic.name, null).then(function (res) {
          if (res.entry && res.entry.s != null && app.relics === list) relic.platinum = res.entry.s;
        });
      })(list[i]);
    }
  }

  function setupRelicOverlay() {
    var app = root.relicsApp;
    if (!app || typeof app.$watch !== 'function') return false;
    // AlecaFrame's version marks every card when all prices are unknown (-1 >= -1).
    app.relicMaxPrice = function (relic) {
      var best = bestPlatinum(app.relics);
      return best > 0 && Number(relic && relic.platinum) >= best;
    };
    // Replacing a method is not reactive: redraw cards rendered with the old one.
    if (typeof app.$forceUpdate === 'function') app.$forceUpdate();
    if (getSetting('relicLivePrices')) {
      app.$watch('relics', refreshRelicPrices);
      if (app.relics && app.relics.length) refreshRelicPrices(app.relics);
    }
    return true;
  }

  // -------------------------------------------------------------------- init

  var ready = {};

  function whenReady(setups) {
    var pending = setups.slice();
    var tries = 0;
    function attempt() {
      pending = pending.filter(function (setup) {
        try {
          if (!setup()) return true;
          ready[setup.name] = true;
        } catch (e) { warn(setup.name + ' failed', e); }
        return false;
      });
      return !pending.length;
    }
    if (!pending.length || attempt()) return;
    var timer = root.setInterval(function () {
      if (attempt() || ++tries >= config.setupPollLimit) root.clearInterval(timer);
    }, config.setupPollMs);
  }

  function applyDocumentState() { applyTheme(); applyAdLayout(); }

  if (page === 'main') watchAdInstance();
  // The installer puts the script right after <head>; when run even earlier there is no <html> yet.
  if (injectStyle() && doc.documentElement) applyDocumentState();
  else doc.addEventListener('DOMContentLoaded', function () { injectStyle(); applyDocumentState(); });
  root.addEventListener('storage', function (e) {
    if (e.key === PRICE_CACHE_KEY) { priceCache = readPriceCache(); return; }
    if (e.key == null || e.key.indexOf(PREFIX) === 0) { applyDocumentState(); syncSettingsUi(); }
  });

  root.__AF_RU_EXTRAS__ = {
    /** Which hooks are installed in this window, e.g. { setupInventory: true }. */
    ready: ready,
    config: config,
    getSetting: getSetting,
    setSetting: setSetting,
    applyTheme: applyTheme,
    setAdsCollapsed: setAdsCollapsed,
    pickPrices: pickPrices,
    priceKey: priceKey,
    fetchPrice: fetchPrice,
    clearPrices: clearPrices,
    refreshInventoryPrices: refreshInventoryPrices,
  };

  if (page === 'main') whenReady([setupInventory, setupSettingsTab, setupAdStrip]);
  else if (page === 'relicOverlay') whenReady([setupRelicOverlay]);
})(typeof window !== 'undefined' ? window : null, "/* AlecaFrame-RU: controls added by extras.js. Colors come from AlecaFrame's own variables,\n   so they follow the default theme, AlecaFrame themes and «Графит» alike. */\n\n/* Inventory → «Обновить цены». Same pill as AlecaFrame's .topSetting, but always expanded. */\n.afru-chip {\n    position: relative;\n    display: flex;\n    align-items: center;\n    gap: 8px;\n    padding: 4px 14px 4px 9px;\n    border-radius: 16px;\n    overflow: hidden;\n    font-size: 15px;\n    white-space: nowrap;\n    cursor: pointer;\n    user-select: none;\n    color: var(--color-text);\n    background-color: var(--color-card);\n    transition: background-color 0.15s linear;\n}\n\n.afru-chip:hover {\n    background-color: var(--color-card-hover);\n}\n\n.afru-chip:focus-visible {\n    outline: 2px solid var(--color-tab-lighter);\n    outline-offset: 2px;\n}\n\n.afru-chipIcon {\n    width: 22px;\n    height: 22px;\n    flex-shrink: 0;\n    background: url('assets/img/platinum.png') center / contain no-repeat;\n}\n\n.afru-chipMeta {\n    font-size: 13px;\n    color: var(--color-navigation-hover);\n    font-variant-numeric: tabular-nums;\n}\n\n.afru-chipMeta:empty {\n    display: none;\n}\n\n.afru-chip[data-state=\"error\"] .afru-chipMeta {\n    color: #ff8282;\n}\n\n.afru-chipProgress {\n    position: absolute;\n    left: 0;\n    bottom: 0;\n    width: 0;\n    height: 3px;\n    background-color: var(--color-tab-lighter);\n    transition: width 0.2s linear;\n}\n\n.afru-chip[data-state=\"running\"] .afru-chipProgress {\n    width: var(--afru-progress, 0%);\n}\n\n.afru-chip[data-state=\"running\"] .afru-chipIcon {\n    animation: afru-pulse 1.2s ease-in-out infinite;\n}\n\n@keyframes afru-pulse {\n    50% { opacity: 0.4; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n    .afru-chip[data-state=\"running\"] .afru-chipIcon { animation: none; }\n}\n\n/* A card whose price came from warframe.market during the last hour. */\n.inventoryObject[data-afru-fresh]::after {\n    content: \"\";\n    position: absolute;\n    top: 12px;\n    right: 16px;\n    width: 8px;\n    height: 8px;\n    border-radius: 50%;\n    background-color: #4fd18b;\n    box-shadow: 0 0 0 3px var(--color-card);\n    pointer-events: none;\n}\n\n/* Settings → «Сворачивать рекламный блок»: the block shrinks to its Patreon line and the\n   timers panel takes the freed space, in the side column and in the bottom row alike. */\n.afru-adExpand {\n    display: none;\n}\n\nhtml[data-afru-ads=\"collapsed\"] .staticRightColumn {\n    flex-direction: column;\n}\n\nhtml[data-afru-ads=\"collapsed\"] .adCointainerWithSubscribe {\n    flex-direction: row;\n    align-items: center;\n    flex-shrink: 0;\n    gap: 10px;\n    padding: 5px 6px 5px 12px;\n}\n\nhtml[data-afru-ads=\"collapsed\"] #mainAD {\n    display: none;\n}\n\nhtml[data-afru-ads=\"collapsed\"] .adCointainerWithSubscribe .subscribeButton {\n    flex-grow: 1;\n    min-width: 0;\n    gap: 8px;\n}\n\nhtml[data-afru-ads=\"collapsed\"] .subscribeButton .subscriberIcon,\nhtml[data-afru-ads=\"collapsed\"] .subscribeButton .patreonBigIcon {\n    flex-shrink: 0;\n}\n\n/* AlecaFrame sizes every <button> as a 30px square icon. */\nhtml[data-afru-ads=\"collapsed\"] .afru-adExpand {\n    display: block;\n    flex-shrink: 0;\n    width: auto;\n    height: auto;\n    white-space: nowrap;\n    padding: 3px 12px;\n    border: none;\n    border-radius: 12px;\n    font: inherit;\n    font-size: 14px;\n    color: var(--color-text);\n    background-color: var(--color-card);\n    cursor: pointer;\n    transition: background-color 0.15s linear;\n}\n\n.afru-adExpand:hover {\n    background-color: var(--color-card-hover);\n}\n\n.afru-adExpand:focus-visible {\n    outline: 2px solid var(--color-tab-lighter);\n    outline-offset: 2px;\n}\n\n/* Settings → AlecaFrame-RU */\n#afruSettingsTab .settingsCheckBoxHolder .settingsSelect {\n    margin-left: 10px;\n}\n\n#afruSettingsTab .buttonSettingsTest {\n    margin: 0;\n}\n\n.afru-settingsStatus {\n    margin-left: 12px;\n    font-size: 14px;\n    color: var(--color-navigation-hover);\n}\n\n/* AlecaFrame-RU: тема «Графит» — нейтральная тёмная, без синевы и фиолетового.\n   Active only while html[data-afru-theme=\"graphite\"] is set (Settings → AlecaFrame-RU).\n   Variables are !important so the theme also wins over the colors that AlecaFrame's\n   own theme editor writes inline on :root. Ad slots are left as they are. */\nhtml[data-afru-theme=\"graphite\"] {\n    --color-bg-1: #0e1012 !important;\n    --color-bg-2: #15181b !important;\n    --color-bg-3: #1c2024 !important;\n    --color-card: #1c2024 !important;\n    --color-card-hover: #252a2f !important;\n    --color-card-active: #2f353b !important;\n    --color-tab: #1d5751 !important;\n    --color-tab-hover: #246b64 !important;\n    --color-tab-active: #2c857b !important;\n    --color-tab-lighter: #8fd6cc !important;\n    --color-buy: #1d4636 !important;\n    --color-buy-hover: #255a46 !important;\n    --color-buy-active: #2f8f5b !important;\n    --color-sell: #4a292d !important;\n    --color-sell-hover: #633338 !important;\n    --color-sell-active: #a8393a !important;\n    --color-navigation: #8b9096 !important;\n    --color-navigation-hover: #c8ccd0 !important;\n    --color-navigation-active: #eef0f2 !important;\n    --color-background-controls: #e6e8ea !important;\n    --color-text: #e6e8ea !important;\n    --color-text-bg: #e6e8ea !important;\n    --color-icons: #d3d7db !important;\n    --color-icons-bg: #e6e8ea !important;\n}\n\n/* Colors that AlecaFrame's CSS hard-codes instead of using the variables. */\nhtml[data-afru-theme=\"graphite\"] ::-webkit-scrollbar-track {\n    background: var(--color-card-active);\n}\n\nhtml[data-afru-theme=\"graphite\"] .foundryObjectTopIcon.componentInSomething,\nhtml[data-afru-theme=\"graphite\"] .foundryDetailsTopTopUsedInOthers,\nhtml[data-afru-theme=\"graphite\"] .foundryDetailsCraftingTree {\n    background-color: var(--color-tab);\n}\n\nhtml[data-afru-theme=\"graphite\"] .isMod > .inventoryItemImage,\nhtml[data-afru-theme=\"graphite\"] .relicPlanner > .relicDetailsBLTopExpected {\n    background-color: var(--color-bg-2);\n}\n\n/* AlecaFrame tints the native checkbox purple with hue-rotate(). */\nhtml[data-afru-theme=\"graphite\"] .settingsCheckBoxHolderBox {\n    filter: none;\n    accent-color: var(--color-tab-active);\n}\n\nhtml[data-afru-theme=\"graphite\"] .craft > .craftingTreeDetailsItemOwnedIcon,\nhtml[data-afru-theme=\"graphite\"] .crafting-tree-item-icon-extra.craftable,\nhtml[data-afru-theme=\"graphite\"] .inventoryItemQuantity.modLeveledUp,\nhtml[data-afru-theme=\"graphite\"] .inventoryWFMregisterButton,\nhtml[data-afru-theme=\"graphite\"] .deltaNotificationShow,\nhtml[data-afru-theme=\"graphite\"] .craftingTreeWikiButton,\nhtml[data-afru-theme=\"graphite\"] .ftueControl,\nhtml[data-afru-theme=\"graphite\"] .wfmItemButton.edit.editing {\n    background-color: var(--color-tab);\n}\n\nhtml[data-afru-theme=\"graphite\"] .foundryDetailsCraftingTree:hover,\nhtml[data-afru-theme=\"graphite\"] .inventoryWFMregisterButton:hover,\nhtml[data-afru-theme=\"graphite\"] .deltaNotificationShow:hover,\nhtml[data-afru-theme=\"graphite\"] .craftingTreeWikiButton:hover,\nhtml[data-afru-theme=\"graphite\"] .ftueControl:hover:not(:active):not(:disabled) {\n    background-color: var(--color-tab-hover);\n}\n\nhtml[data-afru-theme=\"graphite\"] .ftueControl:active:not(:disabled) {\n    background-color: var(--color-tab-active);\n}\n\nhtml[data-afru-theme=\"graphite\"] .craftingTreeUsedForCraftingItem,\nhtml[data-afru-theme=\"graphite\"] .crafting-tree-item.craftable {\n    background-color: #2c857b80;\n}\n\nhtml[data-afru-theme=\"graphite\"] .craftingTreeUsedForCraftingItem:hover,\nhtml[data-afru-theme=\"graphite\"] .crafting-tree-item.craftable:hover {\n    background-color: #2c857bb3;\n}\n\nhtml[data-afru-theme=\"graphite\"] .wfmItemButton.link,\nhtml[data-afru-theme=\"graphite\"] .wfmItemButton.showMore {\n    background-color: var(--color-card-active);\n}\n\nhtml[data-afru-theme=\"graphite\"] .wfmItemButton.showMore:hover {\n    background-color: var(--color-card-hover);\n}\n\nhtml[data-afru-theme=\"graphite\"] .wfmItem {\n    border-color: var(--color-card-active);\n}\n\nhtml[data-afru-theme=\"graphite\"] .filterTableHolder {\n    background-color: #0e1012c7;\n}\n\nhtml[data-afru-theme=\"graphite\"] #bannerText > a,\nhtml[data-afru-theme=\"graphite\"] .relicPlannerShowMoreButton {\n    color: var(--color-tab-lighter);\n}\n\nhtml[data-afru-theme=\"graphite\"] .alecaframeNameTopVersion,\nhtml[data-afru-theme=\"graphite\"] .relicBottomAlecaFrameTitleVersion {\n    color: var(--color-navigation);\n}\n\nhtml[data-afru-theme=\"graphite\"] .itemIsVaulted {\n    background-color: #e6e8ea2e;\n}\n\nhtml[data-afru-theme=\"graphite\"] .foundryObjectComponentsComponent.componentHighlight {\n    border-color: var(--color-tab-active);\n}\n\n/* Relic reward overlay: a clear outline for the most valuable reward. */\nhtml[data-afru-theme=\"graphite\"] .relicMaxPrice {\n    box-shadow: inset 0 0 0 2px var(--color-tab-lighter);\n}\n\nhtml[data-afru-theme=\"graphite\"] .relicItemLocked {\n    background-color: #e6e8ea1f;\n}\n");
