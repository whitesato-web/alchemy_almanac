import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryItem, createPlayerState, createRecipe } from '../src/models.js';
import {
	analyzeCombination,
	craftWithKeywords,
	experimentWithIngredients,
	getCharacterRollProfile,
	getUnlockedKeywords,
	matchRecipeKeywords,
	rollForage,
	rollTerrainForage
} from '../src/keyword-engine.js';
import { rollFloraGathering } from '../src/fieldcraft-engine.js';

const reagent = (id, name, keywords, extra = {}) => createInventoryItem({
	id,
	name,
	keywords,
	quantity: 4,
	rarity: 'Common',
	category: 'flora',
	isWild: true,
	...extra
});

test('fixed level thresholds reveal a progressively larger ordered keyword prefix', () => {
	const item = reagent('uncommon', 'Moss', ['Life', 'Water', 'Earth', 'Nature'], { rarity: 'Uncommon' });
	assert.deepEqual(getUnlockedKeywords(item, 1), ['Life']);
	assert.deepEqual(getUnlockedKeywords(item, 4), ['Life']);
	assert.deepEqual(getUnlockedKeywords(item, 5), ['Life', 'Water']);
	assert.deepEqual(getUnlockedKeywords(item, 9), ['Life', 'Water']);
	assert.deepEqual(getUnlockedKeywords(item, 10), ['Life', 'Water', 'Earth']);
	assert.deepEqual(getUnlockedKeywords(item, 14), ['Life', 'Water', 'Earth']);
	assert.deepEqual(getUnlockedKeywords(item, 15), ['Life', 'Water', 'Earth', 'Nature']);
});

test('keyword unlock thresholds are identical for every rarity', () => {
	const keywords = ['One', 'Two', 'Three', 'Four'];
	const rarities = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Legendary'];
	for (const rarity of rarities) {
		for (const [level, count] of [[1, 1], [5, 2], [10, 3], [15, 4]]) {
			assert.deepEqual(
				getUnlockedKeywords(reagent(rarity, rarity, keywords, { rarity }), level),
				keywords.slice(0, count),
				`${rarity} should unlock ${count} keyword(s) at level ${level}`
			);
		}
	}
});

test('wild ingredients cannot contribute Arcane but crafted ingredients can', () => {
	const wild = reagent('wild', 'Starflower', ['Arcane', 'Light', 'Life', 'Air']);
	const crafted = reagent('crafted', 'Arcane Essence', ['Arcane', 'Light', 'Life', 'Air'], {
		isWild: false,
		source: 'Craft'
	});
	assert.deepEqual(getUnlockedKeywords(wild, 20), ['Light', 'Life', 'Air']);
	assert.deepEqual(getUnlockedKeywords(crafted, 20), ['Arcane', 'Light', 'Life', 'Air']);
});

test('combination matching counts duplicate keywords across selected reagents', () => {
	const inventory = [
		reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth']),
		reagent('b', 'Cinder', ['Fire', 'Air', 'Light', 'Earth'])
	];
	const analysis = analyzeCombination({
		inventory,
		playerLevel: 1,
		selections: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }]
	});
	assert.equal(analysis.success, true);
	assert.equal(analysis.keywordCounts.fire, 2);
});

