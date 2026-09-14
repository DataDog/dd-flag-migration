import type { DatadogFlagEntry } from '../datadog/types.js';

export type AddTagsStatus = 'Updated' | 'Already tagged' | 'Failed';

export interface AddTagsResult {
	flagId: string;
	flagKey: string;
	existingTags: string[];
	addedTags: string[];
	resultingTags: string[];
	status: AddTagsStatus;
	error?: string;
}

export interface AddTagsDependencies {
	fetchTags: (flag: DatadogFlagEntry) => Promise<string[]>;
	updateTags: (flag: DatadogFlagEntry, tags: string[]) => Promise<void>;
	onProgress?: (flag: DatadogFlagEntry, index: number, total: number) => void;
}

export function parseSpaceDelimitedTags(value: string): string[] {
	return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}

export function mergeFlagTags(
	existingTags: string[],
	tagsToAdd: string[],
): { tags: string[]; addedTags: string[] } {
	const existing = new Set(existingTags);
	const addedTags = tagsToAdd.filter((tag) => !existing.has(tag));
	return {
		tags: [...existingTags, ...addedTags],
		addedTags,
	};
}

export async function processAddTags(
	flags: DatadogFlagEntry[],
	tagsToAdd: string[],
	dependencies: AddTagsDependencies,
): Promise<AddTagsResult[]> {
	const results: AddTagsResult[] = [];
	const { fetchTags, updateTags, onProgress } = dependencies;

	for (const [index, flag] of flags.entries()) {
		onProgress?.(flag, index + 1, flags.length);
		let existingTags = flag.tags ?? [];
		let addedTags: string[] = [];
		try {
			existingTags = await fetchTags(flag);
			const merge = mergeFlagTags(existingTags, tagsToAdd);
			const resultingTags = merge.tags;
			addedTags = merge.addedTags;
			const result = {
				flagId: flag.id,
				flagKey: flag.key,
				existingTags,
				addedTags,
			};

			if (addedTags.length === 0) {
				flag.tags = existingTags;
				results.push({
					...result,
					resultingTags,
					status: 'Already tagged',
				});
				continue;
			}

			await updateTags(flag, resultingTags);
			flag.tags = resultingTags;
			results.push({
				...result,
				resultingTags,
				status: 'Updated',
			});
		} catch (error) {
			results.push({
				flagId: flag.id,
				flagKey: flag.key,
				existingTags,
				addedTags,
				resultingTags: existingTags,
				status: 'Failed',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}
