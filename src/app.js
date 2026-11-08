import {
	ABILITY_SCORES,
	SKILL_ABILITIES,
	createForageEntry,
	createInventoryItem,
	createPlayerState,
	createRecipe,
	getRecipeOutputKeywords,
	getSkillModifier,
	normalizeKeywords
} from './models.js';
import {
	craftWithKeywords,
	experimentWithIngredients,
	getCharacterRollProfile,
	getUnlockedKeywords
} from './keyword-engine.js';
import {
	getHarvestSkillForCreatureType,
	rollFaunaHarvest,
	rollFloraGathering
} from './fieldcraft-engine.js';
import { getKeywordAudit } from './keyword-audit.js';
import { partitionRecipeCatalog, synchronizeCraftedInventory, synchronizeRecipeCatalog } from './recipe-catalog.js';
import { normalizeFaunaCatalog } from './catalog-adapters.js';

const STORAGE_KEY = 'alchemists-almanac:data:v3';
const LEGACY_STORAGE_KEYS = ['alchemists-almanac:data:v2', 'alchemists-almanac:data:v1'];
let state;
let installPrompt;
let floraTables = [];
let faunaCatalog = [];
let ingredientCatalog = [];
let keywordAuditSort = { key: 'keyword', direction: 'asc' };
let skippedCatalogRecipes = [];
let validCatalogRecipeCount = 0;

function completeLegacyKeywords(values, defaults, count = 4) {
	const keywords = normalizeKeywords(values).slice(0, count);
	for (const keyword of defaults) {
		if (keywords.length === count) break;
		if (!keywords.some(existing => normalizeName(existing) === normalizeName(keyword))) keywords.push(keyword);
	}
	return keywords;
}

function normalizeSavedRecipe(recipe) {
	const requiredKeywords = normalizeKeywords(
		recipe.requiredKeywords ?? recipe.keywordPool ?? recipe.keywords
	).filter(keyword => normalizeName(keyword) !== 'any');
	return requiredKeywords.length
		? createRecipe({ ...recipe, requiredKeywords })
		: null;
}

function migrateLegacyState(parsed) {
	const legacyIngredientKeywords = ['Life', 'Nature', 'Water', 'Earth', 'Air', 'Fire', 'Shadow'];
	return {
		recipes: parsed.recipes.map(recipe => {
			const outputType = recipe.outputType || recipe.outputtype || 'potion';
			return normalizeSavedRecipe({
				...recipe,
				outputType,
				outputKeywords: normalizeKeywords(recipe.outputKeywords).length
					? recipe.outputKeywords
					: outputType === 'intermediate'
						? completeLegacyKeywords([], ['Arcane', 'Force', 'Light', 'Mind'])
						: []
			});
		}).filter(Boolean),
		inventory: parsed.inventory.map(item => {
			const keywords = normalizeKeywords(item.keywords || item.Keywords);
			const isCrafted = isCraftedItem(item) || item.isWild === false ||
				normalizeName(item.source || item.Source) === 'craft';
			const isIntermediate = item.isIntermediate ||
				(item.isWild === false && normalizeName(item.category || item.Category) !== 'concoction' &&
					normalizeName(item.type || item.Type) !== 'potion');
			return createInventoryItem({
				...item,
				keywords: keywords.length
					? keywords
					: isCrafted && !isIntermediate
						? []
						: completeLegacyKeywords([], isCrafted
							? [...legacyIngredientKeywords, 'Arcane']
							: legacyIngredientKeywords),
				quantity: item.quantity ?? item.stock ?? item.Stock
			});
		}),
		forageTable: Array.isArray(parsed.forageTable) ? parsed.forageTable.map(entry =>
			createForageEntry({
				...entry,
				ingredient: {
					...(entry.ingredient || entry.reagent),
					keywords: completeLegacyKeywords(
						(entry.ingredient || entry.reagent)?.keywords,
						legacyIngredientKeywords
					)
				}
			})
		) : [],
		player: createPlayerState(parsed.player || parsed.playerState)
	};
}

function isCraftedItem(item) {
	if (item.crafted || item.isIntermediate || item.isWild === false || item.IsWild === false ||
		normalizeName(item.category || item.Category) === 'concoction') return true;
	const type = normalizeName(item.type || item.Type);
	const source = normalizeName(item.source || item.Source);
	const notes = normalizeName(item.notes || item.Notes);
	return source === 'craft' || type === 'potion' || type === 'crafted craft' || notes.startsWith('crafted ');
}

function canBeIngredient(item) {
	return !isCraftedItem(item) || item.isIntermediate || (Array.isArray(item.keywords) && item.keywords.length > 0);
}

function readState() {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (!saved) {
		const legacySaved = LEGACY_STORAGE_KEYS.map(key => localStorage.getItem(key)).find(Boolean);
		const legacyData = legacySaved ? JSON.parse(legacySaved) : null;
		if (legacyData && Array.isArray(legacyData.recipes) && Array.isArray(legacyData.inventory)) {
			const migrated = migrateLegacyState(legacyData);
			localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
			for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
			return migrated;
		}
		const legacyPlayer = legacyData && typeof legacyData === 'object' ? legacyData.player : null;
		return {
			recipes: [],
			inventory: [],
			forageTable: [],
			player: createPlayerState({
				...(legacyPlayer || {}),
				discoveredKeywords: [],
				recipeDiscoveries: {}
			})
		};
	}
	const parsed = JSON.parse(saved);
	if (!parsed || !Array.isArray(parsed.recipes) || !Array.isArray(parsed.inventory)) {
		throw new Error('Saved almanac data is not in the expected format. Export or clear the saved data before continuing.');
	}
	const normalizedRecipes = parsed.recipes.map(normalizeSavedRecipe).filter(Boolean);
	const normalized = {
		...parsed,
		recipes: normalizedRecipes,
		inventory: parsed.inventory.map(item => createInventoryItem({
			...item,
			id: item.id || item.inventoryId,
			quantity: item.quantity ?? item.stock ?? item.Stock
		})),
		forageTable: Array.isArray(parsed.forageTable) ? parsed.forageTable.map(entry => createForageEntry(entry)) : [],
		player: createPlayerState(parsed.player || parsed.playerState)
	};
	if (!parsed.player ||
		normalizedRecipes.length !== parsed.recipes.length ||
		parsed.recipes.some(recipe =>
			normalizeKeywords(recipe.requiredKeywords ?? recipe.keywordPool ?? recipe.keywords)
				.some(keyword => normalizeName(keyword) === 'any')) ||
		parsed.recipes.some(recipe => !recipe.id) ||
		parsed.inventory.some(item => !item.id || item.quantity === undefined) ||
		!Array.isArray(parsed.forageTable)) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
	}
	return normalized;
}

function updateState(updater) {
	const nextState = {
		recipes: state.recipes.map(recipe => ({ ...recipe })),
		inventory: state.inventory.map(item => ({ ...item })),
		forageTable: state.forageTable.map(entry => ({ ...entry, ingredient: { ...entry.ingredient } })),
		player: createPlayerState(state.player)
	};
	updater(nextState);
	localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
	state = nextState;
	render();
}

function showNotice(message, isError = false) {
	const notice = document.getElementById('app-notice');
	notice.textContent = message;
	notice.classList.toggle('notice-error', isError);
	notice.hidden = !message;
}

function setResult(message, isSuccess) {
	const result = document.getElementById('craft-result');
	result.textContent = message;
	result.className = `result ${isSuccess ? 'result-success' : 'result-error'}`;
	result.hidden = false;
}

function createElement(tag, className, text) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function startButtonCooldown(buttons, duration = 5000, onComplete = () => {}) {
	const cooldownButtons = buttons.filter(Boolean);
	const labels = cooldownButtons.map(button => button.textContent);
	const endsAt = Date.now() + duration;
	for (const button of cooldownButtons) {
		button.dataset.cooldown = 'true';
		button.disabled = true;
	}
	const updateLabels = () => {
		const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
		cooldownButtons.forEach((button, index) => {
			button.textContent = seconds ? `Wait ${seconds}s` : labels[index];
		});
	};
	updateLabels();
	const interval = window.setInterval(updateLabels, 250);
	window.setTimeout(() => {
		window.clearInterval(interval);
		cooldownButtons.forEach((button, index) => {
			delete button.dataset.cooldown;
			button.disabled = false;
			button.textContent = labels[index];
		});
		onComplete();
	}, duration);
}

