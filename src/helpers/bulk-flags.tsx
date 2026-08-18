import chalk from 'chalk';
import { filterableCheckbox } from '../components/FilterableCheckbox.js';
import type { FilterCategory } from '../components/filter-matching.js';
import { fetchDatadogFlags, fetchFlagTags } from '../datadog/api.js';
import type { DatadogFlagEntry } from '../datadog/types.js';

function isMigratedFlag(flag: DatadogFlagEntry): boolean {
	return flag.migration_metadata !== undefined;
}

export async function loadMigratedFlagsWithTags(
	apiKey: string,
	appKey: string,
	site: string,
): Promise<DatadogFlagEntry[]> {
	const flags = (await fetchDatadogFlags(apiKey, appKey, site)).filter(
		isMigratedFlag,
	);
	for (const flag of flags) {
		if (flag.tags === undefined) {
			flag.tags = await fetchFlagTags(apiKey, appKey, flag.id, site);
		}
	}
	return flags.sort((a, b) => a.key.localeCompare(b.key));
}

export interface MigratedFlagSelectionOptions {
	filterCategories?: FilterCategory[];
	categoriesForFlag?: (flag: DatadogFlagEntry) => string[];
}

export async function selectMigratedFlags(
	flags: DatadogFlagEntry[],
	options: MigratedFlagSelectionOptions = {},
): Promise<DatadogFlagEntry[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox<DatadogFlagEntry>({
		message: 'Select migrated flags to update:',
		choices: flags.map((flag) => {
			const tags = flag.tags ?? [];
			return {
				name:
					flag.key +
					(tags.length > 0 ? chalk.gray(`  (${tags.join(', ')})`) : ''),
				value: flag,
				searchTerms: [flag.key, ...tags],
				categories: options.categoriesForFlag?.(flag),
			};
		}),
		pageSize,
		filterCategories: options.filterCategories,
	});
}
