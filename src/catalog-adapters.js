function normalizeHarvestItem(item) {
	return {
		...item,
		name: String(item.itemName ?? item.name ?? item.Name ?? '').trim(),
		quantity: item.quantity ?? 1,
		rarity: String(item.rarity ?? item.Rarity ?? 'Common').trim(),
		keywords: item.keywords ?? item.Keywords ?? []
	};
}

function getLegacyHarvest(creature) {
	if (Array.isArray(creature.loot)) return creature.loot;
	if (!Array.isArray(creature.parts)) return [];
	return creature.parts.map(part => ({
		...part,
		quantity: part.quantity ?? creature.harvestYield ?? 1
	}));
}

export function normalizeFaunaCatalog(catalog) {
	if (!Array.isArray(catalog)) {
		throw new TypeError('The Fauna catalog must be an array.');
	}
	return catalog.map(creature => {
		const hasHarvestProfiles = creature.normalHarvest || creature.criticalHarvest;
		const normalHarvest = hasHarvestProfiles
			? (creature.normalHarvest ? normalizeHarvestItem(creature.normalHarvest) : null)
			: getLegacyHarvest(creature).map(normalizeHarvestItem);
		const criticalHarvest = hasHarvestProfiles && creature.criticalHarvest
			? normalizeHarvestItem(creature.criticalHarvest)
			: null;
		const loot = [
			...(Array.isArray(normalHarvest) ? normalHarvest : normalHarvest ? [normalHarvest] : []),
			...(criticalHarvest ? [criticalHarvest] : [])
		];
		return {
			...creature,
			creatureType: String(creature.CreatureType ?? creature.creatureType ?? '').trim(),
			normalHarvest,
			criticalHarvest,
			loot
		};
	});
}