test('repeated experiment selections aggregate quantities and enforce available stock', () => {
	const inventory = [reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth'])];
	const analysis = analyzeCombination({
		inventory,
		playerLevel: 4,
		selections: [{ id: 'a', quantity: 1 }, { id: 'a', quantity: 2 }]
	});
	assert.equal(analysis.success, true);
	assert.equal(analysis.selected.length, 1);
	assert.equal(analysis.selected[0].quantity, 3);
	assert.equal(analysis.keywordCounts.fire, 3);
	assert.equal(analyzeCombination({
		inventory,
		playerLevel: 4,
		selections: [{ id: 'a', quantity: 3 }, { id: 'a', quantity: 2 }]
	}).success, false);
});

test('partial recipe matching returns matched slots and masks remaining requirements', () => {
	const recipe = createRecipe({
		id: 'partial',
		name: 'Unfinished Tonic',
		requiredKeywords: ['Fire', 'Fire', 'Water', 'Life']
	});
	const match = matchRecipeKeywords(recipe, { fire: 1, water: 1 });
	assert.equal(match.progress, 2);
	assert.deepEqual(match.matchedSlots, ['Fire', '???', 'Water', '???']);
});

test('successful experiments choose an applicable recipe and consume all selected ingredients', () => {
	const inventory = [reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth'])];
	const recipes = [
		createRecipe({ id: 'r1', name: 'Warmth', requiredKeywords: ['Fire', 'Water', 'Life', 'Earth'] }),
		createRecipe({ id: 'r2', name: 'Renewal', requiredKeywords: ['Fire', 'Water', 'Life', 'Earth'] })
	];
	const result = experimentWithIngredients({
		inventory,
		selections: [{ id: 'a', quantity: 1 }],
		recipes,
		player: createPlayerState({ level: 15 }),
		random: () => 0.99
	});
	assert.equal(result.success, true);
	assert.equal(result.valid, true);
	assert.equal(result.selectedRecipe.recipeId, 'r2');
	assert.equal(result.inventory[0].quantity, 3);
	assert.equal(inventory[0].quantity, 4);
});

test('experiments fail rather than rediscovering a known recipe', () => {
	const inventory = [reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth'])];
	const recipe = createRecipe({
		id: 'known-recipe',
		name: 'Known Mixture',
		requiredKeywords: ['Fire', 'Water']
	});
	const result = experimentWithIngredients({
		inventory,
		selections: [{ id: 'a' }],
		recipes: [recipe],
		knownRecipeIds: ['known-recipe'],
		player: createPlayerState({ level: 5 }),
		random: () => 0
	});

	assert.equal(result.success, false);
	assert.equal(result.valid, true);
	assert.equal(result.selectedRecipe, undefined);
	assert.equal(result.nearMissCount, 0);
	assert.equal(result.inventory[0].quantity, 3);
});

test('experiments learn an unknown covered recipe when a known recipe also matches', () => {
	const inventory = [reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth'])];
	const recipes = [
		createRecipe({ id: 'known-recipe', name: 'Known Mixture', requiredKeywords: ['Fire', 'Water'] }),
		createRecipe({ id: 'unknown-recipe', name: 'New Mixture', requiredKeywords: ['Life', 'Earth'] })
	];
	const result = experimentWithIngredients({
		inventory,
		selections: [{ id: 'a' }],
		recipes,
		knownRecipeIds: ['known-recipe'],
		player: createPlayerState({ level: 15 }),
		random: () => 0
	});

	assert.equal(result.success, true);
	assert.equal(result.selectedRecipe.recipeId, 'unknown-recipe');
});

test('Potion of Healing with a single Life requirement is discoverable', () => {
	const recipe = createRecipe({
		id: 'potion-healing-life',
		name: 'Potion of Healing',
		requiredKeywords: ['Life']
	});
	const inventory = [reagent('life-source', 'Healing Herb', ['Life', 'Water', 'Earth', 'Nature'])];
	const result = experimentWithIngredients({
		inventory,
		selections: [{ id: 'life-source' }],
		recipes: [recipe],
		player: createPlayerState({ level: 1 }),
		random: () => 0
	});
	assert.equal(result.success, true);
	assert.equal(result.selectedRecipe.name, 'Potion of Healing');
});

test('nine-keyword recipe from the catalog can be matched', async () => {
	const { readFile } = await import('node:fs/promises');
	const catalog = JSON.parse(await readFile(new URL('../src/data/Recipes.json', import.meta.url), 'utf8'));
	const catalogRecipe = catalog.find(recipe => recipe.id === 'rec-arc-004');
	const recipe = createRecipe(catalogRecipe);
	assert.equal(recipe.requiredKeywords.length, 9);
	const keywordCounts = Object.fromEntries(recipe.requiredKeywords.reduce((counts, keyword) => {
		const key = keyword.toLowerCase();
		counts.set(key, (counts.get(key) || 0) + 1);
		return counts;
	}, new Map()));
	const match = matchRecipeKeywords(recipe, keywordCounts);
	assert.equal(match.matched, true);
	assert.equal(match.progress, 9);
});

test('crafted potion product keywords are retained and reusable as ingredients', () => {
	const healingPotion = createRecipe({
		id: 'healing',
		name: 'Potion of Healing',
		requiredKeywords: ['Life'],
		outputKeywords: [],
		Keywords: ['Restore']
	});
	const crafted = craftWithKeywords({
		recipe: healingPotion,
		inventory: [reagent('life-source', 'Healing Herb', ['Life', 'Water', 'Earth', 'Nature'])],
		selections: [{ id: 'life-source' }],
		player: createPlayerState({ level: 1 })
	});

	assert.equal(crafted.success, true);
	assert.deepEqual(crafted.inventory[1].keywords, ['Restore']);
	const restoreRecipe = createRecipe({
		id: 'restore-recipe',
		name: 'Restore Recipe',
		requiredKeywords: ['Restore']
	});
	const result = experimentWithIngredients({
		inventory: crafted.inventory,
		selections: [{ id: crafted.inventory[1].id }],
		recipes: [restoreRecipe],
		player: createPlayerState({ level: 1 }),
		random: () => 0
	});

	assert.equal(result.success, true);
	assert.equal(result.selectedRecipe.name, 'Restore Recipe');
});

test('failed experiments consume one randomly selected ingredient and return near-miss details', () => {
	const inventory = [
		reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth']),
		reagent('b', 'Cinder', ['Air', 'Light', 'Force', 'Earth'])
	];
	const recipe = createRecipe({ id: 'r1', name: 'Inferno', requiredKeywords: ['Fire', 'Fire', 'Fire', 'Fire'] });
	const result = experimentWithIngredients({
		inventory,
		selections: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }],
		recipes: [recipe],
		player: createPlayerState({ level: 4 }),
		random: () => 0.99
	});
	assert.equal(result.success, false);
	assert.equal(result.valid, true);
	assert.equal(result.nearMissCount, 1);
	assert.equal(result.closestNearMiss.progress, 1);
	assert.equal(result.consumedIngredient, 'Cinder');
	assert.equal(result.inventory[0].quantity, 4);
	assert.equal(result.inventory[1].quantity, 3);
	assert.deepEqual(inventory.map(item => item.quantity), [4, 4]);
});

test('deprecated Any requirements are not applicable', () => {
	const match = matchRecipeKeywords(
		{ requiredKeywords: ['Air', 'Any'] },
		{ air: 1, fire: 1 }
	);
	assert.equal(match.applicable, false);
	assert.throws(() => createRecipe({
		name: 'Wildcard recipe',
		requiredKeywords: ['Air', 'Any']
	}), /deprecated Any wildcard/);
});

test('keyword crafting consumes only after a complete match and records effect magnitudes', () => {
	const inventory = [
		reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth']),
		reagent('b', 'Cinder', ['Fire', 'Air', 'Light', 'Earth'])
	];
	const recipe = createRecipe({
		id: 'r1',
		name: 'Kindling Draught',
		requiredKeywords: ['Fire', 'Fire', 'Water', 'Life'],
		fullEffect: 'Deals fire damage.'
	});
	const result = craftWithKeywords({
		recipe,
		inventory,
		selections: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }],
		player: createPlayerState({ level: 15 }),
		quantity: 2
	});
	assert.equal(result.success, true);
	assert.equal(result.inventory[0].quantity, 2);
	assert.equal(result.inventory[1].quantity, 2);
	assert.equal(result.inventory[2].quantity, 2);
	assert.equal(result.effect.keywordMagnitudes.find(item => item.keyword === 'fire').count, 2);
});

