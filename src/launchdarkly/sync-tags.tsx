import axios from 'axios';
import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import { renderStatic } from '../components/mount.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import { fetchDatadogFlags } from '../datadog/api.js';
import type { DatadogFlagEntry } from '../datadog/types.js';
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
import {
	fetchFlags,
	fetchFlagsByKey,
	fetchProjects,
	type LDProject,
} from './api.js';
import { classifyConflict, selectFlags, selectProject } from './migrate.js';
import type { LDFlag } from './types.js';

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.launchdarkly} />);
}

/**
 * Build the source-derived tag list for a LaunchDarkly flag: the flag's own LD
 * tags plus the `project:<key>` migration-link tag. Team tags (derived from the
 * RBAC editor-team walk in the full `migrate` command) are intentionally not
 * included here — they belong to the restriction-policy flow, not tag sync.
 */
export function buildLdTagSourceSet(
	flagTags: string[],
	projectKey: string,
): string[] {
	return [...new Set([...flagTags, `project:${projectKey}`])];
}

/**
 * Resolve a LaunchDarkly flag to its matching Datadog flag for tag sync. Only
 * flags that already exist in Datadog (same-project migration metadata match,
 * or a manual match on key) can have their tags synced; everything else is
 * skipped with a reason.
 */
export function resolveLdTagSyncItem(
	flag: LDFlag,
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
): { item: TagSyncItem } | { skip: string } {
	const conflict = classifyConflict(datadogFlags, projectKey, flag.key);
	if (conflict.type !== 'same_project' && conflict.type !== 'manual') {
		return {
			skip:
				conflict.type === 'cross_project'
					? `Datadog flag key "${flag.key}" belongs to a different LaunchDarkly project`
					: 'no matching flag exists in Datadog yet',
		};
	}
	const existing = conflict.existingFlag;
	if (!existing) return { skip: 'no matching flag exists in Datadog yet' };

	return {
		item: {
			sourceKey: flag.key,
			datadogKey: existing.key,
			datadogFlagId: existing.id,
			sourceTags: buildLdTagSourceSet(flag.tags, projectKey),
		},
	};
}

export interface LDTagMigrationNonInteractiveOptions {
	projectKey: string;
	flagKeys: string[];
	tagMode: TagSyncMode;
}

