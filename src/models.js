export const RARITIES = Object.freeze(['Common', 'Uncommon', 'Rare', 'Very Rare', 'Legendary']);
export const INGREDIENT_CATEGORIES = Object.freeze(['flora', 'fauna', 'concoction']);
export const RECIPE_TIERS = Object.freeze(['Novice', 'Adept', 'Expert', 'Master']);
export const ABILITY_SCORES = Object.freeze([
	{ id: 'strength', label: 'Strength', abbreviation: 'STR' },
	{ id: 'dexterity', label: 'Dexterity', abbreviation: 'DEX' },
	{ id: 'constitution', label: 'Constitution', abbreviation: 'CON' },
	{ id: 'intelligence', label: 'Intelligence', abbreviation: 'INT' },
	{ id: 'wisdom', label: 'Wisdom', abbreviation: 'WIS' },
	{ id: 'charisma', label: 'Charisma', abbreviation: 'CHA' }
]);
export const SKILL_ABILITIES = Object.freeze({
	'acrobatics': 'dexterity',
	'animal handling': 'wisdom',
	'arcana': 'intelligence',
	'athletics': 'strength',
	'deception': 'charisma',
	'history': 'intelligence',
	'insight': 'wisdom',
	'intimidation': 'charisma',
	'investigation': 'intelligence',
	'medicine': 'wisdom',
	'nature': 'intelligence',
	'perception': 'wisdom',
	'performance': 'charisma',
	'persuasion': 'charisma',
	'religion': 'intelligence',
	'sleight of hand': 'dexterity',
	'stealth': 'dexterity',
	'survival': 'wisdom'
});

const rarityKey = value => String(value || 'Common').trim().toLowerCase();
const categoryKey = value => {
	const category = String(value || '').trim().toLowerCase();
	if (['fauna', 'biological', 'biological fauna', 'monster', 'monster part'].includes(category)) return 'fauna';
	if (['concoction', 'concoctions', 'alchemical concoction', 'alchemical concoctions', 'potion', 'crafted', 'craft'].includes(category)) return 'concoction';
	return 'flora';
};

