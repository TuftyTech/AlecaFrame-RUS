// Shows AlecaFrame's «Item details» window (a weapon, a warframe, a mod) and a crafting tree with mock
// data in headless Chrome, in English and in Russian, and lists texts that do not fit.
// Usage: node tools/preview-details.mjs <AlecaFrame dir> [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, OVERWOLF_STUB, collectOverflows, serveStatic, webDirOf } from './harness.mjs';

const appDir = path.resolve(process.argv[2] ?? 'vendor/AlecaFrame');
const outDir = path.resolve(process.argv[3] ?? 'preview-out/details');
const bundlePath = path.resolve('dist/alecaframe-ru.js');
const textsPath = path.resolve('dist/alecaframe-ru-texts.js');
fs.mkdirSync(outDir, { recursive: true });

const PIC = 'assets/img/arcane.png';
const component = (name, owned, needed, description, extra) => ({
  baseData: { name, picture: PIC, uniqueName: `/Lotus/${name.replace(/\W/g, '')}`, quantityOwned: owned, neccessaryAmount: needed, parentOwned: false, isFavOnlyPart: false },
  description, drops: [], ...extra,
});
const mode = (name, shotType, critChance, critDamage, fireRate, statusChance) => ({
  name, shotType, critChance, critDamage, fireRate, statusChance,
  damages: [{ damageType: 'Impact', damage: 33 }, { damageType: 'Puncture', damage: 33 }, { damageType: 'Slash', damage: 33 }],
});
const ITEMS = {
  burston: {
    title: 'Burston', internalName: '/Lotus/Weapons/Tenno/Rifle/BurstRifle', imageURL: PIC, isFav: false, wikiLink: 'https://wiki.warframe.com/w/Burston',
    description: 'The Burston fires 3-round bursts, which provides a balance between the lethality of automatic rifles and the accuracy of semi-automatic rifles.',
    itemType: 'weaponShoot',
    extraWeaponShootData: {
      weaponType: 'Rifle', triggerType: 'Burst', noise: 'Alarming', magazineSize: 45, ammo: 540, rivenDisposition: 5, reloadTime: 2, polarities: ['madurai'],
      attacks: [
        mode('Normal Attack', 'Hit-Scan', 6, 1.6, 5, 18),
        mode('Incarnon Form', 'Hit-Scan', 30, 3, 20, 10),
        mode('Incarnon Form Radial Attack', 'AoE', 30, 3, 20, 10),
      ],
    },
    components: [
      component('Alloy Plate', 16000, 150, 'Carbon steel plates used to reinforce Grineer armor.\n\nLocation: Venus, Phobos, Ceres, Jupiter, Pluto, and Sedna.', { sellPrice: 125, buyPrice: 140 }),
      component('Burston Blueprint', 1, 1, ''),
      component('Ferrite', 41000, 600, 'Common Grineer alloy material.\n\nLocation: Earth, Venus, Mercury, Neptune, Phobos, Void.'),
      component('Morphics', 24, 1, 'Rare components used to make Warframe parts.\n\nLocation: Mercury, Mars, Phobos, Ceres, Europa, Uranus.'),
      component('Polymer Bundle', 14000, 400, 'Plastic material used in many weapons and equipment.\n\nLocation: Mercury, Uranus, and Sedna.'),
    ],
  },
  ash: {
    title: 'Ash', internalName: '/Lotus/Powersuits/Ninja/Ninja', imageURL: PIC, isFav: true, wikiLink: 'https://wiki.warframe.com/w/Ash',
    description: 'Behold the patron saint of the Orokin school of political assassination. Ash specializes in stealth. The edge of his blade is sooner felt than seen.',
    itemType: 'warframe',
    extraWarframeData: {
      baseHealth: 455, baseShield: 270, baseArmor: 65, baseEnergy: 150, runSpeed: 1.15, auraPolarity: 'madurai', polarities: ['madurai', 'naramon'],
      passive: 'Slash Status Effects inflicted on enemies do |DAMAGE|% increased damage and last |DURATION|% longer.',
      abilities: [
        { name: 'Shuriken', description: 'Launches a spinning blade of pain, dealing high damage and impaling enemies to walls.' },
        { name: 'Smoke Screen', description: 'Drops a smoke bomb that stuns enemies within a radius. The smoke obscures Ash, rendering him invisible.' },
        { name: 'Teleport', description: 'Ash teleports to the location of a target, flanking his enemy.' },
        { name: 'Blade Storm', description: 'Project shadow clones of Ash onto enemies within range.' },
      ],
    },
    components: [
      component('Ash Neuroptics', 1, 1, ''), component('Ash Chassis', 0, 1, ''), component('Systems', 1, 1, ''), component('Ash Blueprint', 1, 1, ''),
    ],
  },
  mod: {
    title: 'Primed Continuity', internalName: '/Lotus/Upgrades/Mods/Warframe/Expert/AvatarAbilityDurationModExpert', imageURL: PIC, isFav: false, wikiLink: '-',
    description: '', itemType: 'mod',
    extraModData: {
      type: 'Warframe Mod', rarity: 'Legendary', costIsGains: false, costRange: '4 - 14', polarity: 'madurai',
      tiers: [0, 5, 10].map((level) => ({ level, levelEndo: level * 400, levelCredits: level * 9000, endo: level * 4000, credits: level * 90000, benefits: `+${(level + 1) * 5}% Ability Duration` })),
    },
    components: [],
  },
};
const node = (name, extra = {}) => ({ data: { name, picture: PIC, uniqueName: name }, credits: 0, amountNeeded: 1, ...extra });
const TREE = {
  treeData: node('Ash', {
    credits: 25000, time: '3 d', recipeNumOut: 1,
    children: [
      node('Ash Neuroptics', { credits: 15000, time: '12 h', recipeNumOut: 1, children: [node('Ash Neuroptics Blueprint'), node('Alloy Plate', { amountNeeded: 150, gotEnough: true }), node('Neural Sensors', { gotEnough: true }), node('Polymer Bundle', { amountNeeded: 150, gotEnough: true }), node('Rubedo', { amountNeeded: 500, gotEnough: true })] }),
      node('Ash Chassis', { credits: 15000, time: '12 h', recipeNumOut: 1, children: [node('Ash Chassis Blueprint'), node('Morphics', { gotEnough: true }), node('Ferrite', { amountNeeded: 1000, gotEnough: true }), node('Rubedo', { amountNeeded: 300, gotEnough: true })] }),
      node('Systems', { credits: 15000, time: '12 h', recipeNumOut: 1, children: [node('Systems Blueprint'), node('Control Module', { gotEnough: true }), node('Morphics', { gotEnough: true }), node('Salvage', { amountNeeded: 500, gotEnough: true }), node('Plastids', { amountNeeded: 500, gotEnough: true })] }),
    ],
  }),
  parentWeapons: [],
};