test('crafted items from the same recipe stack despite different keyword magnitudes', () => {
	const inventory = [
		reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth']),
		createInventoryItem({
			id: 'existing-potion',
			name: 'Kindling Draught',
			quantity: 3,
			category: 'concoction',
			isWild: false,
			source: 'Craft',
			crafted: true,
			isIntermediate: false,
			recipeId: 'r1',
			effectProfile: { keywordMagnitudes: [{ keyword: 'fire', count: 1 }] }
		})
	];
	const recipe = createRecipe({
		id: 'r1',
		name: 'Kindling Draught',
		requiredKeywords: ['Fire', 'Water', 'Life', 'Earth']
	});
	const result = craftWithKeywords({
		recipe,
		inventory,
		selections: [{ id: 'a', quantity: 1 }],
		player: createPlayerState({ level: 15 })
	});
	assert.equal(result.success, true);
	assert.equal(result.inventory.length, 2);
	assert.equal(result.inventory[1].quantity, 4);
});

test('failed keyword crafting leaves inventory unchanged', () => {
	const inventory = [reagent('a', 'Emberleaf', ['Fire', 'Water', 'Life', 'Earth'])];
	const recipe = createRecipe({ id: 'r1', name: 'Storm Draught', requiredKeywords: ['Fire', 'Fire', 'Water', 'Life'] });
	const result = craftWithKeywords({
		recipe,
		inventory,
		selections: [{ id: 'a', quantity: 1 }],
		player: createPlayerState({ level: 15 })
	});
	assert.equal(result.success, false);
	assert.equal(inventory[0].quantity, 4);
});

