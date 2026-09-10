import chalk from 'chalk';
import type { FilterableChoice } from '../components/FilterableCheckbox.js';
import type { DatadogFlagEntry } from '../datadog/types.js';

export function buildFlagInspectionChoices(
	flags: DatadogFlagEntry[],
): FilterableChoice<DatadogFlagEntry>[] {
	return flags
		.slice()
		.sort((a, b) => a.key.localeCompare(b.key))
		.map((flag) => {
			const tags = flag.tags ?? [];
			const displayName =
				flag.name && flag.name !== flag.key
					? `${flag.name}${chalk.gray(`  (${flag.key})`)}`
					: flag.key;
			return {
				name:
					displayName +
					(tags.length > 0 ? chalk.gray(`  (${tags.join(', ')})`) : ''),
				value: flag,
				searchTerms: [flag.key, ...(flag.name ? [flag.name] : []), ...tags],
			};
		});
}
