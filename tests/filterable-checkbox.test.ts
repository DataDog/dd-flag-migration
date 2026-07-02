/**
 * Tests for the pure filter predicate that drives the advanced-filter
 * sub-screen in the flag-selection prompt.
 */
import { describe, expect, it } from '@jest/globals';
import {
	type FilterCategory,
	itemMatchesFilters,
	MIGRATED_FILTER_ID,
} from '../src/filterable-checkbox.js';

const LD_CATEGORIES: FilterCategory[] = [
	{ id: 'new', label: 'new', description: '' },
	{ id: 'active', label: 'active', description: '' },
	{ id: 'inactive', label: 'inactive', description: '' },
	{ id: 'launched', label: 'launched', description: '' },
	{ id: MIGRATED_FILTER_ID, label: 'previously-migrated', description: '' },
];

const EPPO_CATEGORIES: FilterCategory[] = [
	{ id: MIGRATED_FILTER_ID, label: 'previously-migrated', description: '' },
];

const allActive = (cats: FilterCategory[]) => new Set(cats.map((c) => c.id));

describe('itemMatchesFilters', () => {
	it('shows every item when all filters are active', () => {
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
	});

	it('hides a lifecycle item when its only category is unchecked', () => {
		const active = allActive(LD_CATEGORIES);
		active.delete('inactive');
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('keeps a multi-category item visible if ANY of its categories is active (union)', () => {
		const active = allActive(LD_CATEGORIES);
		active.delete('inactive');
		// Flag is inactive in one env but active in another → still visible.
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive', 'active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('hides a multi-category item only when all of its categories are unchecked', () => {
		const active = allActive(LD_CATEGORIES);
		active.delete('inactive');
		active.delete('active');
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive', 'active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('hides migrated items when previously-migrated is unchecked', () => {
		const active = allActive(LD_CATEGORIES);
		active.delete(MIGRATED_FILTER_ID);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: ['active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('does not hide non-migrated items when previously-migrated is unchecked', () => {
		const active = allActive(LD_CATEGORIES);
		active.delete(MIGRATED_FILTER_ID);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['active'] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('hides migrated flags when previously-migrated is unchecked even if their lifecycle is active', () => {
		const base = allActive(LD_CATEGORIES);

		const migratedOff = new Set(base);
		migratedOff.delete(MIGRATED_FILTER_ID);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: ['inactive'] },
				migratedOff,
				LD_CATEGORIES,
			),
		).toBe(false);
	});

	it('shows migrated flags when previously-migrated is checked even if their lifecycle is unchecked', () => {
		const base = allActive(LD_CATEGORIES);
		const inactiveOff = new Set(base);
		inactiveOff.delete('inactive');
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: ['inactive'] },
				inactiveOff,
				LD_CATEGORIES,
			),
		).toBe(true);
	});

	it('does not show an Eppo item unless it matches the migrated category', () => {
		const active = allActive(EPPO_CATEGORIES);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: ['inactive'] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(false);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(true);
	});

	it('hides every Eppo flag when previously-migrated is unchecked', () => {
		const active = allActive(EPPO_CATEGORIES);
		active.delete(MIGRATED_FILTER_ID);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(false);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
				EPPO_CATEGORIES,
			),
		).toBe(false);
	});

	it('shows uncategorized LD flags only while all lifecycle filters are active', () => {
		const active = allActive(LD_CATEGORIES);
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
				LD_CATEGORIES,
			),
		).toBe(true);

		active.delete('inactive');
		active.delete('active');
		active.delete('new');
		active.delete('launched');
		expect(
			itemMatchesFilters(
				{ migrated: false, categories: [] },
				active,
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
