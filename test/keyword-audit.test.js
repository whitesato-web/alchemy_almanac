import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeywordAudit } from '../src/keyword-audit.js';

test('keyword audit counts distinct source entries and required recipe slots', () => {
	const rows = getKeywordAudit(
		[{ entries: [{ keywords: ['Fire', 'Fire', 'Life'] }] }],
		[{ loot: [{ keywords: ['fire', 'Nature'] }] }],
		[
			{ requiredKeywords: ['Fire', 'Fire', '', 'Life'] },
			{ outputType: 'intermediate', outputKeywords: ['Arcane', 'Life'], requiredKeywords: ['Nature', '', '', ''] }
		]
	);

	assert.deepEqual(rows, [
		{ keyword: 'Arcane', sources: 1, recipeUses: 0, delta: 1 },
		{ keyword: 'Fire', sources: 2, recipeUses: 2, delta: 0 },
		{ keyword: 'Life', sources: 2, recipeUses: 1, delta: 1 },
		{ keyword: 'Nature', sources: 1, recipeUses: 1, delta: 0 }
	]);
});

test('keyword audit handles empty or missing catalogs', () => {
	assert.deepEqual(getKeywordAudit([], [], []), []);
	assert.deepEqual(getKeywordAudit(null, undefined, [
		{ requiredKeywords: ['Shadow', '', '', ''] }
	]), [{ keyword: 'Shadow', sources: 0, recipeUses: 1, delta: 1 }]);
});
