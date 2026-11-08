import {
	ABILITY_SCORES,
	SKILL_ABILITIES,
	createInventoryItem,
	createPlayerState,
	getAbilityModifier,
	getProficiencyBonus,
	getSkillModifier,
	normalizeKeywords
} from './models.js';

export const KEYWORD_UNLOCK_LEVELS = Object.freeze([1, 5, 10, 15]);

export const WILD_UNAVAILABLE_KEYWORDS = Object.freeze(['arcane']);

const normalize = value => String(value || '').trim().toLocaleLowerCase();

export function getCharacterRollProfile(player) {
	const character = createPlayerState(player);
	return {
		level: character.level,
		proficiencyBonus: getProficiencyBonus(character.level),
		abilityScores: { ...character.abilityScores },
		equipment: { ...character.equipment },
		toolProficiencies: { ...character.toolProficiencies },
		abilityModifiers: Object.fromEntries(ABILITY_SCORES.map(({ id }) =>
			[id, getAbilityModifier(character.abilityScores[id])])
		),
		skills: Object.fromEntries(Object.entries(SKILL_ABILITIES).map(([skill, ability]) => [
			skill, {
				ability,
				proficient: character.skills[skill].proficient,
				expertise: character.skills[skill].expertise,
				modifier: getSkillModifier(character, skill)
			}
		]))
	};
}

export function getUnlockedKeywords(ingredient, playerLevel, unavailableWildKeywords = WILD_UNAVAILABLE_KEYWORDS) {
	const level = Number(playerLevel);
	if (!Number.isInteger(level) || level < 1 || level > 20) {
		throw new RangeError('Player level must be an integer from 1 to 20.');
	}
	const keywords = normalizeKeywords(ingredient.keywords ?? ingredient.Keywords);
	const unlockedCount = KEYWORD_UNLOCK_LEVELS.filter(unlockLevel => level >= unlockLevel).length;
	const unavailable = new Set(unavailableWildKeywords.map(normalize));
	const isWild = ingredient.isWild ?? ingredient.wild ?? ingredient.IsWild ?? normalize(ingredient.source || ingredient.Source) !== 'craft';
	return keywords.slice(0, unlockedCount).filter(keyword => !(
		isWild && unavailable.has(normalize(keyword))
	));
}

function getStock(item) {
	return Math.max(0, Number(item.quantity ?? item.stock ?? item.Stock) || 0);
}

function getItemIdentity(item, index) {
	return String(item.id || item.inventoryId || `${normalize(item.name || item.Name)}:${index}`);
}

export function analyzeCombination({ inventory, selections, playerLevel }) {
	if (!Array.isArray(inventory) || !Array.isArray(selections) || !selections.length) {
		return { success: false, message: 'Select at least one ingredient.', keywordCounts: {}, selected: [] };
	}
	const selectedByIndex = new Map();
	const keywordCounts = {};
	for (const selection of selections) {
		const quantity = Number(selection.quantity ?? selection.qty ?? 1);
		if (!Number.isSafeInteger(quantity) || quantity < 1) {
			return { success: false, message: 'Ingredient quantities must be positive whole numbers.', keywordCounts: {}, selected: [] };
		}
		const index = Number.isInteger(selection.index)
			? selection.index
			: inventory.findIndex((item, itemIndex) => getItemIdentity(item, itemIndex) === String(selection.id || selection.inventoryId));
		if (index < 0 || !inventory[index]) {
			return { success: false, message: 'A selected ingredient is no longer in the inventory.', keywordCounts: {}, selected: [] };
		}
		const item = inventory[index];
		const isCrafted = item.crafted ||
			item.isIntermediate ||
			normalize(item.category || item.Category) === 'concoction' ||
			normalize(item.source || item.Source) === 'craft' ||
			normalize(item.type || item.Type) === 'potion';
		const canUseCraftedProfile = isCrafted;
		if (!Array.isArray(item.keywords) ||
			(canUseCraftedProfile
				? item.keywords.length < 1 || item.keywords.length > 4
				: item.keywords.length !== 4)) {
			return {
				success: false,
				message: canUseCraftedProfile
					? `${item.name || item.Name} needs one to four product keywords to be used as an ingredient.`
					: `${item.name || item.Name} must have exactly four keywords.`,
				keywordCounts: {},
				selected: []
			};
		}
		const previousQuantity = selectedByIndex.get(index)?.quantity || 0;
		if (previousQuantity + quantity > getStock(item)) {
			return {
				success: false,
				message: `Not enough ${item.name || item.Name} (have ${getStock(item)}).`,
				keywordCounts: {},
				selected: []
			};
		}
		const totalQuantity = previousQuantity + quantity;
		const activeKeywords = getUnlockedKeywords(item, playerLevel);
		for (const keyword of activeKeywords) {
			const key = normalize(keyword);
			keywordCounts[key] = (keywordCounts[key] || 0) + (totalQuantity - previousQuantity);
		}
		selectedByIndex.set(index, {
			index,
			item,
			quantity: totalQuantity,
			activeKeywords
		});
	}
	const selected = [...selectedByIndex.values()];
	return { success: true, keywordCounts, selected };
}