test('crafted intermediate products can supply wild-unavailable keywords', () => {
	const ingredient = reagent('leaf', 'Moonleaf', ['Fire', 'Water', 'Life', 'Earth']);
	const intermediateRecipe = createRecipe({
		id: 'arcane-essence',
		name: 'Arcane Essence',
		requiredKeywords: ['Fire', 'Water', 'Life', 'Earth'],
		outputType: 'intermediate',
		outputRarity: 'Rare',
		outputKeywords: ['Arcane', 'Force', 'Light', 'Mind']
	});
	const crafted = craftWithKeywords({
		recipe: intermediateRecipe,
		inventory: [ingredient],
		selections: [{ id: 'leaf', quantity: 1 }],
		player: createPlayerState({ level: 15 })
	});
	assert.equal(crafted.success, true);
	const intermediate = crafted.inventory[1];
	assert.equal(intermediate.isIntermediate, true);
	assert.deepEqual(getUnlockedKeywords(intermediate, 1), ['Arcane']);
	const analysis = analyzeCombination({
		inventory: crafted.inventory,
		selections: [{ id: intermediate.id, quantity: 1 }],
		playerLevel: 1
	});
	assert.equal(analysis.success, true);
	assert.equal(analysis.keywordCounts.arcane, 1);
});

test('Arcane Dust converts four elemental inputs into an Arcane intermediate ingredient', () => {
	const inventory = [
		reagent('fire', 'Fire source', ['Fire', 'Nature', 'Force', 'Life']),
		reagent('air', 'Air source', ['Air', 'Nature', 'Force', 'Life']),
		reagent('earth', 'Earth source', ['Earth', 'Nature', 'Force', 'Life']),
		reagent('water', 'Water source', ['Water', 'Nature', 'Force', 'Life'])
	];
	const recipe = createRecipe({
		id: 'arcane-dust',
		name: 'Arcane Dust',
		requiredKeywords: ['Fire', 'Air', 'Earth', 'Water'],
		outputType: 'intermediate',
		outputRarity: 'Uncommon',
		outputKeywords: ['Arcane', 'Force', 'Light', 'Mind']
	});
	const result = craftWithKeywords({
		recipe,
		inventory,
		selections: inventory.map(item => ({ id: item.id, quantity: 1 })),
		player: createPlayerState({ level: 1 })
	});

	assert.equal(result.success, true);
	const dust = result.inventory[4];
	assert.deepEqual(dust.keywords, ['Arcane', 'Force', 'Light', 'Mind']);
	assert.equal(dust.isIntermediate, true);
	assert.deepEqual(getUnlockedKeywords(dust, 1), ['Arcane']);
	const analysis = analyzeCombination({
		inventory: result.inventory,
		selections: [{ id: dust.id, quantity: 1 }],
		playerLevel: 1
	});
	assert.equal(analysis.keywordCounts.arcane, 1);
});

