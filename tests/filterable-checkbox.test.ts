/**
 * Tests for the pure filter predicate that drives the advanced-filter
 * sub-screen in the flag-selection prompt.
 */
import { describe, expect, it } from '@jest/globals';
import {
	type FilterCategory,
	itemMatchesFilters,
	MIGRATED_FILTER_ID,
	NOT_MIGRATED_FILTER_ID,
} from '../src/filterable-checkbox.js';

const LD_CATEGORIES: FilterCategory[] = [
	{ id: 'new', label: 'new', description: '' },
	{ id: 'active', label: 'active', description: '' },
	{ id: 'inactive', label: 'inactive', description: '' },
	{ id: 'launched', label: 'launched', description: '' },
	{ id: MIGRATED_FILTER_ID, label: 'previously-migrated', description: '' },
	{ id: NOT_MIGRATED_FILTER_ID, label: 'not-yet-migrated', description: '' },
];

const EPPO_CATEGORIES: FilterCategory[] = [
	{ id: MIGRATED_FILTER_ID, label: 'previously-migrated', description: '' },
	{ id: NOT_MIGRATED_FILTER_ID, label: 'not-yet-migrated', description: '' },
];

const allActive = (cats: FilterCategory[]) => new Set(cats.map((c) => c.id));

describe('itemMatchesFilters', () => {
	it('shows every item when no category filters are active', () => {
		const active = new Set<string>();
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(true);
	});

	it('shows every item when all category filters are active', () => {
		const active = allActive(LD_CATEGORIES);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: ['inactive'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('hides a lifecycle item when its category is not selected', () => {
		const active = new Set(['active']);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('keeps a multi-category item visible if ANY of its categories is active (union)', () => {
		const active = new Set(['active']);
		// Flag is inactive in one env but active in another → still visible.
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive', 'active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('hides a multi-category item only when none of its categories are selected', () => {
		const active = new Set(['launched']);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive', 'active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('shows migrated items when previously-migrated is selected', () => {
		const active = new Set([MIGRATED_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: ['active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('does not show non-migrated items when only previously-migrated is selected', () => {
		const active = new Set([MIGRATED_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('shows non-migrated items when not-yet-migrated is selected', () => {
		const active = new Set([NOT_MIGRATED_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('does not show migrated items when only not-yet-migrated is selected', () => {
		const active = new Set([NOT_MIGRATED_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: ['inactive'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('shows both Eppo migration states when both Eppo filters are selected', () => {
		const active = allActive(EPPO_CATEGORIES);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(true);
	});

	it('narrows Eppo to previously migrated flags', () => {
		const active = new Set([MIGRATED_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(false);
	});

	it('narrows Eppo to not-yet-migrated flags', () => {
		const active = new Set([NOT_MIGRATED_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(false);
	});

	it('hides uncategorized LD flags only under a partial category filter', () => {
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				new Set(),
				LD_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				allActive(LD_CATEGORIES),
				LD_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				new Set(['active']),
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('shows items when no category filters are configured', () => {
		expect(
			itemMatchesFilters({ migrated: false, categories: [] }, new Set(), []),
		).toBe(true);
	});
});