export function matchRecipeKeywords(recipe, keywordCounts) {
	const requiredKeywords = normalizeKeywords(recipe.requiredKeywords || recipe.keywordPool);
	if (requiredKeywords.length < 1 || requiredKeywords.length > 9 ||
		requiredKeywords.some(keyword => normalize(keyword) === 'any')) {
		return { applicable: false, matched: false, progress: 0, required: 0, missing: [], matchedKeywords: [] };
	}
	const available = Object.fromEntries(Object.entries(keywordCounts)
		.map(([keyword, amount]) => [normalize(keyword), amount]));
	const matchedSlots = requiredKeywords.map(keyword => {
		const key = normalize(keyword);
		if ((available[key] || 0) < 1) return '???';
		available[key] -= 1;
		return keyword;
	});
	const missing = matchedSlots.flatMap((keyword, index) => keyword === '???'
		? [{ keyword: normalize(requiredKeywords[index]), required: 1, available: 0 }]
		: []);
	const matchedKeywords = matchedSlots.filter(keyword => keyword !== '???');
	const progress = matchedKeywords.length;
	return {
		applicable: true,
		matched: missing.length === 0,
		progress,
		required: requiredKeywords.length,
		missing,
		matchedKeywords,
		matchedSlots
	};
}

export function experimentWithIngredients({
	inventory,
	selections,
	recipes,
	knownRecipeIds = [],
	player,
	random = Math.random
}) {
	const analysis = analyzeCombination({ inventory, selections, playerLevel: player.level });
	if (!analysis.success) {
		return { success: false, valid: false, message: analysis.message, analysis };
	}
	const knownIds = new Set(knownRecipeIds);
	const discoveries = (Array.isArray(recipes) ? recipes : [])
		.filter(recipe => {
			const count = normalizeKeywords(recipe.requiredKeywords || recipe.keywordPool).length;
			return !knownIds.has(recipe.id) &&
				count >= 1 && count <= 9 &&
				!normalizeKeywords(recipe.requiredKeywords || recipe.keywordPool)
					.some(keyword => normalize(keyword) === 'any');
		})
		.map(recipe => {
			const match = matchRecipeKeywords(recipe, analysis.keywordCounts);
			return {
				recipeId: recipe.id,
				name: match.matched ? recipe.name : '[Unknown Mixture]',
				progress: match.progress,
				required: match.required,
				matched: match.matched,
				matchedKeywords: match.matchedKeywords,
				matchedSlots: match.matchedSlots,
				missing: match.missing
			};
		})
		.sort((left, right) => Number(right.matched) - Number(left.matched) || right.progress - left.progress);
	const applicable = discoveries.filter(discovery => discovery.matched);
	const nearMisses = discoveries.filter(discovery => !discovery.matched && discovery.progress > 0);
	const randomValue = Number(random());
	if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
		return { success: false, valid: false, message: 'Experiment random source must return a value from 0 up to, but not including, 1.', analysis };
	}
	const updatedInventory = inventory.map(item => ({ ...item }));
	if (applicable.length) {
		const selectedRecipe = applicable[Math.floor(randomValue * applicable.length)];
		for (const { index, quantity } of analysis.selected) {
			const item = updatedInventory[index];
			const stockKey = Object.hasOwn(item, 'quantity') ? 'quantity'
				: Object.hasOwn(item, 'stock') ? 'stock'
					: 'Stock';
			item[stockKey] = getStock(item) - quantity;
		}
		return {
			success: true,
			valid: true,
			message: 'Experiment succeeded. Ingredients were consumed.',
			inventory: updatedInventory,
			keywordCounts: analysis.keywordCounts,
			selectedRecipe: discoveries.find(discovery => discovery.recipeId === selectedRecipe.recipeId),
			discoveries,
			nearMissCount: nearMisses.length
		};
	}
	const selectedUnits = analysis.selected.flatMap(selected =>
		Array.from({ length: selected.quantity }, () => selected)
	);
	const consumed = selectedUnits[Math.floor(randomValue * selectedUnits.length)];
	const item = updatedInventory[consumed.index];
	const stockKey = Object.hasOwn(item, 'quantity') ? 'quantity'
		: Object.hasOwn(item, 'stock') ? 'stock'
			: 'Stock';
	item[stockKey] = getStock(item) - 1;
	return {
		success: false,
		valid: true,
		message: 'Experiment failed. One ingredient was consumed.',
		inventory: updatedInventory,
		keywordCounts: analysis.keywordCounts,
		discoveries,
		nearMissCount: nearMisses.length,
		closestNearMiss: nearMisses[0] || null,
		consumedIngredient: consumed.item.name || consumed.item.Name
	};
}