function renderKeywordTags(container, keywords, { collapseUnknown = false, coveredSlots = [] } = {}) {
	const values = normalizeKeywords(keywords);
	const visible = collapseUnknown && values.includes('???')
		? [...values.filter(keyword => keyword !== '???'), '???']
		: values;
	for (const [index, keyword] of visible.entries()) {
		const isCovered = coveredSlots[index] === true;
		container.append(createElement(
			'span',
			`keyword-tag${keyword === '???' ? ' keyword-tag-unknown' : ''}${isCovered ? ' keyword-tag-covered' : ''}`,
			keyword
		));
	}
}

function getDiscoverySlots(recipe, discovery) {
	let slots = discovery?.keywordSlots;
	if (!Array.isArray(slots) || !slots.length) {
		const knownKeywords = new Set((discovery?.discoveredKeywords || []).map(normalizeName));
		slots = recipe.requiredKeywords.map(keyword => {
			const key = normalizeName(keyword);
			if (!knownKeywords.has(key)) return '???';
			knownKeywords.delete(key);
			return keyword;
		});
	}
	return slots;
}

function discoveryKeywordSlots(recipe, discovery) {
	const slots = getDiscoverySlots(recipe, discovery);
	return [...slots.filter(keyword => keyword && keyword !== '???'), ...(slots.includes('???') ? ['???'] : [])];
}

function normalizeName(value) {
	return String(value || '').trim().toLocaleLowerCase();
}

function formatEffectProfile(profile = {}) {
	const labels = {
		dice: 'Dice',
		damageType: 'Damage type',
		range: 'Range',
		duration: 'Duration',
		save: 'Save',
		dc: 'DC',
		description: 'Effect'
	};
	return Object.entries(profile)
		.filter(([key, value]) => key !== 'keywordMagnitudes' && value !== '' && value !== null && value !== undefined)
		.map(([key, value]) => `${labels[key] || key}: ${value}`)
		.join(' · ');
}

function effectProfileFromFields(fields) {
	const profile = fields.effectprofile ? JSON.parse(fields.effectprofile) : {};
	if (!profile || Array.isArray(profile) || typeof profile !== 'object') {
		throw new Error('EffectProfile must be a JSON object.');
	}
	const mappings = [
		['dice', 'dice'],
		['damagetype', 'damageType'],
		['range', 'range'],
		['duration', 'duration'],
		['save', 'save']
	];
	for (const [source, target] of mappings) {
		if (fields[source]) profile[target] = fields[source].trim();
	}
	if (fields.dc) {
		const dc = Number(fields.dc);
		if (!Number.isInteger(dc) || dc < 1 || dc > 40) throw new Error('Save DC must be an integer from 1 to 40.');
		profile.dc = dc;
	}
	return profile;
}

function renderRecipeList() {
	const list = document.getElementById('recipe-list');
	list.replaceChildren();
	const playerRecipes = state.recipes
		.filter(recipe => state.player.recipeDiscoveries[recipe.id]?.discovered === true)
		.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
	const recipeCount = playerRecipes.length;
	document.getElementById('recipe-count').textContent = `${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'}`;
	for (const recipe of playerRecipes) {
		const card = createElement('article', 'item-card');
		const details = createElement('div', 'item-details');
		details.append(createElement('h3', '', recipe.name));
		if (recipe.fullEffect) details.append(createElement('p', 'item-note', recipe.fullEffect));
		else {
			const profile = formatEffectProfile(recipe.effectProfile);
			if (profile) details.append(createElement('p', 'item-note', profile));
		}
		card.append(details);
		list.append(card);
	}
	if (!recipeCount) list.append(createElement('p', 'empty-state', 'No discovered recipes yet.'));
}

function renderInventoryList() {
	const quantityOf = item => Math.max(0, Number(item.stock ?? item.quantity ?? item.Stock) || 0);
	const totalStock = state.inventory
		.filter(item => !isCraftedItem(item))
		.reduce((total, item) => total + quantityOf(item), 0);
	document.getElementById('inventory-count').textContent = `${state.inventory.length} ${state.inventory.length === 1 ? 'item' : 'items'}`;
	document.getElementById('ingredient-count').textContent = `${totalStock} in stock`;
	const groups = [
		{ id: 'flora', label: 'Botanical Flora' },
		{ id: 'fauna', label: 'Biological Fauna' },
		{ id: 'components', label: 'Alchemical Components' },
		{ id: 'potions', label: 'Potions' },
		{ id: 'throwables', label: 'Bombs / Throwables' },
		{ id: 'flasks', label: 'Flasks' },
		{ id: 'other', label: 'Other Concoctions' }
	];
	const buckets = new Map(groups.map(group => [group.id, []]));
	for (const item of state.inventory) {
		const groupId = getInventoryGroup(item);
		buckets.get(groupId).push(item);
	}
	const container = document.getElementById('inventory-groups');
	container.replaceChildren();
	for (const group of groups) {
		const items = buckets.get(group.id);
		if (!items.length) continue;
		const section = document.createElement('details');
		section.className = 'inventory-category';
		section.open = true;
		const heading = document.createElement('summary');
		heading.append(createElement('h3', '', group.label));
		heading.append(createElement('span', 'count-pill', `${items.length} · ${items.reduce((total, item) => total + quantityOf(item), 0)}`));
		section.append(heading);
		const list = createElement('div', 'inventory-item-list');
		for (const item of items) {
			const entry = document.createElement('details');
			entry.className = 'inventory-entry';
			const summary = document.createElement('summary');
			const title = createElement('span', 'inventory-entry-title');
			title.append(createElement('span', 'inventory-entry-name', String(item.name || item.Name || '')));
			if (item.rarity) title.append(createElement('span', 'rarity', item.rarity));
			if (item.isIntermediate) title.append(createElement('span', 'rarity', 'Intermediate'));
			const tags = createElement('span', 'inventory-entry-tags');
			const keywords = item.keywords?.length ? getUnlockedKeywords(item, state.player.level) : [];
			if (keywords.length) {
				renderKeywordTags(tags, keywords);
			}
			if (item.keywords?.length) {
				const activeKeywords = getUnlockedKeywords(item, state.player.level);
				if (activeKeywords.length < item.keywords.length) {
					tags.append(createElement('span', 'keyword-tag keyword-tag-hidden', 'Hidden'));
				}
			}
			title.append(tags);
			summary.append(title, createElement('span', 'item-quantity', `× ${quantityOf(item)}`));
			entry.append(summary);
			const expanded = createElement('div', 'inventory-entry-details');
			const metadata = [item.type || item.Type].filter(Boolean).join(' · ');
			if (metadata) expanded.append(createElement('p', 'item-note', metadata));
			if (item.description) expanded.append(createElement('p', 'item-note', item.description));
			if (item.notes || item.Notes) expanded.append(createElement('p', 'item-note', item.notes || item.Notes));
			const effectDescription = formatEffectProfile(item.effectProfile || {});
			if (effectDescription) expanded.append(createElement('p', 'item-note', effectDescription));
			const remove = createElement('button', 'button button-small button-outline', 'Remove');
			remove.type = 'button';
			remove.dataset.removeInventory = item.id;
			remove.setAttribute('aria-label', `Remove ${item.name || item.Name} from inventory`);
			expanded.append(remove);
			entry.append(expanded);
			list.append(entry);
		}
		section.append(list);
		container.append(section);
	}
	if (!state.inventory.length) container.append(createElement('p', 'empty-state', 'No items in inventory.'));
}

