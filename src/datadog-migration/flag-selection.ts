import chalk from 'chalk';
import { filterableCheckbox } from '../components/FilterableCheckbox.js';
import type { FilterCategory } from '../components/filter-matching.js';

/** One selectable Datadog flag; `value` is what the picker returns. */
export interface DatadogFlagChoice<T> {
	value: T;
	id: string;
	key: string;
	name: string;
	tags: string[];
	/** Pre-marked with a check and matched by the previously-migrated filter. */
	migrated: boolean;
	badge?: string;
	categories?: string[];
}

export function datadogFlagSearchTerms(
	choice: Pick<DatadogFlagChoice<unknown>, 'key' | 'name' | 'tags'>,
): string[] {
	return [choice.name, choice.key, ...choice.tags];
}

function choiceLabel(choice: DatadogFlagChoice<unknown>): string {
	const indicator = choice.migrated ? chalk.green('✓') : ' ';
	const key = chalk.gray(`(${choice.key})`);
	const tags =
		choice.tags.length > 0 ? chalk.dim(`  [${choice.tags.join(', ')}]`) : '';
	const badge = choice.badge ? `  ${choice.badge}` : '';
	return `${indicator}  ${choice.name}  ${key}${tags}${badge}`;
}

/**
 * Flag picker shared by Datadog-to-Datadog migration and status. Tags are
 * shown and searchable, so typing a tag such as `team:checkout` narrows the
 * list the same way it does in bulk-enable. Flags marked `migrated` sort
 * first, then by name.
 */
export async function selectDatadogFlags<T>(options: {
	choices: DatadogFlagChoice<T>[];
	message: string;
	previouslySelectedIds?: ReadonlySet<string>;
	filterCategories?: FilterCategory[];
}): Promise<T[] | null> {
	const previous = options.previouslySelectedIds ?? new Set<string>();
	const sorted = options.choices.slice().sort((a, b) => {
		if (a.migrated !== b.migrated) return a.migrated ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox<T>({
		message: options.message,
		choices: sorted.map((choice) => ({
			name: choiceLabel(choice),
			value: choice.value,
			checked: previous.has(choice.id),
			migrated: choice.migrated,
			searchTerms: datadogFlagSearchTerms(choice),
			...(choice.categories ? { categories: choice.categories } : {}),
		})),
		pageSize,
		filterCategories: options.filterCategories,
	});
}
