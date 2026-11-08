import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecipe, normalizeKeywords } from '../src/models.js';
import { normalizeFaunaCatalog } from '../src/catalog-adapters.js';
import { getHarvestSkillForCreatureType, rollFaunaHarvest } from '../src/fieldcraft-engine.js';

const readCatalog = async name => JSON.parse(
	await readFile(new URL(`../src/data/${name}`, import.meta.url), 'utf8')
);

test('Flora catalog covers each d20 result for all eight PDF terrains', async () => {
	const flora = await readCatalog('Flora.json');
	const categories = new Set(['Water', 'Fire', 'Earth', 'Air', 'Life', 'Shadow']);
	assert.equal(flora.length, 8);
	for (const table of flora) {
		assert.equal(table.entries.length, 6);
		assert.deepEqual(
			table.entries.flatMap(entry =>
				Array.from({ length: entry.rollMax - entry.rollMin + 1 }, (_, index) => entry.rollMin + index)
			).sort((left, right) => left - right),
			Array.from({ length: 20 }, (_, index) => index + 1),
			`${table.terrain} should cover the complete d20`
		);
		for (const entry of table.entries) {
			assert.equal(entry.keywords.length, 4);
			assert.ok(categories.has(entry.keywords[0]));
		}
	}
});

test('Fauna harvest profiles normalize to harvestable ingredients', async () => {
	const rawFauna = await readCatalog('Fauna.json');
	const fauna = normalizeFaunaCatalog(rawFauna);
	assert.equal(fauna.length, rawFauna.length);
	assert.ok(fauna.every(creature =>
		creature.id && creature.name && creature.challengeRating &&
		creature.creatureType &&
		Array.isArray(creature.habitat) && creature.habitat.length > 0 &&
		creature.normalHarvest && creature.criticalHarvest
	));
	assert.doesNotThrow(() => fauna.forEach(creature =>
		getHarvestSkillForCreatureType(creature.creatureType)
	));
	assert.ok(fauna.every(creature => [creature.normalHarvest, creature.criticalHarvest].every(item =>
		item.itemName && Number.isSafeInteger(item.quantity) && item.quantity > 0 &&
		item.keywords.length === 4 && item.rarity
	)));
	for (const creature of fauna) {
		const result = rollFaunaHarvest({ creature, modifier: 30, random: () => 0 });
		assert.equal(result.success, true, `${creature.name} should be harvestable`);
		assert.equal(result.critical, true);
		assert.deepEqual(
			result.loot.map(item => item.name),
			[creature.normalHarvest.itemName, creature.criticalHarvest.itemName]
		);
		assert.deepEqual(result.loot.map(item => item.quantity), [
			creature.normalHarvest.quantity,
			creature.criticalHarvest.quantity
		]);
	}
});

test('Recipes catalog preserves supported keyword recipes and product profiles', async () => {
	const recipes = await readCatalog('Recipes.json');
	assert.ok(recipes.length > 0);
	assert.equal(new Set(recipes.map(recipe => recipe.id)).size, recipes.length);
	const requiredCount = recipe => normalizeKeywords(recipe.requiredKeywords).length;
	const craftableRecipes = recipes.filter(recipe =>
		requiredCount(recipe) >= 1 &&
		requiredCount(recipe) <= 9 &&
		!recipe.requiredKeywords.some(keyword => String(keyword).trim().toLowerCase() === 'any')
	);
	assert.ok(craftableRecipes.length > 0);
	assert.doesNotThrow(() => craftableRecipes.forEach(recipe => createRecipe(recipe)));
	assert.ok(recipes.every(recipe => requiredCount(recipe) <= 9));
	assert.ok(recipes.filter(recipe => recipe.outputType === 'intermediate')
		.every(recipe => recipe.outputKeywords.length >= 1 && recipe.outputKeywords.length <= 4));
	assert.ok(recipes.every(recipe => !Object.hasOwn(recipe, 'craftingDc')));
	assert.ok(recipes.some(recipe => recipe.id === 'rec-arc-004' &&
		requiredCount(recipe) === 9));
});