function getInventoryGroup(item) {
	if (!isCraftedItem(item)) {
		return normalizeName(item.category || item.Category) === 'fauna' ? 'fauna' : 'flora';
	}
	if (item.isIntermediate) return 'components';
	const recipe = state.recipes.find(candidate => candidate.id === item.recipeId);
	const type = normalizeName(item.itemType || item.type || item.Type || recipe?.type || recipe?.tableName);
	const name = normalizeName(item.name || item.Name);
	if (/\b(bomb|throw|grenade|pellet|alchemist'?s fire|tanglefoot)\b/.test(`${type} ${name}`)) return 'throwables';
	if (/\bflasks?\b/.test(`${type} ${name}`)) return 'flasks';
	if (type.includes('flask')) return 'flasks';
	return 'potions';
}

function renderCraftForm() {
	const select = document.getElementById('craft-recipe');
	const selectedRecipeId = select.value;
	select.replaceChildren();
	const placeholder = createElement('option', '', 'Choose a recipe');
	placeholder.value = '';
	select.append(placeholder);
	for (const recipe of state.recipes.filter(item =>
		state.player.recipeDiscoveries[item.id]?.discovered === true
	)) {
		const option = createElement('option', '', recipe.name);
		option.value = recipe.id;
		select.append(option);
	}
	const knownRecipes = state.recipes.filter(recipe =>
		state.player.recipeDiscoveries[recipe.id]?.discovered === true
	);
	select.value = knownRecipes.some(recipe => recipe.id === selectedRecipeId) ? selectedRecipeId : '';
	const preview = document.getElementById('recipe-preview');
	preview.replaceChildren();
	const recipe = state.recipes.find(item => item.id === select.value);
	if (recipe) {
		preview.append(createElement('strong', '', `${recipe.requiredKeywords.length} required ${recipe.requiredKeywords.length === 1 ? 'keyword' : 'keywords'}`));
		const tags = createElement('div', 'keyword-list');
		const coverage = getCraftKeywordCoverage(recipe);
		renderKeywordTags(tags, coverage.map(slot => slot.keyword), {
			coveredSlots: coverage.map(slot => slot.covered)
		});
		preview.append(tags);
		preview.append(createElement('p', 'item-note', `Tier: ${recipe.tier || 'Unspecified'}`));
		const metadata = [
			recipe.tableName,
			recipe.tool && `Tool: ${recipe.tool}`
		].filter(Boolean).join(' · ');
		if (metadata) preview.append(createElement('p', 'item-note', metadata));
		if (recipe.fullEffect) preview.append(createElement('p', 'item-note', recipe.fullEffect));
		const profile = formatEffectProfile(recipe.effectProfile);
		if (profile) preview.append(createElement('p', 'item-note', profile));
	}
}

function render() {
	renderRecipeList();
	renderInventoryList();
	renderCraftForm();
	renderIngredientChoices('craft-ingredients');
	renderExperimentIngredientSelectors();
	renderPlayer();
	renderKeywordAudit();
}

function renderKeywordAudit() {
	const container = document.getElementById('keyword-audit');
	container.replaceChildren();
	const diagnostics = document.getElementById('catalog-diagnostics');
	diagnostics.replaceChildren();
	if (!floraTables.length || !faunaCatalog.length) {
		diagnostics.append(createElement('p', 'empty-state', 'Catalog checks will appear when the data loads.'));
	} else if (!skippedCatalogRecipes.length) {
		diagnostics.append(createElement('p', 'result result-success', 'Recipe catalog checks passed. All recipes have one to nine required keywords and no wildcard slots.'));
	} else {
		diagnostics.append(createElement('p', 'result result-error',
			`${skippedCatalogRecipes.length} recipe ${skippedCatalogRecipes.length === 1 ? 'entry' : 'entries'} with invalid requirements were skipped. ${validCatalogRecipeCount} recipes are available.`
		));
		const details = document.createElement('details');
		details.className = 'catalog-diagnostic-details';
		const summary = document.createElement('summary');
		summary.textContent = 'Skipped recipe entries';
		details.append(summary);
		const list = document.createElement('ul');
		for (const recipe of skippedCatalogRecipes) {
			const item = document.createElement('li');
			item.textContent = `${recipe.name}${recipe.id ? ` (${recipe.id})` : ''}: ${recipe.reason}`;
			list.append(item);
		}
		details.append(list);
		diagnostics.append(details);
	}
	if (!floraTables.length || !faunaCatalog.length) {
		container.append(createElement('p', 'empty-state', 'Keyword data will appear when the catalogs finish loading.'));
		return;
	}

	const rows = getKeywordAudit(floraTables, faunaCatalog, state.recipes);
	if (!rows.length) {
		container.append(createElement('p', 'empty-state', 'No keywords found.'));
		return;
	}
	const table = createElement('table', 'keyword-audit-table');
	const head = document.createElement('thead');
	const headerRow = document.createElement('tr');
	for (const [key, label] of [
		['keyword', 'Keyword'],
		['sources', 'Sources'],
		['recipeUses', 'Recipe uses'],
		['delta', 'Delta']
	]) {
		const heading = document.createElement('th');
		heading.scope = 'col';
		heading.setAttribute('aria-sort', keywordAuditSort.key === key
			? keywordAuditSort.direction === 'asc' ? 'ascending' : 'descending'
			: 'none');
		const button = createElement('button', 'audit-sort-button', label);
		button.type = 'button';
		button.dataset.auditSort = key;
		if (keywordAuditSort.key === key) {
			button.append(createElement('span', 'audit-sort-indicator', keywordAuditSort.direction === 'asc' ? ' ▲' : ' ▼'));
		}
		heading.append(button);
		headerRow.append(heading);
	}
	head.append(headerRow);
	table.append(head);

	const body = document.createElement('tbody');
	const sortedRows = [...rows].sort((left, right) => {
		const leftValue = left[keywordAuditSort.key];
		const rightValue = right[keywordAuditSort.key];
		const comparison = typeof leftValue === 'number'
			? leftValue - rightValue
			: leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' });
		return keywordAuditSort.direction === 'asc' ? comparison : -comparison;
	});
	for (const row of sortedRows) {
		const tr = document.createElement('tr');
		const keywordCell = createElement('th', '', row.keyword);
		keywordCell.scope = 'row';
		tr.append(
			keywordCell,
			createElement('td', '', String(row.sources)),
			createElement('td', '', String(row.recipeUses)),
			createElement('td', '', String(row.delta))
		);
		body.append(tr);
	}
	table.append(body);
	container.append(table);
}

function renderIngredientChoices(containerId) {
	const container = document.getElementById(containerId);
	const selected = new Map([...container.querySelectorAll('[data-ingredient-id]:checked')].map(input => [
		input.dataset.ingredientId,
		Number(container.querySelector(`[data-quantity-for="${CSS.escape(input.dataset.ingredientId)}"]`)?.value || 1)
	]));
	container.replaceChildren();
	const ingredients = state.inventory.filter(item => canBeIngredient(item) && Number(item.quantity) > 0);
	if (!ingredients.length) {
		container.append(createElement('p', 'empty-state', 'No ingredients in inventory.'));
		return;
	}
	for (const item of ingredients) {
		const row = createElement('label', 'ingredient-choice');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.dataset.ingredientId = item.id;
		checkbox.checked = selected.has(item.id);
		const description = createElement('span', 'ingredient-name');
		description.append(createElement('span', '', `${item.name} · ${item.quantity} available`));
		const unlocked = getUnlockedKeywords(item, state.player.level);
		const tags = createElement('span', 'ingredient-keywords');
		if (unlocked.length) renderKeywordTags(tags, unlocked);
		else tags.append(createElement('small', '', 'No keywords unlocked'));
		description.append(tags);
		const quantity = document.createElement('input');
		quantity.type = 'number';
		quantity.min = '1';
		quantity.max = String(item.quantity);
		quantity.step = '1';
		quantity.value = String(Math.min(selected.get(item.id) || 1, item.quantity));
		quantity.dataset.quantityFor = item.id;
		quantity.setAttribute('aria-label', `${item.name} quantity`);
		row.append(checkbox, description, quantity);
		container.append(row);
	}
}

function getCraftKeywordCoverage(recipe) {
	const counts = {};
	for (const { id, quantity } of getSelections('craft-ingredients')) {
		const item = state.inventory.find(candidate => candidate.id === id);
		if (!item) continue;
		for (const keyword of getUnlockedKeywords(item, state.player.level)) {
			const key = normalizeName(keyword);
			counts[key] = (counts[key] || 0) + quantity;
		}
	}
	return matchRequiredKeywordSlots(recipe.requiredKeywords, counts);
}

function matchRequiredKeywordSlots(requiredKeywords, availableCounts) {
	const remaining = { ...availableCounts };
	return requiredKeywords.map(keyword => {
		const key = normalizeName(keyword);
		let matchedKey = key;
		if (key === 'any') {
			matchedKey = Object.keys(remaining).find(candidate => remaining[candidate] > 0) || '';
		}
		const covered = Boolean(matchedKey) && (remaining[matchedKey] || 0) > 0;
		if (covered) remaining[matchedKey] -= 1;
		return { keyword, covered };
	});
}

function renderExperimentIngredientSelectors() {
	const container = document.getElementById('experiment-ingredients');
	const priorSelections = [...container.querySelectorAll('[data-experiment-slot]')].map(select => select.value);
	const ingredients = state.inventory.filter(item =>
		canBeIngredient(item) && Number(item.quantity ?? item.stock ?? item.Stock) > 0
	);
	const selectedCounts = new Map();
	const selected = priorSelections.map(id => {
		const item = ingredients.find(candidate => candidate.id === id);
		if (!item) return '';
		const count = selectedCounts.get(id) || 0;
		const stock = Number(item.quantity ?? item.stock ?? item.Stock) || 0;
		if (count >= stock) return '';
		selectedCounts.set(id, count + 1);
		return id;
	});
	container.replaceChildren();
	for (let index = 0; index < 4; index += 1) {
		const field = createElement('label', 'field experiment-slot');
		field.append(createElement('span', '', `Ingredient ${index + 1}`));
		const select = document.createElement('select');
		select.dataset.experimentSlot = String(index);
		const placeholder = createElement('option', '', 'Choose an ingredient');
		placeholder.value = '';
		select.append(placeholder);
		const otherSelections = selected.filter((id, slot) => slot !== index && id);
		for (const item of ingredients) {
			const stock = Number(item.quantity ?? item.stock ?? item.Stock) || 0;
			const alreadySelected = otherSelections.filter(id => id === item.id).length;
			if (alreadySelected >= stock) continue;
			const option = createElement('option', '', `${item.name} · ${stock} available`);
			option.value = item.id;
			select.append(option);
		}
		select.value = selected[index] || '';
		const keywordTags = createElement('div', 'keyword-list experiment-slot-keywords');
		const chosen = ingredients.find(item => item.id === select.value);
		if (chosen) renderKeywordTags(keywordTags, getUnlockedKeywords(chosen, state.player.level));
		field.append(select, keywordTags);
		container.append(field);
	}
}

function getSelections(containerId) {
	const container = document.getElementById(containerId);
	if (containerId === 'experiment-ingredients') {
		const quantities = new Map();
		for (const select of container.querySelectorAll('[data-experiment-slot]')) {
			if (select.value) quantities.set(select.value, (quantities.get(select.value) || 0) + 1);
		}
		return [...quantities].map(([id, quantity]) => ({ id, quantity }));
	}
	return [...container.querySelectorAll('[data-ingredient-id]:checked')].map(input => ({
		id: input.dataset.ingredientId,
		quantity: Number(container.querySelector(`[data-quantity-for="${CSS.escape(input.dataset.ingredientId)}"]`).value)
	}));
}

function renderPlayer() {
	document.getElementById('player-level').value = String(state.player.level);
	document.getElementById('player-herbalism-kit').checked = state.player.equipment.herbalismKit;
	document.getElementById('player-herbalism-proficient').checked = state.player.toolProficiencies.herbalismKit;
	document.getElementById('player-alchemist-supplies').checked = state.player.equipment.alchemistSupplies;
	document.getElementById('player-alchemist-proficient').checked = state.player.toolProficiencies.alchemistSupplies;
	const profile = getCharacterRollProfile(state.player);
	const abilities = document.getElementById('player-abilities');
	abilities.replaceChildren();
	for (const { id, label, abbreviation } of ABILITY_SCORES) {
		const field = createElement('label', 'ability-field');
		const title = createElement('span', '', `${label} (${abbreviation})`);
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '1';
		input.max = '30';
		input.step = '1';
		input.required = true;
		input.id = `player-ability-${id}`;
		input.value = String(state.player.abilityScores[id]);
		input.setAttribute('aria-label', `${label} score`);
		const modifier = profile.abilityModifiers[id];
		field.append(title, input, createElement('small', 'ability-modifier', `Modifier ${modifier >= 0 ? '+' : ''}${modifier}`));
		abilities.append(field);
	}

	const skills = document.getElementById('player-skills');
	skills.replaceChildren();
	for (const [skill, ability] of Object.entries(SKILL_ABILITIES)) {
		const row = createElement('div', 'skill-row');
		const name = createElement('span', 'skill-name', `${skill.replace(/\b\w/g, letter => letter.toUpperCase())} · ${ability.slice(0, 3).toUpperCase()}`);
		const training = state.player.skills[skill];
		const proficiency = profile.skills[skill].modifier;
		const proficientLabel = createElement('label', 'skill-toggle', 'Proficient');
		const proficient = document.createElement('input');
		proficient.type = 'checkbox';
		proficient.checked = training.proficient;
		proficient.dataset.skill = skill;
		proficient.dataset.training = 'proficient';
		proficient.setAttribute('aria-label', `${skill} proficiency`);
		proficientLabel.prepend(proficient);
		const expertiseLabel = createElement('label', 'skill-toggle', 'Expertise');
		const expertise = document.createElement('input');
		expertise.type = 'checkbox';
		expertise.checked = training.expertise;
		expertise.dataset.skill = skill;
		expertise.dataset.training = 'expertise';
		expertise.setAttribute('aria-label', `${skill} expertise`);
		expertiseLabel.prepend(expertise);
		row.append(name, proficientLabel, expertiseLabel, createElement('strong', 'skill-modifier', `${proficiency >= 0 ? '+' : ''}${proficiency}`));
		skills.append(row);
	}
	const list = document.getElementById('player-keywords');
	list.replaceChildren();
	for (const keyword of state.player.discoveredKeywords) {
		list.append(createElement('span', 'keyword-chip', keyword));
	}
	if (!state.player.discoveredKeywords.length) {
		list.append(createElement('p', 'empty-state', 'No keywords discovered.'));
	}
}

function setExperimentResult(result) {
	const output = document.getElementById('experiment-result');
	output.replaceChildren();
	output.className = `result ${result.success ? 'result-success' : 'result-error'}`;
	output.hidden = false;
	output.append(createElement('p', '', result.message));
	if (!result.valid) return;
	if (result.success) {
		output.append(createElement('p', '', `Recipe learned: ${result.selectedRecipe.name}`));
		const tags = createElement('div', 'keyword-list');
		renderKeywordTags(tags, result.selectedRecipe.matchedSlots);
		output.append(tags);
		return;
	}
	if (result.nearMissCount) {
		output.append(createElement('p', '', `Unknown Recipe × ${result.nearMissCount}`));
	} else {
		output.append(createElement('p', '', 'No undiscovered recipe matched these keywords.'));
	}
	if (result.closestNearMiss) {
		const tags = createElement('div', 'keyword-list');
		renderKeywordTags(tags, result.closestNearMiss.matchedSlots, { collapseUnknown: true });
		output.append(tags);
	}
}

function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (character === '"') {
				quoted = false;
			} else {
				field += character;
			}
		} else if (character === '"' && field.length === 0) {
			quoted = true;
		} else if (character === ',') {
			row.push(field);
			field = '';
		} else if (character === '\n' || character === '\r') {
			if (character === '\r' && text[index + 1] === '\n') index += 1;
			row.push(field);
			if (row.some(value => value.trim())) rows.push(row);
			row = [];
			field = '';
		} else {
			field += character;
		}
	}
	if (quoted) throw new Error('The CSV file contains an unclosed quoted field.');
	row.push(field);
	if (row.some(value => value.trim())) rows.push(row);
	if (rows.length < 2) throw new Error('The CSV needs a header row and at least one data row.');

	const headers = rows[0].map(header => normalizeName(header).replace(/[^a-z0-9]/g, ''));
	return rows.slice(1).map(values => Object.fromEntries(
		headers.map((header, index) => [header, values[index] || ''])
	));
}

