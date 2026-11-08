function keywordKey(value) {
	return String(value || '').trim().toLocaleLowerCase();
}

export function getKeywordAudit(floraTables, faunaCatalog, recipes) {
	const stats = new Map();
	const getStats = keyword => {
		const key = keywordKey(keyword);
		if (!key || key === 'any') return null;
		if (!stats.has(key)) {
			stats.set(key, { keyword: String(keyword).trim(), sources: 0, recipeUses: 0 });
		}
		return stats.get(key);
	};
	const addSource = keywords => {
		const sourceKeywords = new Map();
		for (const value of Array.isArray(keywords) ? keywords : []) {
			const keyword = String(value).trim();
			if (!sourceKeywords.has(keywordKey(keyword))) sourceKeywords.set(keywordKey(keyword), keyword);
		}
		for (const keyword of sourceKeywords.values()) {
			const entry = getStats(keyword);
			if (entry) entry.sources += 1;
		}
	};

	for (const table of Array.isArray(floraTables) ? floraTables : []) {
		for (const item of Array.isArray(table.entries) ? table.entries : []) {
			addSource(item.keywords);
		}
	}
	for (const creature of Array.isArray(faunaCatalog) ? faunaCatalog : []) {
		for (const item of Array.isArray(creature.loot) ? creature.loot : []) {
			addSource(item.keywords);
		}
	}
	for (const recipe of Array.isArray(recipes) ? recipes : []) {
		addSource(recipe.outputKeywords);
		for (const keyword of Array.isArray(recipe.requiredKeywords) ? recipe.requiredKeywords : []) {
			const entry = getStats(keyword);
			if (entry) entry.recipeUses += 1;
		}
	}

	return [...stats.values()]
		.map(entry => ({ ...entry, delta: Math.abs(entry.sources - entry.recipeUses) }))
		.sort((left, right) =>
			left.keyword.localeCompare(right.keyword, undefined, { sensitivity: 'base' })
		);
}
