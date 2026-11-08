import { createRecipe, getRecipeOutputKeywords, normalizeKeywords } from './models.js';

const normalize = value => String(value || '').trim().toLocaleLowerCase();
const profile = recipe => normalizeKeywords(recipe.requiredKeywords).map(normalize).join('|');
const outputProfile = recipe => getRecipeOutputKeywords(recipe).map(normalize).join('|');

export function partitionRecipeCatalog(catalogRecipes) {
	if (!Array.isArray(catalogRecipes)) {
		throw new TypeError('The recipe catalog must be an array.');
	}
	const validRecipes = [];
	const skippedRecipes = [];
	for (const recipe of catalogRecipes) {
		const requiredKeywords = normalizeKeywords(recipe.requiredKeywords);
		let reason = '';
		if (!requiredKeywords.length) reason = 'No required keywords';
		else if (requiredKeywords.length > 9) reason = 'More than nine required keywords';
		else if (requiredKeywords.some(keyword => normalize(keyword) === 'any')) {
			reason = 'Deprecated Any wildcard';
		}
		if (reason) skippedRecipes.push({ id: recipe.id || '', name: recipe.name || recipe.Name || 'Unnamed recipe', reason });
		else validRecipes.push(recipe);
	}
	return { validRecipes, skippedRecipes };
}

export function synchronizeRecipeCatalog(savedRecipes, catalogRecipes) {
	const catalogById = new Map(catalogRecipes.filter(recipe => recipe.id).map(recipe => [recipe.id, recipe]));
	let changed = false;
	const synchronized = savedRecipes.map(saved => {
		const catalogRecipe = catalogById.get(saved.id);
		if (!catalogRecipe) return saved;
		if (saved.name === catalogRecipe.name &&
			profile(saved) === profile(catalogRecipe) &&
			outputProfile(saved) === outputProfile(catalogRecipe)) return saved;
		changed = true;
		return {
			...saved,
			name: catalogRecipe.name,
			requiredKeywords: [...catalogRecipe.requiredKeywords],
			outputKeywords: getRecipeOutputKeywords(catalogRecipe)
		};
	});

	for (const recipe of catalogRecipes) {
		if (synchronized.some(saved =>
			saved.id === recipe.id ||
			(normalize(saved.name) === normalize(recipe.name) && profile(saved) === profile(recipe))
		)) continue;
		synchronized.push(createRecipe(recipe));
		changed = true;
	}

	return changed ? synchronized : savedRecipes;
}

export function synchronizeCraftedInventory(inventory, recipes) {
	const recipesById = new Map(recipes.map(recipe => [recipe.id, recipe]));
	const recipesByName = new Map();
	for (const recipe of recipes) {
		const key = normalize(recipe.name);
		const matches = recipesByName.get(key) || [];
		matches.push(recipe);
		recipesByName.set(key, matches);
	}
	let changed = false;
	const synchronized = inventory.map(item => {
		const crafted = item.crafted ||
			normalize(item.category || item.Category) === 'concoction' ||
			normalize(item.source || item.Source) === 'craft' ||
			normalize(item.type || item.Type) === 'potion';
		if (!crafted || item.isIntermediate) return item;
		const namedRecipes = recipesByName.get(normalize(item.name || item.Name));
		const recipe = recipesById.get(item.recipeId) ||
			(namedRecipes?.length === 1 ? namedRecipes[0] : undefined);
		if (!recipe || normalizeKeywords(item.keywords).join('|') ===
			normalizeKeywords(recipe.outputKeywords).join('|')) return item;
		changed = true;
		return { ...item, keywords: [...recipe.outputKeywords] };
	});
	return changed ? synchronized : inventory;
}