async function loadPdfCatalog() {
	const catalogFile = async name => {
		const response = await fetch(new URL(`./data/${name}`, import.meta.url));
		if (!response.ok) throw new Error(`Could not load ${name} (${response.status} ${response.statusText}).`);
		return response.json();
	};
	const [flora, rawFauna, catalogRecipes] = await Promise.all([
		catalogFile('Flora.json'),
		catalogFile('Fauna.json'),
		catalogFile('Recipes.json')
	]);
	const fauna = normalizeFaunaCatalog(rawFauna);
	const { validRecipes: recipes, skippedRecipes } = partitionRecipeCatalog(catalogRecipes);
	if (!Array.isArray(flora) || !flora.length || flora.some(table =>
		!String(table.terrain || '').trim() || !Array.isArray(table.entries) || !table.entries.length ||
		table.entries.some(entry => normalizeKeywords(entry.keywords).length !== 4)
	)) {
		throw new Error('The Flora catalog must contain terrain tables whose entries each have exactly four keywords.');
	}
	if (!Array.isArray(fauna) || !fauna.length || !Array.isArray(recipes) || !recipes.length) {
		throw new Error('The Fauna and Recipes catalogs must contain entries.');
	}
	if (fauna.some(creature => !creature.creatureType ||
		!creature.normalHarvest ||
		[creature.normalHarvest, creature.criticalHarvest].filter(Boolean).some(item =>
			!String(item.name || '').trim() ||
			!Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 ||
			normalizeKeywords(item.keywords).length !== 4))) {
		throw new Error('Every Fauna creature must have a type and a normal harvest item; listed harvest items need positive quantities and exactly four keywords.');
	}
	for (const creature of fauna) getHarvestSkillForCreatureType(creature.creatureType);
	if (recipes.some(recipe => {
		const productKeywords = getRecipeOutputKeywords(recipe);
		return normalizeKeywords(recipe.requiredKeywords).length < 1 ||
			normalizeKeywords(recipe.requiredKeywords).length > 9 ||
			(recipe.outputType === 'intermediate'
				? productKeywords.length < 1 || productKeywords.length > 4
				: productKeywords.length > 4);
	})) {
		throw new Error('Every recipe needs one to nine required keywords; crafted products may have one to four product keywords.');
	}
	floraTables = flora;
	faunaCatalog = fauna;
	skippedCatalogRecipes = skippedRecipes;
	validCatalogRecipeCount = recipes.length;
	renderKeywordAudit();

	const locationSelect = document.getElementById('forage-location');
	const options = [createElement('option', '', 'Choose a terrain')];
	options[0].value = '';
	for (const table of floraTables) {
		const option = createElement('option', '', table.terrain);
		option.value = table.terrain;
		options.push(option);
	}
	locationSelect.replaceChildren(...options);

	const creatureSelect = document.getElementById('harvest-creature');
	const creatureOptions = [createElement('option', '', 'Choose a creature')];
	creatureOptions[0].value = '';
	for (const creature of faunaCatalog) {
		const ratings = String(creature.challengeRating).split(/\s*,\s*/);
		const grouped = creature.name.match(/^(.+) \(Young, Adult, Ancient\)$/);
		const variants = grouped && ratings.length === 3
			? ratings.map((challengeRating, index) => ({
				name: `${grouped[1]} (${['Young', 'Adult', 'Ancient'][index]})`,
				challengeRating
			}))
			: [{ name: creature.name, challengeRating: creature.challengeRating }];
		for (const variant of variants) {
			const option = createElement('option', '', `${variant.name} · CR ${variant.challengeRating}`);
			option.value = JSON.stringify({ id: creature.id, challengeRating: variant.challengeRating });
			creatureOptions.push(option);
		}
	}
	creatureSelect.replaceChildren(...creatureOptions);
	const renderHarvestSkillLookup = () => {
		const selected = creatureSelect.value ? JSON.parse(creatureSelect.value) : null;
		const creature = selected && faunaCatalog.find(item => item.id === selected.id);
		const lookup = document.getElementById('harvest-skill-lookup');
		const dedicatedHarvestButton = document.getElementById('dedicated-harvest-button');
		dedicatedHarvestButton.disabled = !creature?.criticalHarvest ||
			dedicatedHarvestButton.dataset.cooldown === 'true';
		lookup.replaceChildren();
		if (!creature) {
			lookup.textContent = 'Select a creature to see its harvest details.';
			return;
		}
		const skill = getHarvestSkillForCreatureType(creature.creatureType);
		const type = createElement('span', '', creature.creatureType);
		const skillLabel = createElement('span', '', skill);
		const habitats = Array.isArray(creature.habitat) ? creature.habitat.join(', ') : '';
		const habitat = createElement('span', '', habitats || 'Habitat not listed');
		lookup.append(type, skillLabel, habitat);
	};
	creatureSelect.addEventListener('change', renderHarvestSkillLookup);
	renderHarvestSkillLookup();

	const catalogByName = new Map();
	for (const item of floraTables.flatMap(table => table.entries)) {
		const key = normalizeName(item.name);
		if (!catalogByName.has(key)) catalogByName.set(key, { ...item, category: 'flora' });
	}
	for (const item of faunaCatalog.flatMap(creature => creature.loot)) {
		const key = normalizeName(item.name);
		if (!catalogByName.has(key)) catalogByName.set(key, { ...item, category: 'fauna' });
	}
	ingredientCatalog = [...catalogByName.values()];

	const synchronizedRecipes = synchronizeRecipeCatalog(state.recipes, recipes);
	const synchronizedInventory = synchronizeCraftedInventory(state.inventory, synchronizedRecipes);
	if (synchronizedRecipes !== state.recipes || synchronizedInventory !== state.inventory) {
		updateState(nextState => {
			nextState.recipes = synchronizedRecipes;
			nextState.inventory = synchronizedInventory;
		});
	}
	render();
}