export interface RunLaunchDarklyTagMigrationOptions {
	nonInteractive?: LDTagMigrationNonInteractiveOptions;
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

// ─── Interactive Entry Point ─────────────────────────────────────────────────

export async function runLaunchDarklyTagMigration(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	options?: RunLaunchDarklyTagMigrationOptions,
): Promise<void> {
	// LAUNCHDARKLY_API_KEY presence was validated upstream.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const ldApiKey = process.env.LAUNCHDARKLY_API_KEY!.trim();

	if (options?.nonInteractive) {
		await runLaunchDarklyTagMigrationNonInteractive(
			ldApiKey,
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

	const projectSpinner = createSpinner(
		'Fetching LaunchDarkly projects…',
	).start();
	let projects: LDProject[];
	try {
		projects = await fetchProjects(ldApiKey);
		projectSpinner.succeed(`Found ${projects.length} LaunchDarkly project(s)`);
	} catch (err) {
		projectSpinner.fail('Failed to fetch LaunchDarkly projects');
		if (axios.isAxiosError(err)) {
			const msg =
				(err.response?.data as { message?: string } | undefined)?.message ??
				err.message;
			console.error(chalk.red(`  ${msg}`));
		}
		return;
	}

	if (projects.length === 0) {
		console.log(chalk.yellow('\n  No projects found in LaunchDarkly.\n'));
		return;
	}

	const selectedProject = await selectProject(projects);
	if (!selectedProject) {
		console.log(chalk.yellow('\n  No project selected.\n'));
		return;
	}

	console.log();
	console.log(
		chalk.bold('Project: ') +
			chalk.green(selectedProject.name) +
			chalk.gray(` (${selectedProject.key})`),
	);

	const loadSpinner = createSpinner('Fetching flags and Datadog data…').start();
	let allFlags: LDFlag[];
	let datadogFlags: DatadogFlagEntry[] = [];
	try {
		[allFlags, datadogFlags] = await Promise.all([
			fetchFlags(ldApiKey, selectedProject.key),
			fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
		]);
		loadSpinner.succeed(
			`Loaded ${allFlags.length} LD flag(s) · ${datadogFlags.length} Datadog flag(s)`,
		);
	} catch (err) {
		loadSpinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		return;
	}

	if (allFlags.length === 0) {
		console.log(chalk.yellow('\n  No flags found in this project.\n'));
		return;
	}

	// eslint-disable-next-line no-constant-condition
	while (true) {
		clearScreen();
		await printHeader();
		const flagResult = await selectFlags(
			allFlags,
			datadogFlags,
			selectedProject.key,
		);
		if (flagResult === null) break;

		if (flagResult.length === 0) {
			console.log(chalk.yellow('\nNo flags selected — nothing to sync.'));
			continue;
		}

		const mode = options?.tagMode ?? (await selectTagMode());

		const { items, skipped } = resolveLdItems(
			flagResult,
			datadogFlags,
			selectedProject.key,
		);

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

function resolveLdItems(
	flags: LDFlag[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
): {
	items: TagSyncItem[];
	skipped: Array<{ sourceKey: string; reason: string }>;
} {
	const items: TagSyncItem[] = [];
	const skipped: Array<{ sourceKey: string; reason: string }> = [];
	for (const flag of flags) {
		const result = resolveLdTagSyncItem(flag, datadogFlags, projectKey);
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

// ─── Non-Interactive Entry Point ─────────────────────────────────────────────

async function runLaunchDarklyTagMigrationNonInteractive(
	ldApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	ni: LDTagMigrationNonInteractiveOptions,
): Promise<void> {
	console.log(chalk.gray('  Running in non-interactive mode'));
	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run mode — no tags will be changed'));
	}
	console.log();

	const projectSpinner = createSpinner(
		'Fetching LaunchDarkly projects…',
	).start();
	let projects: LDProject[];
	try {
		projects = await fetchProjects(ldApiKey);
		projectSpinner.succeed(`Found ${projects.length} LaunchDarkly project(s)`);
	} catch (err) {
		projectSpinner.fail('Failed to fetch LaunchDarkly projects');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		process.exit(1);
	}

	const selectedProject = projects.find((p) => p.key === ni.projectKey);
	if (!selectedProject) {
		console.error(
			chalk.red(
				`\n  LaunchDarkly project not found: "${ni.projectKey}"\n` +
					`  Available: ${projects.map((p) => p.key).join(', ')}\n`,
			),
		);
		process.exit(1);
	}

	console.log(
		chalk.bold('  Project: ') +
			chalk.green(selectedProject.name) +
			chalk.gray(` (${selectedProject.key})`),
	);

	const loadSpinner = createSpinner(
		`Fetching ${ni.flagKeys.length} flag(s) and Datadog data…`,
	).start();
	let selectedFlags: LDFlag[];
	let datadogFlags: DatadogFlagEntry[] = [];
	try {
		[selectedFlags, datadogFlags] = await Promise.all([
			fetchFlagsByKey(ldApiKey, selectedProject.key, ni.flagKeys),
			fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
		]);
		loadSpinner.succeed(
			`Loaded ${selectedFlags.length} LD flag(s) · ${datadogFlags.length} Datadog flag(s)`,
		);
	} catch (err) {
		loadSpinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		process.exit(1);
	}

	const { items, skipped } = resolveLdItems(
		selectedFlags,
		datadogFlags,
		selectedProject.key,
	);

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
		provider: 'launchdarkly',
		exportPath,
		projectKey: selectedProject.key,
		projectName: selectedProject.name,
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
