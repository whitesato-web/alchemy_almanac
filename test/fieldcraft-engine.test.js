import test from 'node:test';
import assert from 'node:assert/strict';
import {
	getHarvestSkillForCreatureType,
	getCreatureHarvestDc,
	rollFaunaHarvest
} from '../src/fieldcraft-engine.js';

test('creature type selects the harvesting skill', () => {
	assert.equal(getHarvestSkillForCreatureType('Beast'), 'nature');
	assert.equal(getHarvestSkillForCreatureType('Humanoid'), 'survival');
	assert.equal(getHarvestSkillForCreatureType('Undead'), 'religion');
	assert.equal(getHarvestSkillForCreatureType('Aberration'), 'arcana');
	assert.throws(() => getHarvestSkillForCreatureType('Unknown'), /Unsupported creature type/);
});

test('creature harvesting DC follows the carcass CR bands', () => {
	assert.equal(getCreatureHarvestDc('1/2'), 12);
	assert.equal(getCreatureHarvestDc('5'), 15);
	assert.equal(getCreatureHarvestDc('10'), 15);
	assert.equal(getCreatureHarvestDc('11'), 18);
	assert.equal(getCreatureHarvestDc('15'), 18);
	assert.equal(getCreatureHarvestDc('16'), 21);
});

test('ordinary creature-harvest success yields the normal harvest', () => {
	const rolls = [0.55, 0.5];
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Beast',
			challengeRating: '1/2',
			normalHarvest: {
				itemName: 'Beast tooth',
				quantity: '1d4',
				keywords: ['Life', 'Beast', 'Force', 'Nature']
			},
			criticalHarvest: {
				itemName: 'Beast hide',
				quantity: '2',
				keywords: ['Life', 'Beast', 'Protection', 'Nature']
			}
		},
		modifier: 0,
		random: () => rolls.shift()
	});

	assert.equal(result.success, true);
	assert.equal(result.critical, false);
	assert.equal(result.dc, 12);
	assert.deepEqual(result.loot, [
		{ name: 'Beast tooth', rarity: 'Common', keywords: ['Life', 'Beast', 'Force', 'Nature'], quantity: 3 }
	]);
});

test('critical creature-harvest success yields both normal and critical harvests at DC plus ten', () => {
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Beast',
			challengeRating: '1/2',
			normalHarvest: {
				itemName: 'Beast tooth',
				quantity: 2,
				keywords: ['Life', 'Beast', 'Force', 'Nature']
			},
			criticalHarvest: {
				itemName: 'Beast hide',
				quantity: 1,
				keywords: ['Life', 'Beast', 'Protection', 'Nature']
			}
		},
		modifier: 2,
		random: () => 0.95
	});

	assert.equal(result.success, true);
	assert.equal(result.critical, true);
	assert.equal(result.check.total, result.dc + 10);
	assert.deepEqual(result.loot.map(item => [item.name, item.quantity]), [
		['Beast tooth', 2],
		['Beast hide', 1]
	]);
});

test('dedicated extraction uses base DC plus five and yields only the critical harvest on success', () => {
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Beast',
			challengeRating: '1/2',
			normalHarvest: {
				itemName: 'Beast tooth',
				quantity: 2,
				keywords: ['Life', 'Beast', 'Force', 'Nature']
			},
			criticalHarvest: {
				itemName: 'Beast hide',
				quantity: 1,
				keywords: ['Life', 'Beast', 'Protection', 'Nature']
			}
		},
		approach: 'dedicated',
		random: () => 0.8
	});

	assert.equal(result.success, true);
	assert.equal(result.critical, false);
	assert.equal(result.dc, 12);
	assert.equal(result.successDc, 17);
	assert.deepEqual(result.loot.map(item => [item.name, item.quantity]), [['Beast hide', 1]]);
});

test('dedicated extraction critical success yields both harvest items at base DC plus ten', () => {
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Beast',
			challengeRating: '1/2',
			normalHarvest: {
				itemName: 'Beast tooth',
				quantity: 2,
				keywords: ['Life', 'Beast', 'Force', 'Nature']
			},
			criticalHarvest: {
				itemName: 'Beast hide',
				quantity: 1,
				keywords: ['Life', 'Beast', 'Protection', 'Nature']
			}
		},
		approach: 'dedicated',
		modifier: 2,
		random: () => 0.95
	});

	assert.equal(result.success, true);
	assert.equal(result.critical, true);
	assert.equal(result.check.total, result.dc + 10);
	assert.deepEqual(result.loot.map(item => [item.name, item.quantity]), [
		['Beast tooth', 2],
		['Beast hide', 1]
	]);
});

test('dedicated extraction fails below base DC plus five and yields no items', () => {
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Beast',
			challengeRating: '1/2',
			normalHarvest: {
				itemName: 'Beast tooth',
				quantity: 2,
				keywords: ['Life', 'Beast', 'Force', 'Nature']
			},
			criticalHarvest: {
				itemName: 'Beast hide',
				quantity: 1,
				keywords: ['Life', 'Beast', 'Protection', 'Nature']
			}
		},
		approach: 'dedicated',
		modifier: -4,
		random: () => 0.95
	});

	assert.equal(result.success, false);
	assert.equal(result.critical, false);
	assert.deepEqual(result.loot, []);
});

test('dedicated extraction is unavailable when no critical harvest item is listed', () => {
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Beast',
			challengeRating: '1/2',
			normalHarvest: {
				itemName: 'Beast tooth',
				quantity: 2,
				keywords: ['Life', 'Beast', 'Force', 'Nature']
			}
		},
		approach: 'dedicated',
		random: () => 0
	});

	assert.equal(result.success, false);
	assert.match(result.message, /no dedicated harvest item/);
});

test('creature harvesting accepts legacy parts and the catalog-level harvest yield', () => {
	const result = rollFaunaHarvest({
		creature: {
			name: 'Test Basilisk',
			challengeRating: '3',
			harvestYield: 2,
			habitat: ['Underground'],
			parts: [{
				name: 'Basilisk Stomach',
				rarity: 'Uncommon',
				keywords: ['Earth', 'Transformation', 'Poison', 'Life']
			}]
		},
		modifier: 21,
		random: () => 0
	});

	assert.equal(result.success, true);
	assert.equal(result.critical, true);
	assert.deepEqual(result.loot, [{
		name: 'Basilisk Stomach',
		rarity: 'Uncommon',
		keywords: ['Earth', 'Transformation', 'Poison', 'Life'],
		quantity: 2
	}]);
});

test('failed creature harvest returns no ingredients', () => {
	const result = rollFaunaHarvest({
		creature: { name: 'Test Beast', challengeRating: '16', loot: [{
			name: 'Beast tooth', quantity: '1', keywords: ['Life', 'Beast', 'Force', 'Nature']
		}] },
		modifier: 0,
		random: () => 0
	});

	assert.equal(result.success, false);
	assert.deepEqual(result.loot, []);
});