const mockScript = `(() => {
  const ITEMS = ${JSON.stringify(ITEMS)};
  const TREE = ${JSON.stringify(TREE)};
  window.__AFRU_MOCK__ = {
    plugin: {
      GetFoundryDetails: (id, cb) => setTimeout(() => cb(true, JSON.stringify(ITEMS[id])), 20),
      GetCraftingTreeForItem: (id, hideCompleted, cb) => setTimeout(() => cb(true, JSON.stringify(TREE)), 20),
    },
  };
})();`;

const server = await serveStatic(webDirOf(appDir));
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const report = [];

async function openMain(russian, viewport) {
  const ctx = await browser.newContext({ viewport });
  // Playwright runs the most recently added matching route first.
  await ctx.route('**/*', (route) => (route.request().url().startsWith(server.base) ? route.continue() : route.abort()));
  await ctx.route('**/assets/js/alecaframe-ru-texts.js', (route) => route.fulfill({ path: textsPath, contentType: 'text/javascript' }));
  await ctx.addInitScript(mockScript);
  await ctx.addInitScript(OVERWOLF_STUB);
  if (russian) await ctx.addInitScript({ path: bundlePath });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.base}/main.html`, { waitUntil: 'load' });
  await page.addStyleTag({ content: '#loadingScreen { display: none !important; }' });
  await page.waitForFunction(() => window.foundryDetailsApp && window.craftingTreeApp);
  if (russian) await page.waitForFunction(() => window.__AF_RU__ && window.__AF_RU__.translate('Shuriken') === 'Сюрикен', null, { timeout: 15000 });
  return { ctx, page, errors };
}

async function record(page, name, scope) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  const overflows = await page.evaluate(collectOverflows, scope);
  const inScope = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => el.innerText).join('\n'), scope);
  const english = [...new Set(inScope.split('\n').map((s) => s.trim()).filter((s) => /[A-Za-z]{3}/.test(s) && !/[А-Яа-яЁё]/.test(s)))];
  report.push(`## ${name}`);
  for (const o of overflows) report.push(`  overflow +${o.over}px  ${o.text}  ::  ${o.path}`);
  if (english.length) report.push(`  English left: ${english.join(' | ')}`);
}

for (const [lang, russian] of [['en', false], ['ru', true]]) {
  // 1600x900 gives the modal its full 875px; 1280x720 squeezes it to ~700px.
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const { ctx, page, errors } = await openMain(russian, viewport);
    const size = `${viewport.width}x${viewport.height}`;
    for (const id of Object.keys(ITEMS)) {
      await page.evaluate((id) => window.foundryDetailsApp.open(id), id);
      await page.waitForFunction((name) => window.foundryDetailsApp.visible && window.foundryDetailsApp.item?.internalName === name, ITEMS[id].internalName);
      await page.waitForTimeout(400);
      if (id === 'burston') {
        await page.evaluate(() => { window.foundryDetailsApp.selectedComponent = window.foundryDetailsApp.item.components[0]; });
        await page.waitForTimeout(200);
      }
      await record(page, `details-${id}-${lang}-${size}`, '#modalFroundryDetails .innerModal');
      if (id === 'burston') {
        await page.locator('.foundryDetailsAttackModeListItem').last().click();
        await page.waitForTimeout(200);
        await record(page, `details-${id}-aoe-${lang}-${size}`, '#modalFroundryDetails .foundryDetailsTopCustom');
      }
      await page.evaluate(() => { window.foundryDetailsApp.visible = false; });
      // Reopening during the fade-out leaves the modal hidden.
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => window.craftingTreeApp.open('ash'));
    await page.waitForTimeout(800);
    await record(page, `tree-ash-${lang}-${size}`, '#modalCraftingTree .innerModal');
    report.push(...errors.map((e) => `  page error: ${e.split('\n')[0]}`));
    await ctx.close();
  }
}

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'report.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
