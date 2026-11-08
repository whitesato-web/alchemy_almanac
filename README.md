# Alchemist Almanac PWA

A lightweight, offline-capable D&D alchemy notebook. Serve the project root over HTTP or HTTPS and open `index.html`; the service worker caches the app shell and data catalogs for offline use. Run `npm.cmd test` and `npm.cmd run check` to validate the application.

## Deploy to GitHub Pages

Create a GitHub repository, push this project to its `main` branch, then in the repository settings choose **Pages → Build and deployment → GitHub Actions**. The included workflow publishes the app on every push to `main`. Open the Pages URL on your phone and use the browser's **Add to Home Screen** option. The app shell and catalogs update on the phone after a new deployment; player data stored in local browser storage does not sync between devices.

## Four-keyword crafting

- Every Flora/Fauna ingredient has exactly four ordered keywords. Its rarity determines how many slots are revealed at each player level: Common 1/2/3/4; Uncommon 1/3/5/7; Rare 1/4/7/10; Very Rare 1/5/9/13; Legendary 1/6/10/15. Crafted products can have their own one-to-four-keyword profiles.
- Wild ingredients cannot contribute the `Arcane` keyword; crafted ingredients can.
- Recipes can require one to nine keyword slots. Repeated keywords are allowed and each repeated slot requires another copy of that keyword. Unused slots remain blank; there are no wildcard slots.
- Experimentation checks the active keywords and records recipe discoveries without consuming ingredients. Crafting consumes the selected ingredient quantities only when every required recipe slot is met.
- Basic foraged and harvested ingredients have exactly four keywords. Intermediate and final crafted products may define one to four product keywords; final products may omit a profile. Crafted products with keywords can be selected as ingredients in a later craft.

`src/data/Flora.json` has the terrain d20 tables, descriptions, rarity, and four keyword profiles. `src/data/Fauna.json` stores each creature's `normalHarvest` and `criticalHarvest` item and quantity. `src/data/Recipes.json` contains the recipe requirements; recipes may define one to nine required keywords. Entries without one to nine valid requirements are skipped because they cannot be crafted.

`src/data/KeywordProgression.json` is a design reference, not runtime game data. It records proposed keyword families and tiers, emergent combinations, and a progression direction in which accessible base materials lead to increasingly rare intermediate keywords and recipes. Refer to it when designing future keywords, intermediate components, or high-tier recipes; its combinations are proposals and are not currently implemented or validated against the live catalogs.

## Models and persistence

`src/models.js` defines Ingredient, InventoryItem, Recipe, and PlayerState constructors. PlayerState includes all six abilities, all 18 standard D&D skills with proficiency/expertise, tool ownership/proficiency, and recipe/keyword discoveries. Player state, inventory, and discoveries persist in localStorage. Recipe definitions are managed through the catalog/import workflow rather than the Recipes tab. JSON backup/restore is available on the Import/Export page. The v3 storage migration upgrades earlier short keyword profiles while preserving player data.

`src/keyword-engine.js` contains rarity unlocks, keyword matching, experimentation, crafting, and character roll profiles. `src/fieldcraft-engine.js` contains the PDF-based Flora and Fauna gathering checks.

The Admin · SanityCheck tab reports recipe catalog entries skipped for invalid requirements and summarizes keywords from the Flora and Fauna catalogs and recipe data. Sources count catalog entries and recipe products once per keyword; recipe uses count required keyword slots, with repeated slots counted separately. Delta is the absolute difference between sources and recipe uses. Each column can be sorted.

The Recipes tab lists only recipes the player has discovered. New recipe data is managed through the catalog/import workflow rather than the old in-app recipe-entry form. Crafted products may define one to four product keywords; final products may omit a profile. Crafted products with product keywords can be reused as ingredients.

## Fieldcraft

The Forage page supports flora gathering and carcass harvesting. Nature checks use the selected search-pace DC (12/15/18/21); a flora critical success succeeds by 10 or more and rolls 1d4 separate terrain-table results. Fauna records include a `CreatureType`; it determines whether Nature, Survival, Religion, or Arcana is used for the harvest check. Standard creature harvesting succeeds at the base DC and yields `normalHarvest`; a critical success (total at least 10 over the base DC) yields both harvest items. Dedicated extraction is offered only when the creature has a `criticalHarvest`, raises the success DC by 5, and yields only `criticalHarvest` on success; a critical success still yields both items. Forage and harvest actions have a five-second cooldown to prevent accidental repeat attempts.
