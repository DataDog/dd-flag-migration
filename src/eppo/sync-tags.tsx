import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import { renderStatic } from '../components/mount.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import { fetchDatadogFlagKeys } from '../datadog/api.js';
import { eppoSourceIdLookupKey } from '../datadog/helpers.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { writeJsonOutput } from '../helpers/output.js';
import {
	describeTagChanges,
	executeTagSync,
	selectTagMode,
	TAG_MODE_LABELS,
	type TagSyncItem,
	type TagSyncMode,
	type TagSyncSummary,
} from '../helpers/sync-tags.js';
import { exportTagSyncToXlsx } from '../sync-tags/xlsx.js';
import { fetchEppoFlags } from './api.js';
import { datadogIdForEppoFlag, selectFlags } from './migrate.js';
import type { EppoFlag } from './types.js';

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.eppo} />);
}

/**
 * Resolve an Eppo flag to its matching Datadog flag for tag sync. Eppo flags
 * are matched by key (or by the recorded source-id lookup key). Flags without
 * a Datadog match are skipped — tags can only be synced onto existing flags.
 */
export function resolveEppoTagSyncItem(
	flag: EppoFlag,
	datadogKeys: Map<string, string>,
): { item: TagSyncItem } | { skip: string } {
	const datadogFlagId = datadogIdForEppoFlag(flag, datadogKeys);
	if (!datadogFlagId) {
		return { skip: 'no matching flag exists in Datadog yet' };
	}
	// datadogIdForEppoFlag resolves via flag.key or the source-id lookup key;
	// recover the Datadog key for reporting.
	const datadogKey =
		datadogKeys.get(flag.key) ??
		datadogKeys.get(eppoSourceIdLookupKey(String(flag.id))) ??
		flag.key;
	return {
		item: {
			sourceKey: flag.key,
			datadogKey,
			datadogFlagId,
			sourceTags: flag.tag_names ?? [],
		},
	};
}

export interface EppoTagMigrationNonInteractiveOptions {
	flagKeys: string[];
	tagMode: TagSyncMode;
}

export interface RunEppoTagMigrationOptions {
	nonInteractive?: EppoTagMigrationNonInteractiveOptions;
	tagMode?: TagSyncMode;
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function runTagSync(
	items: TagSyncItem[],
	skipped: Array<{ sourceKey: string; reason: string }>,
	mode: TagSyncMode,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	nonInteractive: boolean,
): Promise<TagSyncSummary> {
	const progress = createSpinner(
		`Syncing tags for ${items.length} flag(s)… (0/${items.length})`,
	).start();

	const summary = await executeTagSync(
		items,
		mode,
		ddApiKey,
		ddAppKey,
		ddSite,
		dryRun,
		{
			nonInteractive,
			onProgress: (index, total, item) => {
				progress.text = `Syncing tags for ${chalk.cyan(item.sourceKey)} (${index}/${total})…`;
			},
		},
	);
	summary.skippedFlags = skipped;
	summary.skipped = skipped.length;

	const changed = summary.synced;
	const unchanged = summary.unchanged;
	const failed = summary.failed;
	const skippedCount = summary.skipped;

	if (failed > 0) {
		progress.warn(
			`Tag sync finished with ${failed} failed: ${changed} synced, ${unchanged} unchanged, ${skippedCount} skipped`,
		);
	} else {
		progress.succeed(
			`Tag sync complete: ${changed} synced, ${unchanged} unchanged, ${skippedCount} skipped (${TAG_MODE_LABELS[mode]}${dryRun ? ', dry run' : ''})`,
		);
	}
	return summary;
}

function resolveEppoItems(
	flags: EppoFlag[],
	datadogKeys: Map<string, string>,
): {
	items: TagSyncItem[];
	skipped: Array<{ sourceKey: string; reason: string }>;
} {
	const items: TagSyncItem[] = [];
	const skipped: Array<{ sourceKey: string; reason: string }> = [];
	for (const flag of flags) {
		const result = resolveEppoTagSyncItem(flag, datadogKeys);
		if ('item' in result) items.push(result.item);
		else skipped.push({ sourceKey: flag.key, reason: result.skip });
	}
	return { items, skipped };
}

function printTagSyncDetails(summary: TagSyncSummary): void {
	console.log();
	for (const outcome of summary.results) {
		const label =
			outcome.status === 'synced'
				? summary.dryRun
					? chalk.dim('[dry run]') +
						` Would sync ${chalk.cyan(outcome.sourceKey)}`
					: `${chalk.green('✓')} Synced ${chalk.cyan(outcome.sourceKey)}`
				: outcome.status === 'unchanged'
					? `${chalk.gray('•')} ${chalk.cyan(outcome.sourceKey)} — already in sync`
					: `${chalk.red('✗')} Failed ${chalk.cyan(outcome.sourceKey)}`;
		const changes =
			outcome.status === 'failed'
				? chalk.red(`: ${outcome.error ?? 'unknown error'}`)
				: outcome.status === 'unchanged'
					? ''
					: `  ${describeTagChanges(outcome)}`;
		console.log(`  ${label}${changes}`);
	}
	for (const skip of summary.skippedFlags) {
		console.log(
			`  ${chalk.yellow('↷')} Skipped ${chalk.cyan(skip.sourceKey)} — ${chalk.gray(skip.reason)}`,
		);
	}
}

// ─── Interactive Entry Point ─────────────────────────────────────────────────

export async function runEppoTagMigration(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	options?: RunEppoTagMigrationOptions,
): Promise<void> {
	// EPPO_API_KEY presence was validated upstream.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const apiKey = process.env.EPPO_API_KEY!.trim();

	if (options?.nonInteractive) {
		await runEppoTagMigrationNonInteractive(
			apiKey,
			ddApiKey,
			ddAppKey,
			ddSite,
			dryRun,
			options.nonInteractive,
		);
		return;
	}

	clearScreen();
	await printHeader();
	if (dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no tags will be changed\n'),
		);
	}