function importCsvRows(rows, type) {
	if (type === 'forage') {
		const imported = rows.map(row => {
			const name = String(row.name || row.ingredient || row.item || '').trim();
			const location = String(row.location || '').trim();
			const chance = Number(row.chance);
			const keywords = normalizeKeywords(row.keywords || [
				row.keyword1, row.keyword2, row.keyword3, row.keyword4
			]);
			if (!name || !location || !Number.isFinite(chance) || chance <= 0 || chance > 1) {
				throw new Error('Each forage row needs a location, ingredient name, and chance greater than 0 and no more than 1.');
			}
			if (keywords.length !== 4) throw new Error(`Foraged ingredient "${name}" must have exactly four keywords.`);
			return createForageEntry({
				location,
				terrain: String(row.terrain || '').trim(),
				chance,
				ingredient: createInventoryItem({
					name,
					quantity: 1,
					rarity: row.rarity,
					keywords,
					category: row.category || 'flora',
					isWild: true,
					source: 'Forage'
				})
			});
		});
		updateState(nextState => {
			for (const entry of imported) {
				const index = nextState.forageTable.findIndex(existing =>
					normalizeName(existing.location) === normalizeName(entry.location) &&
					normalizeName(existing.terrain) === normalizeName(entry.terrain) &&
					normalizeName(existing.ingredient.name) === normalizeName(entry.ingredient.name)
				);
				if (index < 0) nextState.forageTable.push(entry);
				else nextState.forageTable[index] = entry;
			}
		});
		return `${imported.length} forage ${imported.length === 1 ? 'entry' : 'entries'} imported.`;
	}

	if (type === 'recipes') {
		const imported = rows.map(row => {
			const name = String(row.name || row.potionname || '').trim();
			const requiredKeywords = normalizeKeywords(row.requiredkeywords || row.keywordpool || row.keywords);
			if (!name || requiredKeywords.length < 1 || requiredKeywords.length > 9 ||
				requiredKeywords.some(keyword => normalizeName(keyword) === 'any')) {
				throw new Error('Each recipe row must have a name and one to nine required keywords, without Any wildcards.');
			}
			return createRecipe({
				name,
				rarity: String(row.rarity || '').trim(),
				tier: String(row.tier || '').trim(),
				requiredKeywords,
				outputType: row.outputtype || 'potion',
				outputRarity: row.outputrarity || '',
				outputKeywords: normalizeKeywords(row.outputkeywords || row.productkeywords),
				fullEffect: String(row.fulleffect || row.effect || '').trim(),
				partialText: String(row.partialtext || '').trim(),
				clues: String(row.clues || '').trim(),
				sideEffects: String(row.sideeffects || '').trim(),
				effectProfile: effectProfileFromFields(row)
			});
		});
		updateState(nextState => {
			for (const recipe of imported) {
				const existingIndex = nextState.recipes.findIndex(item => normalizeName(item.name) === normalizeName(recipe.name));
				if (existingIndex < 0) nextState.recipes.push(recipe);
				else nextState.recipes[existingIndex] = recipe;
			}
		});
		return `${imported.length} recipe ${imported.length === 1 ? 'row' : 'rows'} imported.`;
	}

	const imported = rows.map(row => {
		const name = String(row.name || row.ingredient || row.item || row.itemname || '').trim();
		const stockText = row.stock ?? row.quantity ?? row.qty;
		const stock = Number(stockText);
		if (!name || stockText === '' || !Number.isFinite(stock) || stock < 0) {
			throw new Error('Each inventory row must have a name and a non-negative Stock or Quantity.');
		}
		const keywords = normalizeKeywords(row.keywords || [
			row.keyword1, row.keyword2, row.keyword3, row.keyword4
		]);
		const isWild = row.iswild === undefined
			? normalizeName(row.source) !== 'craft'
			: !['false', '0', 'no'].includes(String(row.iswild).toLowerCase());
		const isExplicitlyIntermediate = ['true', '1', 'yes'].includes(String(row.isintermediate || '').toLowerCase());
		const isIntermediate = isExplicitlyIntermediate ||
			((!isWild || normalizeName(row.source) === 'craft') &&
				normalizeName(row.category || row.type) !== 'concoction' &&
				normalizeName(row.type) !== 'potion');
		const isCrafted = !isWild || isIntermediate ||
			normalizeName(row.category || row.type) === 'concoction' ||
			normalizeName(row.type) === 'potion' ||
			normalizeName(row.source) === 'craft';
		if (isCrafted
			? keywords.length > 4 || (isIntermediate && keywords.length < 1)
			: keywords.length !== 4) {
			throw new Error(isCrafted
				? `Crafted ingredient "${name}" must have one to four keywords; final products may omit a profile.`
				: `Inventory ingredient "${name}" must have exactly four keywords.`);
		}
		return createInventoryItem({
			name,
			quantity: stock,
			type: String(row.type || row.category || '').trim(),
			category: row.category || row.type,
			rarity: row.rarity,
			keywords,
			isWild,
			isIntermediate: isExplicitlyIntermediate,
			source: String(row.source || '').trim(),
			notes: String(row.notes || '').trim()
		});
	});
	updateState(nextState => {
		for (const item of imported) {
			const existingIndex = nextState.inventory.findIndex(entry =>
				normalizeName(entry.name || entry.Name) === normalizeName(item.name) &&
				isCraftedItem(entry) === isCraftedItem(item)
			);
			if (existingIndex < 0) nextState.inventory.push(item);
			else nextState.inventory[existingIndex] = item;
		}
	});
	return `${imported.length} inventory ${imported.length === 1 ? 'row' : 'rows'} imported.`;
}

