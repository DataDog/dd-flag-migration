import chalk from 'chalk';
import { select } from '../components/Select.js';
import { fetchFlagTags, updateFlagTags } from '../datadog/api.js';
import { formatAxiosError } from './format-axios-error.js';

/**
 * Tag sync strategy.
 *
 * - `additive` (Additive Merge): union source tags with existing Datadog tags.
 *   Tags that exist only in Datadog are preserved. This is the safe default.
 * - `replace` (Full Replace): Datadog tags are set to exactly the source tags.
 *   Tags that exist only in Datadog are removed (Tier 1 full sync).
 */
export type TagSyncMode = 'additive' | 'replace';

export const TAG_MODE_LABELS: Record<TagSyncMode, string> = {
	additive: 'Additive Merge',
	replace: 'Full Replace',
};

/** A source flag resolved to its matching Datadog flag, ready for tag sync. */
export interface TagSyncItem {
	sourceKey: string;
	datadogKey: string;
	datadogFlagId: string;
	sourceTags: string[];
}

export type TagSyncStatus = 'synced' | 'unchanged' | 'failed';

export interface TagSyncOutcome {
	sourceKey: string;
	datadogKey: string;
	datadogFlagId: string;
	mode: TagSyncMode;
	status: TagSyncStatus;
	sourceTags: string[];
	existingTags: string[];
	targetTags: string[];
	added: string[];
	removed: string[];
	error?: string;
}

export interface TagSyncSkipped {
	sourceKey: string;
	reason: string;
}

export interface TagSyncSummary {
	mode: TagSyncMode;
	dryRun: boolean;
	synced: number;
	unchanged: number;
	failed: number;
	skipped: number;
	results: TagSyncOutcome[];
	skippedFlags: TagSyncSkipped[];
}

/**
 * Compute the target tag list for a flag given the sync mode and the tags
 * currently on the Datadog flag. Pure function — no I/O.
 */
export function computeTargetTags(
	mode: TagSyncMode,
	sourceTags: string[],
	existingTags: string[],
): { target: string[]; added: string[]; removed: string[] } {
	const sourceSet = new Set(sourceTags);
	const existingSet = new Set(existingTags);

	if (mode === 'replace') {
		const target = [...sourceSet];
		return {
			target,
			added: target.filter((tag) => !existingSet.has(tag)),
			removed: [...existingSet].filter((tag) => !sourceSet.has(tag)),
		};
	}

	// Additive merge: union, never remove.
	const targetSet = new Set<string>([...existingTags, ...sourceTags]);
	const target = [...targetSet];
	return {
		target,
		added: [...sourceSet].filter((tag) => !existingSet.has(tag)),
		removed: [],
	};
}

/** Prompt the user for the tag sync strategy. */
export async function selectTagMode(): Promise<TagSyncMode> {
	return select<TagSyncMode>({
		message: 'How should tags be synced to Datadog?',
		choices: [
			{
				name: 'Additive Merge — add source tags, keep existing Datadog tags',
				value: 'additive',
				short: 'Additive Merge',
			},
			{
				name: 'Full Replace — replace Datadog tags with the source tags',
				value: 'replace',
				short: 'Full Replace',
			},
		],
	});
}

/** Prompt for tag behavior when a migration updates existing Datadog flags. */
export async function selectMigrationTagMode(): Promise<TagSyncMode> {
	return select<TagSyncMode>({
		message:
			'For existing Datadog flags, how should tags and team tags be synced?',
		choices: [
			{
				name: 'Merge — add source tags and matched team tags, keep existing Datadog tags',
				value: 'additive',
				short: 'Merge',
			},
			{
				name: 'Overwrite — replace Datadog tags with source and matched team tags',
				value: 'replace',
				short: 'Overwrite',
			},
		],
	});
}

/** Resolve the tags to write when a migration updates an existing flag. */
export async function resolveMigrationTargetTags(
	mode: TagSyncMode,
	sourceTags: string[],
	datadogFlagId: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
): Promise<string[]> {
	const existingTags =
		mode === 'additive'
			? await fetchFlagTags(ddApiKey, ddAppKey, datadogFlagId, ddSite)
			: [];
	return computeTargetTags(mode, sourceTags, existingTags).target;
}

export interface ExecuteTagSyncOptions {
	nonInteractive?: boolean;
	onProgress?: (index: number, total: number, item: TagSyncItem) => void;
}