	const spinner = createSpinner('Loading data…').start();
	let flags: EppoFlag[];
	let datadogKeys: Map<string, string> = new Map();
	try {
		[flags, datadogKeys] = await Promise.all([
			fetchEppoFlags(apiKey, {
				onProgress: (fetched) => {
					spinner.text = `Loading data… (${fetched} Eppo flag${fetched === 1 ? '' : 's'} fetched)`;
				},
			}),
			fetchDatadogFlagKeys(ddApiKey, ddAppKey, ddSite),
		]);
		spinner.succeed(
			`Loaded ${flags.length} Eppo flag(s) · ${datadogKeys.size} Datadog flag(s)`,
		);
	} catch (err) {
		spinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		return;
	}

	if (flags.length === 0) {
		console.log(chalk.yellow('\n  No flags found in Eppo.\n'));
		return;
	}

	// eslint-disable-next-line no-constant-condition
	while (true) {
		clearScreen();
		await printHeader();
		// Tags are flag-level, so no environment selection is needed; pass an
		// empty environment list so all flags are visible.
		const flagResult = await selectFlags(flags, datadogKeys, []);
		if (flagResult === null) break;

		if (flagResult.length === 0) {
			console.log(chalk.yellow('\nNo flags selected — nothing to sync.'));
			continue;
		}

		const mode = options?.tagMode ?? (await selectTagMode());

		const { items, skipped } = resolveEppoItems(flagResult, datadogKeys);

		console.log();
		console.log(
			chalk.bold(
				`Syncing tags for ${chalk.green(String(items.length))} flag(s)`,
			) +
				(skipped.length > 0
					? chalk.gray(` · ${skipped.length} skipped (no Datadog match)`)
					: '') +
				chalk.gray(` · ${TAG_MODE_LABELS[mode]}`),
		);
		console.log();

		const shouldContinue = await confirm({
			message: dryRun
				? `Preview tag sync for ${items.length} flag(s)?`
				: `Sync tags for ${items.length} flag(s)?`,
			default: true,
		});
		if (!shouldContinue) {
			console.log(chalk.yellow('\nTag sync cancelled.'));
			continue;
		}

		const summary = await runTagSync(
			items,
			skipped,
			mode,
			ddApiKey,
			ddAppKey,
			ddSite,
			dryRun,
			false,
		);
		printTagSyncDetails(summary);
		await exportTagSyncToXlsx(summary);

		const action = await select<'sync-more' | 'done'>({
			message: 'What would you like to do?',
			choices: [
				{ name: 'Select more flags', value: 'sync-more' },
				{ name: 'Done', value: 'done' },
			],
		});
		if (action === 'done') break;
	}
}

// ─── Non-Interactive Entry Point ─────────────────────────────────────────────

async function runEppoTagMigrationNonInteractive(
	apiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	ni: EppoTagMigrationNonInteractiveOptions,
): Promise<void> {
	console.log(chalk.gray('  Running in non-interactive mode'));
	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run mode — no tags will be changed'));
	}
	console.log();

	const spinner = createSpinner('Loading data…').start();
	let flags: EppoFlag[];
	let datadogKeys: Map<string, string> = new Map();
	try {
		[flags, datadogKeys] = await Promise.all([
			fetchEppoFlags(apiKey, {
				onProgress: (fetched) => {
					spinner.text = `Loading data… (${fetched} Eppo flag${fetched === 1 ? '' : 's'} fetched)`;
				},
			}),
			fetchDatadogFlagKeys(ddApiKey, ddAppKey, ddSite),
		]);
		spinner.succeed(
			`Loaded ${flags.length} Eppo flag(s) · ${datadogKeys.size} Datadog flag(s)`,
		);
	} catch (err) {
		spinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		process.exit(1);
	}

	const byKey = new Map(flags.map((f) => [f.key, f]));
	const selectedFlags: EppoFlag[] = [];
	const missing: string[] = [];
	for (const key of ni.flagKeys) {
		const f = byKey.get(key);
		if (f) selectedFlags.push(f);
		else missing.push(key);
	}
	if (missing.length > 0) {
		console.error(
			chalk.red(`\n  Flag(s) not found in Eppo: ${missing.join(', ')}\n`),
		);
		process.exit(1);
	}

	const { items, skipped } = resolveEppoItems(selectedFlags, datadogKeys);

	const summary = await runTagSync(
		items,
		skipped,
		ni.tagMode,
		ddApiKey,
		ddAppKey,
		ddSite,
		dryRun,
		true,
	);

	const exportPath = await exportTagSyncToXlsx(summary);

	writeJsonOutput({
		provider: 'eppo',
		exportPath,
		mode: summary.mode,
		dryRun: summary.dryRun,
		summary: {
			synced: summary.synced,
			unchanged: summary.unchanged,
			failed: summary.failed,
			skipped: summary.skipped,
		},
		results: summary.results,
		skippedFlags: summary.skippedFlags,
	});

	if (summary.failed > 0) process.exitCode = 1;
}