function validateBackup(value) {
	if (!value || !Array.isArray(value.recipes) || !Array.isArray(value.inventory)) {
		throw new Error('Backup must contain recipes and inventory arrays.');
	}
	for (const recipe of value.recipes) {
		const keywordCount = normalizeKeywords(recipe && (recipe.requiredKeywords || recipe.keywordPool)).length;
		const productKeywordCount = getRecipeOutputKeywords(recipe || {}).length;
		if (!recipe || !String(recipe.name || '').trim() ||
			keywordCount < 1 || keywordCount > 9 ||
			normalizeKeywords(recipe && (recipe.requiredKeywords || recipe.keywordPool))
				.some(keyword => normalizeName(keyword) === 'any') ||
			(recipe.outputType === 'intermediate' &&
				(productKeywordCount < 1 || productKeywordCount > 4)) ||
			(recipe.outputType !== 'intermediate' && productKeywordCount > 4)) {
			throw new Error('Every backup recipe must have a name and one to nine required keywords without Any wildcards; crafted outputs may have one to four product keywords.');
		}
	}
	for (const item of value.inventory) {
		const stock = Number(item && (item.stock ?? item.quantity ?? item.Stock));
		const keywords = normalizeKeywords(item && (item.keywords || item.Keywords));
		const craftedProduct = item && isCraftedItem(item);
		if (!item || !String(item.name || item.Name || '').trim() || !Number.isFinite(stock) || stock < 0 ||
			(craftedProduct
				? keywords.length > 4 || (item.isIntermediate && keywords.length < 1)
				: keywords.length !== 4)) {
			throw new Error('Every backup ingredient must include a name and non-negative stock; crafted products may have one to four keywords (or no profile for a final product), other ingredients need exactly four.');
		}
	}
	if (value.forageTable !== undefined && !Array.isArray(value.forageTable)) {
		throw new Error('Backup forageTable must be an array.');
	}
	return {
		recipes: value.recipes.map(recipe => ({ ...recipe })),
		inventory: value.inventory.map(item => ({ ...item })),
		forageTable: (value.forageTable || []).map(entry => createForageEntry(entry)),
		player: value.player ? createPlayerState(value.player) : createPlayerState()
	};
}