test('forage rolls use configured location probabilities and refuse missing tables', () => {
	const table = [
		{ location: 'Forest', chance: 0.25, reagent: 'Moss' },
		{ location: 'Forest', chance: 0.5, reagent: 'Mushroom' }
	];
	assert.equal(rollForage({ location: 'Forest', forageTable: table, random: () => 0.4 }).reagent, 'Mushroom');
	assert.equal(rollForage({ location: 'Forest', forageTable: table, random: () => 0.9 }).found, false);
	assert.equal(rollForage({ location: 'Forest', forageTable: [], random: () => 0 }).success, false);
});

test('terrain forage selects only matching CSV entries and returns their harvest yield', () => {
	const reagents = [
		{ name: 'Stoneleaf', terrain: 'Forest; Rivers', harvestYield: 2 },
		{ name: 'Reed', terrain: 'Rivers; Marsh', harvestYield: 4 },
		{ name: 'Cave Moss', terrain: 'Caves', harvestYield: 1 }
	];
	const result = rollTerrainForage({ terrain: 'rivers', reagents, random: () => 0.75 });
	assert.equal(result.success, true);
	assert.equal(result.roll, 2);
	assert.equal(result.rollMaximum, 2);
	assert.equal(result.reagent.name, 'Reed');
	assert.equal(result.quantity, 4);
	assert.equal(rollTerrainForage({ terrain: 'Ocean', reagents, random: () => 0 }).success, false);
	assert.throws(
		() => rollTerrainForage({ terrain: 'Rivers', reagents: [{ name: 'Invalid', terrain: 'Rivers', harvestYield: 0 }] }),
		/positive whole number/
	);
});

test('fieldcraft uses the Nature check DC, weighted d20 table, and critical-success quantity', () => {
	const floraTables = [{
		terrain: 'Forest',
		entries: [
			{ name: 'Common Moss', rollMin: 1, rollMax: 10, keywords: ['Water', 'Life', 'Nature', 'Healing'] },
			{ name: 'Rare Bloom', rollMin: 11, rollMax: 20, keywords: ['Life', 'Nature', 'Healing', 'Vitality'] }
		]
	}];
	const rolls = [0.99, 0.99, 0.99, 0.01, 0.49, 0.5, 0.99];
	const result = rollFloraGathering({
		terrain: 'forest',
		modifier: 3,
		advantage: true,
		method: 'dedicated',
		floraTables,
		random: () => rolls.shift()
	});
	assert.equal(result.success, true);
	assert.equal(result.critical, true);
	assert.equal(result.check.dieRoll, 20);
	assert.equal(result.check.total, 23);
	assert.equal(result.quantityRoll, 4);
	assert.deepEqual(result.finds.map(({ flora }) => flora.name), [
		'Common Moss', 'Common Moss', 'Rare Bloom', 'Rare Bloom'
	]);
});

test('fieldcraft fails without harvesting and rejects malformed terrain tables', () => {
	const floraTables = [{
		terrain: 'Arctic',
		entries: [{ name: 'Moss', rollMin: 1, rollMax: 20, keywords: ['Water', 'Life', 'Nature', 'Healing'] }]
	}];
	const failed = rollFloraGathering({
		terrain: 'Arctic',
		method: 'fast',
		modifier: -1,
		floraTables,
		random: () => 0
	});
	assert.equal(failed.success, false);
	assert.equal(failed.finds.length, 0);
	assert.throws(() => rollFloraGathering({
		terrain: 'Arctic',
		floraTables: [{ terrain: 'Arctic', entries: [{ name: 'Moss', rollMin: 2, rollMax: 20, keywords: ['Water', 'Life', 'Nature', 'Healing'] }] }],
		random: () => 0
	}), /cover each d20 result/);
});