export function createId(prefix = 'item') {
	const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${id}`;
}

export function normalizeKeywords(value) {
	const values = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/);
	return values.map(keyword => String(keyword).trim()).filter(Boolean);
}

export function getRecipeOutputKeywords(recipe = {}) {
	const profiles = [
		recipe.outputKeywords,
		recipe.OutputKeywords,
		recipe.Keywords
	].map(normalizeKeywords);
	return profiles.find(keywords => keywords.length) || profiles[0];
}

/**
 * @typedef {Object} Ingredient
 * @property {string} id
 * @property {string} name
 * @property {'Common'|'Uncommon'|'Rare'|'Very Rare'|'Legendary'} rarity
 * @property {string[]} keywords Ingredient keyword slots; catalog ingredients have four, crafted products may have one to four.
 * @property {'flora'|'fauna'|'concoction'} category
 * @property {boolean} isWild
 * @property {string} source
 */

/**
 * @typedef {Ingredient & {quantity:number, crafted:boolean, isIntermediate:boolean, recipeId:string, notes:string,
 * effectProfile:Object}} InventoryItem
 */

export function createIngredient(input = {}, {
	allowEmptyKeywords = false,
	allowCraftedKeywordProfile = false
} = {}) {
	const keywords = normalizeKeywords(input.keywords ?? input.Keywords);
	if (!String(input.name || input.Name || '').trim()) throw new TypeError('An ingredient must have a name.');
	if (allowCraftedKeywordProfile && (keywords.length < 1 || keywords.length > 4)) {
		throw new RangeError('A crafted ingredient must have one to four keywords.');
	}
	if (keywords.length !== 4 &&
		!(allowEmptyKeywords && keywords.length === 0) &&
		!allowCraftedKeywordProfile) {
		throw new RangeError('An ingredient must have exactly four keywords.');
	}
	return {
		id: String(input.id || input.ingredientId || input.reagentId || createId('ingredient')),
		name: String(input.name || input.Name || '').trim(),
		rarity: RARITIES.find(rarity => rarityKey(rarity) === rarityKey(input.rarity || input.Rarity)) || 'Common',
		keywords,
		category: categoryKey(input.category || input.Category || input.type || input.Type),
		isWild: input.isWild ?? input.wild ?? input.IsWild ?? String(input.source || input.Source || '').toLowerCase() !== 'craft',
		source: String(input.source || input.Source || (input.isWild === false ? 'Craft' : 'Forage')).trim(),
		description: String(input.description || input.Description || '').trim(),
		terrain: String(input.terrain || input.Terrain || '').trim(),
		rollMin: input.rollMin === undefined ? null : Number(input.rollMin),
		rollMax: input.rollMax === undefined ? null : Number(input.rollMax)
	};
}

export function createInventoryItem(input = {}) {
	const category = categoryKey(input.category || input.Category || input.type || input.Type);
	const source = String(input.source || input.Source || '').toLowerCase();
	const explicitIntermediate = input.isIntermediate === true ||
		['true', '1', 'yes'].includes(String(input.isIntermediate || '').toLowerCase());
	const isWild = input.isWild ?? input.wild ?? input.IsWild;
	const inferredIntermediate = (source === 'craft' || isWild === false) &&
		category !== 'concoction' &&
		String(input.type || input.Type || '').toLowerCase() !== 'potion';
	const isIntermediate = explicitIntermediate || inferredIntermediate;
	const crafted = Boolean(input.crafted) || category === 'concoction' ||
		source === 'craft' || isWild === false;
	const ingredientKeywords = normalizeKeywords(input.keywords ?? input.Keywords);
	if (crafted && isIntermediate && ingredientKeywords.length === 0) {
		throw new RangeError('An intermediate ingredient must have at least one keyword.');
	}
	const ingredient = createIngredient(input, {
		allowEmptyKeywords: crafted && !isIntermediate &&
			ingredientKeywords.length === 0,
		allowCraftedKeywordProfile: crafted && ingredientKeywords.length > 0
	});
	const quantity = Number(input.quantity ?? input.stock ?? input.Stock ?? 0);
	if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError('Inventory quantity must be a non-negative number.');
	const effectProfile = input.effectProfile ?? {};
	if (!effectProfile || typeof effectProfile !== 'object' || Array.isArray(effectProfile)) {
		throw new TypeError('An inventory effectProfile must be an object.');
	}
	return {
		...ingredient,
		id: String(input.id || createId('inventory')),
		quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
		crafted,
		isIntermediate,
		recipeId: String(input.recipeId || ''),
		notes: String(input.notes || input.Notes || '').trim(),
		effectProfile: { ...effectProfile }
	};
}

/**
 * @typedef {{id:string, location:string, terrain:string, chance:number, ingredient:Ingredient}} ForageEntry
 */
export function createForageEntry(input = {}) {
	const location = String(input.location || '').trim();
	const chance = Number(input.chance);
	if (!location) throw new TypeError('A forage entry must have a location.');
	if (!Number.isFinite(chance) || chance <= 0 || chance > 1) {
		throw new RangeError('A forage chance must be greater than 0 and no more than 1.');
	}
	const ingredientInput = input.ingredient ?? input.reagent;
	if (!ingredientInput || typeof ingredientInput !== 'object') {
		throw new TypeError('A forage entry must include an ingredient.');
	}
	const ingredient = createIngredient(ingredientInput);
	return {
		id: String(input.id || createId('forage')),
		location,
		terrain: String(input.terrain || '').trim(),
		chance,
		ingredient
	};
}

/**
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {string} name
 * @property {string} tier
 * @property {string[]} requiredKeywords A one-to-nine-keyword multiset.
 * @property {string[]} outputKeywords Optional one-to-four-keyword product profile.
 * @property {string} fullEffect
 * @property {Object} effectProfile Optional dice, range, duration, DC, and effect data.
 * @property {'unknown'|'partial'|'known'} discoveryState
 */

export function createRecipe(input = {}) {
	const name = String(input.name || input.Name || '').trim();
	if (!name) throw new TypeError('A recipe must have a name.');
	const requiredKeywords = normalizeKeywords(
		input.requiredKeywords ?? input.keywordPool ?? input.keywords ?? input.RequiredKeywords
	);
	if (requiredKeywords.length < 1 || requiredKeywords.length > 9) {
		throw new RangeError('A recipe must require between one and nine keywords.');
	}
	if (requiredKeywords.some(keyword => rarityKey(keyword) === 'any')) {
		throw new TypeError('Recipe requirements cannot use the deprecated Any wildcard.');
	}
	const outputType = String(input.outputType || input.outputtype || 'potion').trim().toLowerCase();
	if (!['potion', 'intermediate'].includes(outputType)) {
		throw new TypeError('Recipe outputType must be potion or intermediate.');
	}
	const outputKeywords = getRecipeOutputKeywords(input);
	if (outputKeywords.length > 4) {
		throw new RangeError('Recipes can define up to four product keywords.');
	}
	if (outputType === 'intermediate' && outputKeywords.length < 1) {
		throw new RangeError('Intermediate recipes must define at least one product keyword.');
	}
	const effectProfile = input.effectProfile ?? {};
	if (!effectProfile || typeof effectProfile !== 'object' || Array.isArray(effectProfile)) {
		throw new TypeError('A recipe effectProfile must be an object.');
	}
	const recipeInput = { ...input };
	for (const field of ['requiredComponents', 'RequiredComponents', 'reagentSymbols', 'base', 'specialRequirements', 'creatureParts']) {
		delete recipeInput[field];
	}
	return {
		...recipeInput,
		id: String(input.id || input.recipeId || createId('recipe')),
		name,
		tier: RECIPE_TIERS.find(tier => tier.toLowerCase() === String(input.tier || input.Tier || '').toLowerCase()) || '',
		rarity: String(input.rarity || input.Rarity || '').trim(),
		requiredKeywords,
		outputType,
		outputRarity: RARITIES.find(rarity => rarityKey(rarity) === rarityKey(input.outputRarity || input.OutputRarity)) || 'Common',
		outputKeywords,
		fullEffect: String(input.fullEffect || input.effect || input.FullEffect || '').trim(),
		effectProfile: { ...effectProfile },
		discoveryState: input.discoveryState || (requiredKeywords.length ? 'unknown' : 'known')
	};
}

/**
 * @typedef {Object} PlayerState
 * @property {number} level
 * @property {string[]} discoveredKeywords
 * @property {Record<string, {discoveredKeywords:string[], progress:number, discovered:boolean}>} recipeDiscoveries
 */
export function createPlayerState(input = {}) {
	const level = Number(input.level ?? input.playerLevel ?? 1);
	if (!Number.isInteger(level) || level < 1 || level > 20) {
		throw new RangeError('Player level must be an integer from 1 to 20.');
	}
	if (input.recipeDiscoveries !== undefined &&
		(!input.recipeDiscoveries || typeof input.recipeDiscoveries !== 'object' || Array.isArray(input.recipeDiscoveries))) {
		throw new TypeError('Player recipeDiscoveries must be an object.');
	}
	const inputAbilities = input.abilityScores ?? input.abilities ?? {};
	if (!inputAbilities || typeof inputAbilities !== 'object' || Array.isArray(inputAbilities)) {
		throw new TypeError('Player abilityScores must be an object.');
	}
	const abilityScores = Object.fromEntries(ABILITY_SCORES.map(({ id }) => {
		const score = Number(inputAbilities[id] ?? 10);
		if (!Number.isInteger(score) || score < 1 || score > 30) {
			throw new RangeError(`${id} must be an integer from 1 to 30.`);
		}
		return [id, score];
	}));
	const inputSkills = input.skills ?? {};
	if (!inputSkills || typeof inputSkills !== 'object' || Array.isArray(inputSkills)) {
		throw new TypeError('Player skills must be an object.');
	}
	const skills = Object.fromEntries(Object.keys(SKILL_ABILITIES).map(skill => {
		const value = inputSkills[skill] || {};
		if (typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError(`Player skill ${skill} must be an object.`);
		}
		const expertise = value.expertise === true;
		return [skill, {
			proficient: value.proficient === true || expertise,
			expertise
		}];
	}));
	const equipment = input.equipment ?? {};
	const toolProficiencies = input.toolProficiencies ?? {};
	if (!equipment || typeof equipment !== 'object' || Array.isArray(equipment) ||
		!toolProficiencies || typeof toolProficiencies !== 'object' || Array.isArray(toolProficiencies)) {
		throw new TypeError('Player equipment and toolProficiencies must be objects.');
	}
	return {
		level,
		abilityScores,
		skills,
		equipment: {
			herbalismKit: equipment.herbalismKit === true,
			alchemistSupplies: equipment.alchemistSupplies === true
		},
		toolProficiencies: {
			herbalismKit: toolProficiencies.herbalismKit === true,
			alchemistSupplies: toolProficiencies.alchemistSupplies === true
		},
		discoveredKeywords: normalizeKeywords(input.discoveredKeywords || input.knownKeywords),
		recipeDiscoveries: input.recipeDiscoveries && typeof input.recipeDiscoveries === 'object'
			? { ...input.recipeDiscoveries }
			: {},
		unknownRecipes: Array.isArray(input.unknownRecipes)
			? input.unknownRecipes.map(recipe => ({
				id: String(recipe.id || ''),
				signature: String(recipe.signature || ''),
				keywordSlots: normalizeKeywords(recipe.keywordSlots).slice(0, 4)
			}))
			: []
	};
}

export function getAbilityModifier(score) {
	const value = Number(score);
	if (!Number.isInteger(value) || value < 1 || value > 30) {
		throw new RangeError('Ability score must be an integer from 1 to 30.');
	}
	return Math.floor((value - 10) / 2);
}

export function getProficiencyBonus(level) {
	const value = Number(level);
	if (!Number.isInteger(value) || value < 1 || value > 20) {
		throw new RangeError('Player level must be an integer from 1 to 20.');
	}
	return Math.floor((value - 1) / 4) + 2;
}

export function getSkillModifier(player, skillName) {
	const skill = String(skillName || '').trim().toLowerCase();
	const ability = SKILL_ABILITIES[skill];
	if (!ability) throw new RangeError(`Unknown D&D skill: ${skillName}.`);
	const normalized = createPlayerState(player);
	const training = normalized.skills[skill];
	const proficiencyMultiplier = training.expertise ? 2 : training.proficient ? 1 : 0;
	return getAbilityModifier(normalized.abilityScores[ability]) +
		getProficiencyBonus(normalized.level) * proficiencyMultiplier;
}
