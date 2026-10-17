<h1><img src="assets/icon.svg" width="72" align="absmiddle" alt=""> AlecaFrame-RUS</h1>

Russian localization for AlecaFrame, the Warframe companion app: full translation, Russian search, a «Where to farm» tab with live Void Fissures and instant warframe.market prices in the relic reward overlay

[![Download](https://img.shields.io/badge/-Download-%232C857B)](https://github.com/TuftyTech/AlecaFrame-RUS/releases/latest/download/AlecaFrame-RUS.zip)
[![Русский](https://img.shields.io/badge/-%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-%231C2024)](README.md)
[![ci](https://github.com/TuftyTech/AlecaFrame-RUS/actions/workflows/ci.yml/badge.svg)](https://github.com/TuftyTech/AlecaFrame-RUS/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/TuftyTech/AlecaFrame-RUS?color=2C857B)](https://github.com/TuftyTech/AlecaFrame-RUS/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> [!CAUTION]
> **Unofficial, not reviewed by the AlecaFrame author.** To load the translation, Overwolf is started with relaxed file validation for **all** Overwolf apps while AlecaFrame-RUS is installed. See [Security](README.md#безопасность). Subscription, Patreon and paid features are never touched.

# 🎉 Features

- **Translation:** 900 of 900 interface strings of AlecaFrame 2.6.90, item names from the official Russian Warframe localization, the full item details window. Terms match the Russian game client.
- **Russian search in every search field:** Foundry, Inventory, Relics, Rivens, WFMarket. Word prefixes in any order, wrong keyboard layout («ytrjhf» = «некора»), accidental matches dropped («эш» finds Ash, not Fl**ash**).
- **Where to farm:** for a relic, where it drops and which fissures of its era are open right now; for a Prime part, which relics give it and whether they are vaulted; active fissures by era (normal, Steel Path, Void Storms), fast missions first; which era of *your* relics to crack now. Data from [api.warframestat.us](https://api.warframestat.us).
- **Relic reward overlay:** a price on every reward instantly (daily averages preloaded), then refined by live orders in parallel; ducats per platinum and missing set parts on each card.
- **Ads:** optional collapse of the main window ad block and an optional ad-free layout of the reward, riven and AFBuilds overlays. Both off by default; hidden ads are not loaded.
- **Install once:** one `Install.cmd`, one question. Russian after every Windows restart and AlecaFrame update. Interface language switch in settings: Русский, English (original), Same as Windows.

# Installation

1. Download **[AlecaFrame-RUS.zip](https://github.com/TuftyTech/AlecaFrame-RUS/releases/latest/download/AlecaFrame-RUS.zip)** and unpack it anywhere.
2. Quit the game. Leave Overwolf running, the installer restarts it.
3. Double-click **`Install.cmd`**, read what it does, type `да` (yes) and press Enter.
4. Overwolf restarts and AlecaFrame opens in Russian. All extras live in **Settings → AlecaFrame-RUS**.

Uninstall from **Settings → Apps → AlecaFrame-RUS** or with `Uninstall.cmd`: every AlecaFrame file is restored and Overwolf runs with full validation again.

# Development

```bash
pnpm install
pnpm test            # translation, search, extras (Node, jsdom, Vue 3.2.31)
pnpm test:windows    # installer and background agent (pwsh)
pnpm build           # dist/alecaframe-ru.js and dist/alecaframe-ru-texts.js
```

Full documentation, troubleshooting and the security model are in the [Russian README](README.md).

# License

[MIT](LICENSE) © 2026-present TuftyTech. AlecaFrame belongs to Alejandro Cabrerizo, Warframe to Digital Extremes, Overwolf to Overwolf Ltd. This project is not affiliated with or endorsed by any of them.
