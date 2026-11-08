import { normalizeFaunaCatalog } from './catalog-adapters.js';

export const FORAGE_METHODS = Object.freeze({
	dedicated: { label: 'Dedicated search', dc: 12 },
	slow: { label: 'Slow pace', dc: 15 },
	normal: { label: 'Normal pace', dc: 18 },
	fast: { label: 'Fast pace', dc: 21 }
});

const HARVEST_SKILLS_BY_CREATURE_TYPE = Object.freeze({
	beast: 'nature',
	dragon: 'nature',
	monstrosity: 'nature',
	plant: 'nature',
	giant: 'survival',
	humanoid: 'survival',
	celestial: 'religion',
	fey: 'religion',
	fiend: 'religion',
	undead: 'religion',
	aberration: 'arcana',
	abberation: 'arcana',
	construct: 'arcana',
	elemental: 'arcana',
	ooze: 'arcana'
});

export function getHarvestSkillForCreatureType(creatureType) {
	const key = String(creatureType || '').trim().toLocaleLowerCase();
	const skill = HARVEST_SKILLS_BY_CREATURE_TYPE[key];
	if (!skill) throw new TypeError(`Unsupported creature type for harvesting: ${creatureType || '(missing)'}.`);
	return skill;
}

function rollDie(sides, random) {
	const value = random();
	if (!Number.isFinite(value) || value < 0 || value >= 1) {
		throw new RangeError('Random source must return a number from 0 (inclusive) to 1 (exclusive).');
	}
	return Math.floor(value * sides) + 1;
}

function validateTerrainTable(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new TypeError('A terrain table must contain at least one flora entry.');
	}
	const ranges = entries.map(entry => {
		const minimum = Number(entry.rollMin);
		const maximum = Number(entry.rollMax);
		if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum > 20 || minimum > maximum) {
			throw new RangeError('Flora table ranges must be integers within 1–20.');
		}
		if (!entry.name || !Array.isArray(entry.keywords) || entry.keywords.length !== 4) {
			throw new TypeError('Each flora table entry must have a name and exactly four keywords.');
		}
		return { minimum, maximum };
	}).sort((left, right) => left.minimum - right.minimum);
	if (ranges[0].minimum !== 1 || ranges[ranges.length - 1].maximum !== 20 ||
		ranges.some((range, index) => index > 0 && ranges[index - 1].maximum + 1 !== range.minimum)) {
		throw new RangeError('Flora table ranges must cover each d20 result from 1 to 20 exactly once.');
	}
}

export function rollFloraGathering({
	terrain,
	method = 'dedicated',
	modifier = 0,
	advantage = false,
	floraTables,
	random = Math.random
}) {
	const location = String(terrain || '').trim();
	const normalizedMethod = String(method || '').trim().toLowerCase();
	const search = FORAGE_METHODS[normalizedMethod];
	if (!location) return { success: false, message: 'Choose a terrain.' };
	if (!search) return { success: false, message: 'Choose a valid search method.' };
	if (!Number.isInteger(modifier)) return { success: false, message: 'The Nature modifier must be an integer.' };
	const table = (Array.isArray(floraTables) ? floraTables : []).find(item =>
		String(item.terrain || '').trim().toLocaleLowerCase() === location.toLocaleLowerCase()
	);
	if (!table) return { success: false, message: `No flora table is configured for ${location}.` };
	validateTerrainTable(table.entries);

	const firstRoll = rollDie(20, random);
	const secondRoll = advantage ? rollDie(20, random) : null;
	const dieRoll = secondRoll === null ? firstRoll : Math.max(firstRoll, secondRoll);
	const total = dieRoll + modifier;
	const success = total >= search.dc;
	const critical = success && total >= search.dc + 10;
	const quantityRoll = critical ? rollDie(4, random) : success ? 1 : 0;
	const finds = [];
	for (let index = 0; index < quantityRoll; index += 1) {
		const tableRoll = rollDie(20, random);
		const entry = table.entries.find(item => tableRoll >= item.rollMin && tableRoll <= item.rollMax);
		finds.push({ roll: tableRoll, flora: entry });
	}

	return {
		success,
		critical,
		terrain: table.terrain,
		method: normalizedMethod,
		dc: search.dc,
		check: {
			firstRoll,
			secondRoll,
			dieRoll,
			modifier,
			total
		},
		quantityRoll: critical ? quantityRoll : null,
		finds,
		message: success
			? `${critical ? 'Critical success' : 'Success'}: Nature check ${total} vs. DC ${search.dc}.`
			: `Failed: Nature check ${total} vs. DC ${search.dc}.`
	};
}