export function craftWithKeywords({ recipe, inventory, selections, player, quantity = 1 }) {
	const batchSize = Number(quantity);
	if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
		return { success: false, message: 'Batch size must be a positive whole number.', inventory };
	}
	const requiredCount = normalizeKeywords(recipe?.requiredKeywords || recipe?.keywordPool).length;
	if (!recipe || requiredCount < 1 || requiredCount > 9) {
		return { success: false, message: 'This recipe must require between one and nine keywords.', inventory };
	}
	const analysis = analyzeCombination({ inventory, selections, playerLevel: player.level });
	if (!analysis.success) return { success: false, message: analysis.message, inventory };
	const match = matchRecipeKeywords(recipe, analysis.keywordCounts);
	if (!match.applicable) return { success: false, message: 'This recipe must define between one and nine required keywords without Any wildcards.', inventory };
	if (!match.matched) {
		const missing = match.missing.map(item =>
			`${item.keyword}${item.required > 1 ? ` ×${item.required}` : ''}${item.available ? ` (have ${item.available})` : ''}`
		).join(', ');
		return { success: false, message: `Keyword pool not met: ${missing}.`, inventory, match };
	}
	const insufficient = analysis.selected.find(({ item, quantity: selectedQuantity }) =>
		selectedQuantity * batchSize > getStock(item)
	);
	if (insufficient) {
		return {
			success: false,
			message: `Not enough ${insufficient.item.name || insufficient.item.Name} for a batch of ${batchSize}.`,
			inventory,
			match
		};
	}
	const updatedInventory = inventory.map(item => ({ ...item }));
	for (const selected of analysis.selected) {
		const item = updatedInventory[selected.index];
		const stockKey = Object.hasOwn(item, 'quantity') ? 'quantity'
			: Object.hasOwn(item, 'stock') ? 'stock'
				: 'Stock';
		item[stockKey] = getStock(item) - selected.quantity * batchSize;
	}
	const magnitudes = Object.entries(analysis.keywordCounts)
		.map(([keyword, count]) => ({ keyword, count }));
	const effect = recipe.effectProfile && Object.keys(recipe.effectProfile).length
		? { ...recipe.effectProfile, keywordMagnitudes: magnitudes }
		: { description: recipe.fullEffect || recipe.effect || '', keywordMagnitudes: magnitudes };
	const craftedItem = updatedInventory.find(item =>
		(item.crafted || normalize(item.category || item.Category) === 'concoction' || normalize(item.type || item.Type) === 'potion') &&
		Boolean(item.isIntermediate) === (recipe.outputType === 'intermediate') &&
		(item.recipeId === recipe.id || normalize(item.name || item.Name) === normalize(recipe.name))
	);
	if (craftedItem) {
		const stockKey = Object.hasOwn(craftedItem, 'quantity') ? 'quantity'
			: Object.hasOwn(craftedItem, 'stock') ? 'stock'
				: 'Stock';
		craftedItem[stockKey] = getStock(craftedItem) + batchSize;
		if (recipe.outputKeywords.length && !craftedItem.keywords?.length) {
			craftedItem.keywords = [...recipe.outputKeywords];
		}
	} else {
		updatedInventory.push(createInventoryItem({
			name: recipe.name,
			rarity: recipe.outputRarity || recipe.rarity || recipe.tier || 'Common',
			keywords: recipe.outputKeywords,
			category: 'concoction',
			isWild: false,
			source: 'Craft',
			quantity: batchSize,
			crafted: true,
			isIntermediate: recipe.outputType === 'intermediate',
			recipeId: recipe.id,
			notes: recipe.fullEffect || recipe.effect || '',
			effectProfile: effect
		}));
	}
	return {
		success: true,
		message: `Crafted ${recipe.name} ×${batchSize}.`,
		inventory: updatedInventory,
		effect,
		match
	};
}