test('models enforce the nine-slot recipe limit and ingredient keyword profiles', () => {
	assert.throws(() => createRecipe({
		name: 'Too Many',
		requiredKeywords: Array(10).fill('Fire')
	}), /between one and nine/);
	assert.throws(() => reagent('too-few', 'Too Few', ['A', 'B', 'C']), /exactly four/);
	assert.doesNotThrow(() => createRecipe({ name: 'Short recipe', requiredKeywords: ['Fire'] }));
	assert.throws(() => createRecipe({ name: 'Incomplete', requiredKeywords: [] }), /between one and nine/);
	assert.doesNotThrow(() => createRecipe({
		name: 'Nine-keyword recipe',
		requiredKeywords: ['Fire', 'Fire', 'Fire', 'Water', 'Water', 'Air', 'Earth', 'Life', 'Force']
	}));
	assert.deepEqual(createRecipe({
		name: 'Blank trailing slots',
		requiredKeywords: ['Fire', 'Water', '', '  ']
	}).requiredKeywords, ['Fire', 'Water']);
	assert.doesNotThrow(() => createRecipe({
		name: 'Potion with ingredient profile',
		requiredKeywords: ['Fire', 'Air', 'Earth', 'Water'],
		outputKeywords: ['Arcane', 'Force', 'Light', 'Mind']
	}));
	assert.doesNotThrow(() => createRecipe({
		name: 'Intermediate with a short profile',
		outputType: 'intermediate',
		requiredKeywords: ['Earth'],
		outputKeywords: ['Arcane']
	}));
	assert.throws(() => createRecipe({
		name: 'Intermediate without a profile',
		outputType: 'intermediate',
		requiredKeywords: ['Earth']
	}), /at least one product keyword/);
	assert.throws(() => createRecipe({
		name: 'Over-profiled product',
		requiredKeywords: ['Earth'],
		outputKeywords: Array(5).fill('Earth')
	}), /up to four/);
});

test('crafted intermediate items may use one to four keywords while wild reagents still need four', () => {
	const oneKeywordCatalyst = createInventoryItem({
		id: 'one-keyword-catalyst',
		name: 'Arcane Catalyst',
		keywords: ['Arcane'],
		quantity: 1,
		isWild: false,
		isIntermediate: true,
		source: 'Craft'
	});
	assert.deepEqual(oneKeywordCatalyst.keywords, ['Arcane']);
	assert.throws(() => createInventoryItem({
		name: 'Empty Catalyst',
		keywords: [],
		quantity: 1,
		isWild: false,
		isIntermediate: true,
		source: 'Craft'
	}), /at least one keyword/);
	assert.throws(() => createInventoryItem({
		name: 'Wild Reagent',
		keywords: ['Fire', 'Water', 'Earth'],
		quantity: 1,
		isWild: true
	}), /exactly four/);
	assert.equal(analyzeCombination({
		inventory: [oneKeywordCatalyst],
		selections: [{ index: 0 }],
		playerLevel: 15
	}).keywordCounts.arcane, 1);
	assert.throws(() => createRecipe({
		name: 'Potion with oversized ingredient profile',
		requiredKeywords: ['Fire'],
		outputKeywords: ['One', 'Two', 'Three', 'Four', 'Five']
	}), /up to four/);
});

test('player state validates all six ability scores and all eighteen D&D skills', () => {
	const profile = getCharacterRollProfile(createPlayerState({
		level: 5,
		abilityScores: { strength: 16, intelligence: 8 },
		skills: {
			perception: { proficient: true },
			nature: { expertise: true }
		}
	}));
	assert.deepEqual(Object.keys(profile.abilityScores), [
		'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'
	]);
	assert.equal(Object.keys(profile.skills).length, 18);
	assert.equal(profile.proficiencyBonus, 3);
	assert.equal(profile.abilityModifiers.strength, 3);
	assert.equal(profile.skills.perception.modifier, 3);
	assert.equal(profile.skills.nature.proficient, true);
	assert.equal(profile.skills.nature.modifier, 5);
	assert.throws(() => createPlayerState({ abilityScores: { wisdom: 0 } }), /1 to 30/);
	assert.throws(() => createPlayerState({ skills: { perception: 'expertise' } }), /must be an object/);
});