export function getCreatureHarvestDc(challengeRating) {
	const values = String(challengeRating || '')
		.match(/\d+(?:\/\d+)?/g)
		?.map(value => {
			const [numerator, denominator] = value.split('/').map(Number);
			return denominator ? numerator / denominator : numerator;
		}) || [];
	if (!values.length) throw new TypeError('A creature must have a numeric challenge rating.');
	const rating = Math.max(...values);
	if (rating < 5) return 12;
	if (rating <= 10) return 15;
	if (rating <= 15) return 18;
	return 21;
}

function rollQuantity(expression, random) {
	const value = String(expression || '').trim();
	const match = value.match(/^(\d*)d(\d+)$/i);
	if (match) {
		const count = Number(match[1] || 1);
		const sides = Number(match[2]);
		if (!Number.isSafeInteger(count) || count < 1 || count > 100 ||
			!Number.isSafeInteger(sides) || sides < 2 || sides > 1000) {
			throw new RangeError(`Invalid loot quantity dice: ${value}.`);
		}
		return Array.from({ length: count }, () => rollDie(sides, random)).reduce((sum, roll) => sum + roll, 0);
	}
	const quantity = Number(value);
	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		throw new TypeError(`Invalid loot quantity: ${value}.`);
	}
	return quantity;
}

export function rollFaunaHarvest({
	creature,
	modifier = 0,
	advantage = false,
	approach = 'standard',
	random = Math.random
}) {
	if (!creature || typeof creature !== 'object') {
		return { success: false, message: 'Choose a creature to harvest.' };
	}
	if (!Number.isInteger(modifier)) {
		return { success: false, message: 'The creature-harvesting skill modifier must be an integer.' };
	}
	if (!['standard', 'dedicated'].includes(approach)) {
		return { success: false, message: 'Choose a valid harvest approach.' };
	}
	const [normalizedCreature] = normalizeFaunaCatalog([creature]);
	if (!normalizedCreature.loot.length) {
		return { success: false, message: `${creature.name || 'This creature'} has no listed alchemical loot.` };
	}
	if (approach === 'dedicated' && !normalizedCreature.criticalHarvest) {
		return { success: false, message: `${creature.name || 'This creature'} has no dedicated harvest item.` };
	}
	const dc = getCreatureHarvestDc(creature.challengeRating);
	const firstRoll = rollDie(20, random);
	const secondRoll = advantage ? rollDie(20, random) : null;
	const dieRoll = secondRoll === null ? firstRoll : Math.max(firstRoll, secondRoll);
	const total = dieRoll + modifier;
	const successDc = dc + (approach === 'dedicated' ? 5 : 0);
	const success = total >= successDc;
	const critical = success && total >= dc + 10;
	const normalHarvest = Array.isArray(normalizedCreature.normalHarvest)
		? normalizedCreature.normalHarvest
		: normalizedCreature.normalHarvest ? [normalizedCreature.normalHarvest] : [];
	const criticalHarvest = normalizedCreature.criticalHarvest
		? [normalizedCreature.criticalHarvest]
		: [];
	const harvestedItems = success
		? approach === 'dedicated'
			? [...(critical ? normalHarvest : []), ...criticalHarvest]
			: [...normalHarvest, ...(critical ? criticalHarvest : [])]
		: [];
	const loot = harvestedItems.map(item => ({
		name: String(item.name || '').trim(),
		rarity: String(item.rarity || 'Common'),
		keywords: Array.isArray(item.keywords) ? [...item.keywords] : [],
		quantity: rollQuantity(item.quantity, random)
	}));
	if (loot.some(item => !item.name)) throw new TypeError('Creature loot entries must have names.');
	if (loot.some(item => item.keywords.length !== 4)) {
		throw new TypeError('Creature loot entries must have exactly four keywords.');
	}
	return {
		success,
		critical,
		dc,
		successDc,
		approach,
		check: { firstRoll, secondRoll, dieRoll, modifier, total },
		loot,
		message: success
			? `Harvest ${critical ? 'critical success' : 'succeeded'}: skill check ${total} vs. DC ${successDc}.`
			: `Harvest failed: skill check ${total} vs. DC ${successDc}.`
	};
}