export function rollForage({ location, terrain = '', forageTable, random = Math.random }) {
	if (!String(location || '').trim()) {
		return { success: false, message: 'Choose a location to forage.' };
	}
	if (!Array.isArray(forageTable) || !forageTable.length) {
		return { success: false, message: 'No forage table is configured for this location.' };
	}
	const eligible = forageTable.filter(entry =>
		normalize(entry.location) === normalize(location) &&
		(!String(terrain || '').trim() || !String(entry.terrain || '').trim() || normalize(entry.terrain) === normalize(terrain))
	);
	if (!eligible.length) return { success: false, message: `No forage entries are configured for ${location}.` };
	if (eligible.some(entry => !Number.isFinite(Number(entry.chance)) || Number(entry.chance) < 0 || Number(entry.chance) > 1)) {
		return { success: false, message: `Forage chances for ${location} must each be between 0 and 1.` };
	}
	const totalWeight = eligible.reduce((sum, entry) => sum + Number(entry.chance), 0);
	if (totalWeight > 1) {
		return { success: false, message: `Forage chances for ${location} must total no more than 1.` };
	}
	const randomValue = Number(random());
	if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
		return { success: false, message: 'Forage random source must return a value from 0 to 1.' };
	}
	const roll = randomValue;
	if (roll >= totalWeight) return { success: false, found: false, message: 'No reagent found.' };
	let cumulative = 0;
	const selected = eligible.find(entry => {
		cumulative += Number(entry.chance);
		return roll < cumulative;
	}) || eligible[eligible.length - 1];
	return { success: true, reagent: selected.reagent, location, terrain };
}

export function rollTerrainForage({ terrain, reagents, random = Math.random }) {
	const selectedTerrain = String(terrain || '').trim();
	if (!selectedTerrain) return { success: false, message: 'Choose a terrain to forage.' };
	if (!Array.isArray(reagents)) {
		throw new TypeError('Forage reagents must be provided as an array.');
	}
	const candidates = reagents.filter(reagent =>
		String(reagent.name || '').trim() &&
		String(reagent.terrain || '').split(';')
			.some(value => normalize(value) === normalize(selectedTerrain))
	);
	if (!candidates.length) {
		return { success: false, message: `No reagents are listed for ${selectedTerrain}.` };
	}
	const randomValue = Number(random());
	if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
		return { success: false, message: 'Forage random source must return a value from 0 up to, but not including, 1.' };
	}
	const roll = Math.floor(randomValue * candidates.length) + 1;
	const selected = candidates[roll - 1];
	const quantity = Number(selected.harvestYield);
	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		throw new RangeError(`Harvest yield for ${selected.name} must be a positive whole number.`);
	}
	return {
		success: true,
		reagent: selected,
		terrain: selectedTerrain,
		roll,
		rollMaximum: candidates.length,
		quantity
	};
}
