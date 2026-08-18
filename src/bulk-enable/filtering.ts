import type { FilterCategory } from '../components/filter-matching.js';
import type { DatadogEnvironment, DatadogFlagEntry } from '../datadog/types.js';

export const NEEDS_ENABLING_FILTER_ID = 'needs-enabling';
export const ENABLED_IN_ALL_FILTER_ID = 'enabled-in-all';

/**
 * Advanced filters for the bulk-enable flag picker. These categories partition
 * flags by their status in the environments selected earlier in the flow.
 */
export const BULK_ENABLE_FILTER_CATEGORIES: FilterCategory[] = [
	{
		id: NEEDS_ENABLING_FILTER_ID,
		label: 'needs-enabling',
		scope: 'selected environments',
		description:
			'At least one selected environment is disabled or its status could not be confirmed.',
	},
	{
		id: ENABLED_IN_ALL_FILTER_ID,
		label: 'enabled-in-all',
		scope: 'selected environments',
		description: 'Confirmed enabled in every selected environment.',
	},
];

/**
 * Classify a flag for the bulk-enable advanced filter. Missing status data is
 * deliberately treated as work remaining: only a flag confirmed enabled in
 * every selected environment may be hidden by the needs-enabling filter.
 */
export function flagEnablementCategories(
	flag: DatadogFlagEntry,
	selectedEnvironments: DatadogEnvironment[],
): string[] {
	const enabledInAll =
		selectedEnvironments.length > 0 &&
		flag.environmentStatuses !== undefined &&
		selectedEnvironments.every(
			(environment) =>
				flag.environmentStatuses?.get(environment.id) === 'ENABLED',
		);

	return [enabledInAll ? ENABLED_IN_ALL_FILTER_ID : NEEDS_ENABLING_FILTER_ID];
}
