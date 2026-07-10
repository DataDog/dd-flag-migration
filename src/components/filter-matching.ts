/**
 * Selectable filter categories shown in the advanced-filter sub-screen.
 * Migration-state categories are derived from each choice's `migrated` flag;
 * all other ids match a choice's `categories` field.
 */
export const MIGRATED_FILTER_ID = 'previously-migrated';
export const NOT_MIGRATED_FILTER_ID = 'not-yet-migrated';

export type FilterCategoryScope =
	| 'any environment'
	| 'all environments'
	| 'selected environments'
	| 'flag';

export type FilterCategory = {
	id: string;
	label: string;
	scope?: FilterCategoryScope;
	description: string;
};

/**
 * Whether an item is visible given the set of active (checked) filter ids.
 *
 * When no category filter is selected, no category filter is applied. When every
 * category is selected, the result is also unfiltered. Partial selections narrow
 * the list to items that belong to at least one selected category.
 */
export function itemMatchesFilters(
	item: { migrated: boolean; categories?: string[] },
	activeFilters: ReadonlySet<string>,
	filterCategories: readonly FilterCategory[],
): boolean {
	if (filterCategories.length === 0) return true;

	const configuredIds = new Set(filterCategories.map((c) => c.id));
	const selectedIds = [...activeFilters].filter((id) => configuredIds.has(id));
	if (
		selectedIds.length === 0 ||
		selectedIds.length === filterCategories.length
	) {
		return true;
	}

	const itemFilterIds = new Set(
		(item.categories ?? []).filter((id) => configuredIds.has(id)),
	);

	if (configuredIds.has(MIGRATED_FILTER_ID) && item.migrated) {
		itemFilterIds.add(MIGRATED_FILTER_ID);
	}
	if (configuredIds.has(NOT_MIGRATED_FILTER_ID) && !item.migrated) {
		itemFilterIds.add(NOT_MIGRATED_FILTER_ID);
	}

	return selectedIds.some((id) => itemFilterIds.has(id));
}