/**
 * Sync tags for a set of resolved flags. Fetches the existing Datadog tags for
 * each flag, computes the target tag list with {@link computeTargetTags}, and
 * applies it (or previews it in dry-run mode). Returns a structured summary.
 */
export async function executeTagSync(
	items: TagSyncItem[],
	mode: TagSyncMode,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	options: ExecuteTagSyncOptions = {},
): Promise<TagSyncSummary> {
	const { nonInteractive = false, onProgress } = options;
	const results: TagSyncOutcome[] = [];
	let synced = 0;
	let unchanged = 0;
	let failed = 0;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		onProgress?.(i + 1, items.length, item);

		let existingTags: string[];
		try {
			existingTags = await fetchFlagTags(
				ddApiKey,
				ddAppKey,
				item.datadogFlagId,
				ddSite,
			);
		} catch (err) {
			const error = formatAxiosError(err);
			if (!nonInteractive) {
				console.log(
					chalk.yellow(
						`  ⚠ Could not fetch tags for ${chalk.cyan(item.sourceKey)}: ${error}`,
					),
				);
			}
			results.push({
				sourceKey: item.sourceKey,
				datadogKey: item.datadogKey,
				datadogFlagId: item.datadogFlagId,
				mode,
				status: 'failed',
				sourceTags: item.sourceTags,
				existingTags: [],
				targetTags: [],
				added: [],
				removed: [],
				error,
			});
			failed++;
			continue;
		}

		const { target, added, removed } = computeTargetTags(
			mode,
			item.sourceTags,
			existingTags,
		);

		const hasChanges = added.length > 0 || removed.length > 0;

		if (dryRun) {
			results.push({
				sourceKey: item.sourceKey,
				datadogKey: item.datadogKey,
				datadogFlagId: item.datadogFlagId,
				mode,
				status: hasChanges ? 'synced' : 'unchanged',
				sourceTags: item.sourceTags,
				existingTags,
				targetTags: target,
				added,
				removed,
			});
			if (hasChanges) synced++;
			else unchanged++;
			continue;
		}

		if (!hasChanges) {
			results.push({
				sourceKey: item.sourceKey,
				datadogKey: item.datadogKey,
				datadogFlagId: item.datadogFlagId,
				mode,
				status: 'unchanged',
				sourceTags: item.sourceTags,
				existingTags,
				targetTags: target,
				added,
				removed,
			});
			unchanged++;
			continue;
		}

		try {
			await updateFlagTags(
				ddApiKey,
				ddAppKey,
				item.datadogFlagId,
				target,
				ddSite,
			);
			results.push({
				sourceKey: item.sourceKey,
				datadogKey: item.datadogKey,
				datadogFlagId: item.datadogFlagId,
				mode,
				status: 'synced',
				sourceTags: item.sourceTags,
				existingTags,
				targetTags: target,
				added,
				removed,
			});
			synced++;
		} catch (err) {
			const error = formatAxiosError(err);
			results.push({
				sourceKey: item.sourceKey,
				datadogKey: item.datadogKey,
				datadogFlagId: item.datadogFlagId,
				mode,
				status: 'failed',
				sourceTags: item.sourceTags,
				existingTags,
				targetTags: target,
				added,
				removed,
				error,
			});
			failed++;
		}
	}

	return {
		mode,
		dryRun,
		synced,
		unchanged,
		failed,
		skipped: 0,
		results,
		skippedFlags: [],
	};
}

/** Render a human-readable summary line for a tag sync outcome. */
export function describeTagChanges(outcome: TagSyncOutcome): string {
	const parts: string[] = [];
	if (outcome.added.length > 0) {
		parts.push(chalk.green(`+${outcome.added.length}`));
	}
	if (outcome.removed.length > 0) {
		parts.push(chalk.red(`-${outcome.removed.length}`));
	}
	if (parts.length === 0) {
		return chalk.gray('no changes');
	}
	const detail = [
		outcome.added.length > 0 ? `added: ${outcome.added.join(', ')}` : null,
		outcome.removed.length > 0
			? `removed: ${outcome.removed.join(', ')}`
			: null,
	]
		.filter(Boolean)
		.join('; ');
	return `${parts.join(' ')} (${chalk.gray(detail)})`;
}
