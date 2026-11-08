import test from 'node:test';
import assert from 'node:assert/strict';
import {
	partitionRecipeCatalog,
	synchronizeCraftedInventory,
	synchronizeRecipeCatalog
} from '../src/recipe-catalog.js';

test('recipe catalog diagnostics retain only entries with one to nine concrete requirements', () => {
	const result = partitionRecipeCatalog([
		{ id: 'one', name: 'One', requiredKeywords: ['Life', '', '  '] },
		{ id: 'zero', name: 'Zero', requiredKeywords: ['', ' '] },
		{ id: 'many', name: 'Many', requiredKeywords: Array(10).fill('Fire') },
		{ id: 'wild', name: 'Wild', requiredKeywords: ['Air', 'Any'] }
	]);

	assert.deepEqual(result.validRecipes.map(recipe => recipe.id), ['one']);
	assert.deepEqual(result.skippedRecipes.map(recipe => [recipe.id, recipe.reason]), [
		['zero', 'No required keywords'],
		['many', 'More than nine required keywords'],
		['wild', 'Deprecated Any wildcard']
	]);
});

test('catalog synchronization updates saved recipes when their keyword requirements change', () => {
	const saved = [
		{
			id: 'potion-healing-life',
			name: 'Potion of Healing',
			requiredKeywords: ['Life', 'Fire'],
			outputKeywords: [],
			fullEffect: 'Keep saved recipe details'
		},
		{ id: 'custom-recipe', name: 'Custom Recipe', requiredKeywords: ['Fire'] }
	];
	const catalog = [{
		id: 'potion-healing-life',
		name: 'Potion of Healing',
		requiredKeywords: ['Life'],
		outputKeywords: [],
		Keywords: ['Restore'],
		outputType: 'potion'
	}];

	const result = synchronizeRecipeCatalog(saved, catalog);

	assert.deepEqual(result[0].requiredKeywords, ['Life']);
	assert.deepEqual(result[0].outputKeywords, ['Restore']);
	assert.equal(result[0].fullEffect, 'Keep saved recipe details');
	assert.equal(result[1], saved[1]);
});

test('crafted inventory profiles synchronize by ID or unique recipe name', () => {
	const recipes = [{
		id: 'potion-healing-life',
		name: 'Potion of Healing',
		requiredKeywords: ['Life'],
		outputKeywords: ['Restore']
	}];
	const inventory = [
		{ name: 'Potion of Healing', recipeId: 'potion-healing-life', category: 'concoction', keywords: [] },
		{ name: 'Potion of Healing', source: 'Craft', keywords: [] }
	];
	const result = synchronizeCraftedInventory(inventory, recipes);

	assert.deepEqual(result.map(item => item.keywords), [['Restore'], ['Restore']]);
	assert.equal(synchronizeCraftedInventory(result, recipes), result);
});