function bindEvents() {
	document.getElementById('player-skills').addEventListener('change', event => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || !input.dataset.skill) return;
		const skill = input.dataset.skill;
		const skills = document.getElementById('player-skills');
		if (input.dataset.training === 'expertise' && input.checked) {
			skills.querySelector(`[data-skill="${CSS.escape(skill)}"][data-training="proficient"]`).checked = true;
		} else if (input.dataset.training === 'proficient' && !input.checked) {
			skills.querySelector(`[data-skill="${CSS.escape(skill)}"][data-training="expertise"]`).checked = false;
		}
	});

	document.querySelectorAll('[data-tab]').forEach(button => {
		button.addEventListener('click', () => {
			document.querySelectorAll('[data-tab]').forEach(tab => {
				const active = tab === button;
				tab.classList.toggle('active', active);
				tab.setAttribute('aria-selected', String(active));
			});
			document.querySelectorAll('[data-panel]').forEach(panel => {
				panel.hidden = panel.dataset.panel !== button.dataset.tab;
			});
			showNotice('');
		});
	});

	document.getElementById('keyword-audit').addEventListener('click', event => {
		const button = event.target.closest('[data-audit-sort]');
		if (!button) return;
		const key = button.dataset.auditSort;
		if (!['keyword', 'sources', 'recipeUses', 'delta'].includes(key)) return;
		keywordAuditSort = {
			key,
			direction: keywordAuditSort.key === key && keywordAuditSort.direction === 'asc' ? 'desc' : 'asc'
		};
		renderKeywordAudit();
	});

	document.getElementById('craft-recipe').addEventListener('change', renderCraftForm);
	document.getElementById('craft-ingredients').addEventListener('change', () => {
		renderIngredientChoices('craft-ingredients');
		renderCraftForm();
	});
	document.getElementById('experiment-ingredients').addEventListener('change', renderExperimentIngredientSelectors);
	document.getElementById('craft-form').addEventListener('submit', event => {
		event.preventDefault();
		const recipe = state.recipes.find(item => item.id === document.getElementById('craft-recipe').value);
		const result = !recipe
			? { success: false, message: 'Choose a known recipe before crafting.' }
			: !state.player.recipeDiscoveries[recipe.id]?.discovered
				? { success: false, message: 'Experiment with the recipe first to discover its keyword requirements.' }
				: craftWithKeywords({
					recipe,
					inventory: state.inventory,
					selections: getSelections('craft-ingredients'),
					player: state.player,
					quantity: document.getElementById('craft-quantity').value
				});
		if (!result.success) {
			setResult(result.message, false);
			return;
		}
		try {
			updateState(nextState => { nextState.inventory = result.inventory; });
			const profile = formatEffectProfile(result.effect || {});
			setResult(profile ? `${result.message} ${profile}.` : result.message, true);
		} catch (error) {
			setResult(`Could not save your craft: ${error.message}`, false);
		}
	});

	document.getElementById('experiment-button').addEventListener('click', () => {
		const selections = getSelections('experiment-ingredients');
		const result = experimentWithIngredients({
			inventory: state.inventory,
			selections,
			recipes: state.recipes,
			knownRecipeIds: Object.entries(state.player.recipeDiscoveries)
				.filter(([, discovery]) => discovery?.discovered === true)
				.map(([recipeId]) => recipeId),
			player: state.player
		});
		if (!result.valid) {
			setExperimentResult(result);
			return;
		}
		try {
			updateState(nextState => {
				nextState.inventory = result.inventory;
				if (!result.success) return;
				const recipe = nextState.recipes.find(item => item.id === result.selectedRecipe.recipeId);
				if (!recipe) throw new Error('The selected recipe is no longer available.');
				const discoveredKeywords = new Set(nextState.player.discoveredKeywords.map(normalizeName));
				for (const keyword of Object.keys(result.keywordCounts)) discoveredKeywords.add(keyword);
				nextState.player.discoveredKeywords = [...discoveredKeywords];
				nextState.player.recipeDiscoveries[recipe.id] = {
					discoveredKeywords: [...recipe.requiredKeywords],
					keywordSlots: [...recipe.requiredKeywords],
					progress: recipe.requiredKeywords.length,
					discovered: true
				};
				const existing = nextState.inventory.find(item =>
					isCraftedItem(item) &&
					Boolean(item.isIntermediate) === (recipe.outputType === 'intermediate') &&
					(item.recipeId === recipe.id || normalizeName(item.name || item.Name) === normalizeName(recipe.name))
				);
				if (existing) {
					existing.quantity += 1;
					if (recipe.outputKeywords.length && !existing.keywords?.length) {
						existing.keywords = [...recipe.outputKeywords];
					}
				} else {
					nextState.inventory.push(createInventoryItem({
						name: recipe.name,
						rarity: recipe.outputRarity || recipe.rarity || recipe.tier || 'Common',
						keywords: recipe.outputKeywords,
						category: 'concoction',
						isWild: false,
						source: 'Craft',
						quantity: 1,
						crafted: true,
						isIntermediate: recipe.outputType === 'intermediate',
						recipeId: recipe.id,
						notes: recipe.fullEffect || recipe.effect || '',
						effectProfile: recipe.effectProfile || {}
					}));
				}
			});
			setExperimentResult(result);
		} catch (error) {
			setExperimentResult({ success: false, message: `Could not save experiment discoveries: ${error.message}` });
		}
	});

	document.getElementById('forage-form').addEventListener('submit', event => {
		event.preventDefault();
		startButtonCooldown([document.getElementById('forage-button')]);
		const location = document.getElementById('forage-location').value.trim();
		const method = document.getElementById('forage-method').value;
		const output = document.getElementById('forage-result');
		output.hidden = false;
		if (!floraTables.length) {
			output.className = 'result result-error';
			output.textContent = 'The Flora catalog is not loaded yet. Please try again.';
			return;
		}
		if (!state.player.equipment.herbalismKit) {
			output.className = 'result result-error';
			output.textContent = 'A Herbalism Kit is required to forage. Mark it as owned on the Player page.';
			return;
		}
		try {
			const natureProficient = state.player.skills.nature.proficient;
			const result = rollFloraGathering({
				terrain: location,
				method,
				modifier: getSkillModifier(state.player, 'nature'),
				advantage: natureProficient && state.player.toolProficiencies.herbalismKit,
				floraTables
			});
			output.className = `result ${result.success ? 'result-success' : 'result-error'}`;
			if (result.success) {
				updateState(nextState => {
					for (const { flora } of result.finds) {
						const existing = nextState.inventory.find(item =>
							!isCraftedItem(item) &&
							normalizeName(item.category) === 'flora' &&
							normalizeName(item.name || item.Name) === normalizeName(flora.name)
						);
						if (existing) {
							existing.quantity += 1;
						} else {
							nextState.inventory.push(createInventoryItem({
								name: flora.name,
								rarity: flora.rarity,
								keywords: flora.keywords,
								category: 'flora',
								isWild: true,
								source: 'Forage',
								quantity: 1,
								description: flora.description,
								terrain: result.terrain,
								rollMin: flora.rollMin,
								rollMax: flora.rollMax
							}));
						}
					}
				});
			}
			const checkRoll = result.check.secondRoll === null
				? `${result.check.firstRoll}`
				: `${result.check.firstRoll}/${result.check.secondRoll} (advantage ${result.check.dieRoll})`;
			const finds = new Map();
			for (const { flora } of result.finds) {
				finds.set(flora.name, (finds.get(flora.name) || 0) + 1);
			}
			const foundSummary = [...finds].map(([name, quantity]) => `${name} ×${quantity}`).join(', ');
			const collected = foundSummary || 'None';
			const qualitySummary = result.critical ? `; critical success, 1d4 yield = ${result.quantityRoll}` : '';
			output.textContent = `${result.success ? 'Success' : 'Failure'} | Collected: ${collected}\nNature check: d20 ${checkRoll} + ${result.check.modifier} = ${result.check.total} vs DC ${result.dc}${qualitySummary}.`;
		} catch (error) {
			output.className = 'result result-error';
			output.textContent = `Could not complete the forage attempt: ${error.message}`;
		}
	});

	document.getElementById('harvest-form').addEventListener('submit', event => {
		event.preventDefault();
		const harvestButtons = [
			document.getElementById('harvest-button'),
			document.getElementById('dedicated-harvest-button')
		];
		startButtonCooldown(harvestButtons, 5000, () => {
			const selected = document.getElementById('harvest-creature').value
				? JSON.parse(document.getElementById('harvest-creature').value)
				: null;
			const creature = selected && faunaCatalog.find(item => item.id === selected.id);
			harvestButtons[1].disabled = !creature?.criticalHarvest;
		});
		const approach = event.submitter?.dataset.harvestApproach || 'standard';
		const output = document.getElementById('harvest-result');
		output.hidden = false;
		if (!faunaCatalog.length) {
			output.className = 'result result-error';
			output.textContent = 'The Fauna catalog is not loaded yet. Please try again.';
			return;
		}
		if (!state.player.equipment.alchemistSupplies) {
			output.className = 'result result-error';
			output.textContent = "Alchemist's Supplies are required to harvest a creature. Mark them as owned on the Player page.";
			return;
		}
		try {
			const selected = JSON.parse(document.getElementById('harvest-creature').value);
			const creature = faunaCatalog.find(item => item.id === selected.id);
			if (!creature) throw new Error('Choose a creature from the Fauna catalog.');
			const skill = getHarvestSkillForCreatureType(creature.creatureType);
			const skillProficient = state.player.skills[skill]?.proficient === true;
			const toolProficient = state.player.toolProficiencies.alchemistSupplies;
			const result = rollFaunaHarvest({
				creature: { ...creature, challengeRating: selected.challengeRating },
				modifier: getSkillModifier(state.player, skill),
				advantage: skillProficient && toolProficient,
				approach
			});
			output.className = `result ${result.success ? 'result-success' : 'result-error'}`;
			if (result.success) {
				updateState(nextState => {
					for (const item of result.loot) {
						const existing = nextState.inventory.find(entry =>
							!isCraftedItem(entry) &&
							normalizeName(entry.category) === 'fauna' &&
							normalizeName(entry.name || entry.Name) === normalizeName(item.name)
						);
						if (existing) {
							existing.quantity += item.quantity;
							const sourceNote = `Harvested from ${creature.name}.`;
							if (!String(existing.notes || '').includes(sourceNote)) {
								existing.notes = [existing.notes, sourceNote].filter(Boolean).join(' ');
							}
						} else {
							nextState.inventory.push(createInventoryItem({
								name: item.name,
								rarity: item.rarity,
								keywords: item.keywords,
								category: 'fauna',
								isWild: true,
								source: 'Creature harvest',
								quantity: item.quantity,
								notes: `Harvested from ${creature.name}.`
							}));
						}
					}
				});
			}
			const roll = result.check.secondRoll === null
				? `${result.check.firstRoll}`
				: `${result.check.firstRoll}/${result.check.secondRoll} (advantage ${result.check.dieRoll})`;
			const loot = result.loot.map(item => `${item.name} ×${item.quantity}`).join(', ') || 'None';
			const outcome = result.critical ? 'Critical Success' : result.success ? 'Success' : 'Failure';
			const approachLabel = result.approach === 'dedicated' ? 'Dedicated extract' : 'Standard harvest';
			output.textContent = `${outcome} | Collected: ${loot}\n${approachLabel}; ${skill} check (${creature.creatureType}): d20 ${roll} + ${result.check.modifier} = ${result.check.total} vs DC ${result.successDc} (base DC ${result.dc}; critical at ${result.dc + 10}).`;
		} catch (error) {
			output.className = 'result result-error';
			output.textContent = `Could not complete the creature harvest: ${error.message}`;
		}
	});

	document.getElementById('player-form').addEventListener('submit', event => {
		event.preventDefault();
		const level = Number(document.getElementById('player-level').value);
		if (!Number.isInteger(level) || level < 1 || level > 20) {
			showNotice('Player level must be an integer from 1 to 20.', true);
			return;
		}
		try {
			const abilityScores = Object.fromEntries(ABILITY_SCORES.map(({ id }) =>
				[id, Number(document.getElementById(`player-ability-${id}`).value)])
			);
			const skills = Object.fromEntries(Object.keys(SKILL_ABILITIES).map(skill => {
				const proficient = document.querySelector(`[data-skill="${CSS.escape(skill)}"][data-training="proficient"]`).checked;
				const expertise = document.querySelector(`[data-skill="${CSS.escape(skill)}"][data-training="expertise"]`).checked;
				return [skill, { proficient, expertise }];
			}));
			const equipment = {
				herbalismKit: document.getElementById('player-herbalism-kit').checked,
				alchemistSupplies: document.getElementById('player-alchemist-supplies').checked
			};
			const toolProficiencies = {
				herbalismKit: document.getElementById('player-herbalism-proficient').checked,
				alchemistSupplies: document.getElementById('player-alchemist-proficient').checked
			};
			updateState(nextState => {
				nextState.player = createPlayerState({
					...nextState.player,
					level,
					abilityScores,
					skills,
					equipment,
					toolProficiencies
				});
			});
			showNotice('Character stats saved.');
		} catch (error) {
			showNotice(`Could not save player level: ${error.message}`, true);
		}
	});

	const inventoryName = document.getElementById('inventory-name');
	const suggestionList = document.getElementById('ingredient-suggestions');
	const renderIngredientSuggestions = () => {
		const query = normalizeName(inventoryName.value);
		suggestionList.replaceChildren();
		if (!query) {
			suggestionList.hidden = true;
			inventoryName.setAttribute('aria-expanded', 'false');
			return;
		}
		const matches = ingredientCatalog
			.filter(item => normalizeName(item.name).includes(query))
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, 8);
		for (const item of matches) {
			const option = createElement('button', 'ingredient-suggestion', item.name);
			option.type = 'button';
			option.role = 'option';
			option.dataset.ingredientName = item.name;
			suggestionList.append(option);
		}
		suggestionList.hidden = !matches.length;
		inventoryName.setAttribute('aria-expanded', String(matches.length > 0));
	};
	inventoryName.addEventListener('input', renderIngredientSuggestions);
	inventoryName.addEventListener('focus', renderIngredientSuggestions);
	inventoryName.addEventListener('blur', () => {
		window.setTimeout(() => {
			if (suggestionList.contains(document.activeElement)) return;
			suggestionList.hidden = true;
			inventoryName.setAttribute('aria-expanded', 'false');
		}, 0);
	});
	inventoryName.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			suggestionList.hidden = true;
			inventoryName.setAttribute('aria-expanded', 'false');
		} else if (event.key === 'ArrowDown' && !suggestionList.hidden) {
			event.preventDefault();
			suggestionList.querySelector('button')?.focus();
		}
	});
	suggestionList.addEventListener('pointerdown', event => event.preventDefault());
	suggestionList.addEventListener('click', event => {
		const option = event.target.closest('[data-ingredient-name]');
		if (!option) return;
		const item = ingredientCatalog.find(candidate => candidate.name === option.dataset.ingredientName);
		if (!item) return;
		inventoryName.value = item.name;
		suggestionList.hidden = true;
		inventoryName.setAttribute('aria-expanded', 'false');
		inventoryName.focus();
	});

	document.getElementById('inventory-form').addEventListener('submit', event => {
		event.preventDefault();
		const name = document.getElementById('inventory-name').value.trim();
		const catalogItem = ingredientCatalog.find(item =>
			normalizeName(item.name) === normalizeName(name)
		);
		if (!catalogItem) {
			showNotice('Choose an ingredient from the Flora or Fauna catalog.', true);
			return;
		}
		const keywords = normalizeKeywords(catalogItem.keywords);
		if (keywords.length !== 4) {
			showNotice('This catalog ingredient does not have four keywords and cannot be added.', true);
			return;
		}
		try {
			updateState(nextState => nextState.inventory.push(createInventoryItem({
				name: catalogItem.name,
				quantity: 1,
				rarity: catalogItem.rarity || 'Common',
				category: catalogItem.category,
				keywords,
				isWild: true,
				source: 'Forage'
			})));
			event.currentTarget.reset();
			suggestionList.hidden = true;
			inventoryName.setAttribute('aria-expanded', 'false');
			showNotice('Item added to inventory.');
		} catch (error) {
			showNotice(`Could not save the item: ${error.message}`, true);
		}
	});

	document.getElementById('inventory-groups').addEventListener('click', event => {
		const button = event.target.closest('[data-remove-inventory]');
		if (!button) return;
		try {
			updateState(nextState => {
				const index = nextState.inventory.findIndex(item => item.id === button.dataset.removeInventory);
				if (index >= 0) nextState.inventory.splice(index, 1);
			});
		} catch (error) {
			showNotice(`Could not remove the item: ${error.message}`, true);
		}
	});

	document.getElementById('import-form').addEventListener('submit', async event => {
		event.preventDefault();
		const form = event.currentTarget;
		const file = document.getElementById('import-file').files[0];
		if (!file) return;
		try {
			const contents = await file.text();
			const type = document.getElementById('import-type').value;
			let message;
			if (type === 'backup') {
				const imported = validateBackup(JSON.parse(contents));
				updateState(nextState => {
					nextState.recipes = imported.recipes.map(recipe => createRecipe(recipe));
					nextState.inventory = imported.inventory.map(item => createInventoryItem(item));
					nextState.forageTable = Array.isArray(imported.forageTable) ? imported.forageTable : [];
					nextState.player = createPlayerState(imported.player);
				});
				message = `Backup restored: ${imported.recipes.length} recipes and ${imported.inventory.length} inventory items.`;
			} else {
				message = importCsvRows(parseCsv(contents), type);
			}
			form.reset();
			showNotice(message);
		} catch (error) {
			showNotice(`Import failed: ${error.message}`, true);
		}
	});

	document.getElementById('export-button').addEventListener('click', () => {
		try {
			const backup = {
				version: 2,
				exportedAt: new Date().toISOString(),
				recipes: state.recipes,
				inventory: state.inventory,
				forageTable: state.forageTable,
				player: state.player
			};
			const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
			const link = createElement('a');
			link.href = url;
			link.download = 'alchemists-almanac-backup.json';
			link.click();
			URL.revokeObjectURL(url);
			showNotice('Backup downloaded.');
		} catch (error) {
			showNotice(`Could not export your data: ${error.message}`, true);
		}
	});

	const installButton = document.getElementById('install-button');
	window.addEventListener('beforeinstallprompt', event => {
		event.preventDefault();
		installPrompt = event;
		installButton.hidden = false;
	});
	installButton.addEventListener('click', async () => {
		if (!installPrompt) return;
		installPrompt.prompt();
		await installPrompt.userChoice;
		installPrompt = null;
		installButton.hidden = true;
	});
}

try {
	state = readState();
	bindEvents();
	render();
	loadPdfCatalog().catch(error => {
		showNotice(`PDF catalogs could not be loaded: ${error.message}`, true);
	});
} catch (error) {
	showNotice(`The almanac could not start: ${error.message}`, true);
	document.querySelectorAll('button, input, textarea, select').forEach(control => {
		control.disabled = true;
	});
}