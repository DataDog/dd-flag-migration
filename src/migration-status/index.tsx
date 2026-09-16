import { resolve } from 'node:path';
import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import { renderStatic } from '../components/mount.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import {
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogStatusFlagDetail,
	listSavedFilters,
} from '../datadog/api.js';
import type {
	DatadogStatusFlagDetail,
	EnvironmentMapping,
	SavedFilterSummary,
} from '../datadog/types.js';
import { mapWithConcurrency } from '../helpers/concurrency.js';
import {
	fetchFlag,
	fetchFlags,
	fetchProjectEnvironments,
	fetchProjects,
} from '../launchdarkly/api.js';
import {
	linkEnvironments,
	selectLDEnvironments,
	selectProject,
} from '../launchdarkly/migrate.js';
import type { LDFlag } from '../launchdarkly/types.js';
import { compareMigrationStatus, linkLaunchDarklyFlags } from './comparison.js';
import type { MigrationStatusResult } from './types.js';
import {
	flagStatusLabel,
	migrationStatusCounts,
	writeMigrationStatusWorkbook,
} from './xlsx.js';

const DETAIL_CONCURRENCY = 2;

export async function runMigrationStatusWorkflow(
	ldApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
): Promise<string | null> {
	clearScreen();
	await printHeader();

	const projects = await withProgress(
		'Fetching LaunchDarkly projects…',
		() => fetchProjects(ldApiKey),
		(items) => `Found ${items.length} LaunchDarkly project(s)`,
	);
	if (projects.length === 0) {
		console.log(chalk.yellow('No LaunchDarkly projects were found.'));
		return null;
	}
	const project = await selectProject(
		projects,
		'Select a LaunchDarkly project to analyze:',
	);
	if (!project) return null;

	const [sourceFlags, sourceEnvironments, datadogFlags, datadogEnvironments] =
		await withProgress(
			'Loading LaunchDarkly and Datadog inventories…',
			() =>
				Promise.all([
					fetchFlags(ldApiKey, project.key),
					fetchProjectEnvironments(ldApiKey, project.key),
					fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
					fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
				]),
			([flags, environments, ddFlags, ddEnvironments]) =>
				`Loaded ${flags.length} LaunchDarkly flag(s), ${environments.length} LaunchDarkly environment(s), ${ddFlags.length} Datadog flag(s), and ${ddEnvironments.length} Datadog environment(s)`,
		);
	const activeFlags = sourceFlags.filter((flag) => !flag.archived);
	if (activeFlags.length === 0) {
		console.log(chalk.yellow('No active LaunchDarkly flags were found.'));
		return null;
	}
	if (!sourceEnvironments.some((environment) => !environment.archived)) {
		console.log(
			chalk.yellow('No active LaunchDarkly environments were found.'),
		);
		return null;
	}
	if (datadogEnvironments.length === 0) {
		console.log(chalk.yellow('No Datadog environments were found.'));
		return null;
	}

	let selectedEnvironments = await selectLDEnvironments(
		sourceEnvironments,
		[],
		'Select LaunchDarkly environments to analyze:',
	);
	while (selectedEnvironments?.length === 0) {
		console.log(chalk.yellow('Please select at least one environment.'));
		selectedEnvironments = await selectLDEnvironments(
			sourceEnvironments,
			[],
			'Select LaunchDarkly environments to analyze:',
		);
	}
	if (!selectedEnvironments) return null;

	const environmentMapping = await linkEnvironments(
		selectedEnvironments,
		datadogEnvironments,
		new Map(),
	);
	if (!environmentMapping) return null;

	clearScreen();
	await printHeader();
	printScope(project.name, selectedEnvironments, environmentMapping);
	if (
		!(await confirm({
			message: 'Generate migration status for this scope?',
			default: true,
		}))
	) {
		return null;
	}

	const links = linkLaunchDarklyFlags(activeFlags, datadogFlags, project.key);
	const linked = links.filter(
		(
			link,
		): link is typeof link & { datadog: NonNullable<typeof link.datadog> } =>
			link.datadog !== undefined,
	);
	const sourceDetailErrors = new Map<string, string>();
	const detailedSourceFlags = new Map<string, LDFlag>();
	await loadDetails(
		`Loading ${linked.length} migrated LaunchDarkly flag detail(s)…`,
		linked,
		async (link) => {
			try {
				const detail = link.source.environments
					? link.source
					: await fetchFlag(ldApiKey, project.key, link.source.key);
				detailedSourceFlags.set(link.source.key, detail);
			} catch (error) {
				sourceDetailErrors.set(link.source.key, errorMessage(error));
			}
		},
	);

	const datadogDetails = new Map<string, DatadogStatusFlagDetail>();
	const datadogDetailErrors = new Map<string, string>();
	await loadDetails(
		`Loading ${linked.length} migrated Datadog flag detail(s)…`,
		linked,
		async (link) => {
			try {
				datadogDetails.set(
					link.datadog.id,
					await fetchDatadogStatusFlagDetail(
						ddApiKey,
						ddAppKey,
						link.datadog.id,
						ddSite,
					),
				);
			} catch (error) {
				datadogDetailErrors.set(link.datadog.id, errorMessage(error));
			}
		},
	);

	const detailedFlags = activeFlags.map(
		(flag) => detailedSourceFlags.get(flag.key) ?? flag,
	);
	let savedFilterLookup = new Map<string, string>();
	if (
		hasSelectedSegmentReferences(
			detailedFlags,
			selectedEnvironments.map((environment) => environment.key),
		)
	) {
		try {
			savedFilterLookup = await loadSavedFilterLookup(
				ddApiKey,
				ddAppKey,
				ddSite,
				project.key,
			);
		} catch (error) {
			console.warn(
				chalk.yellow(
					`Could not load saved-filter references: ${errorMessage(error)}`,
				),
			);
		}
	}

	const result = compareMigrationStatus({
		projectKey: project.key,
		projectName: project.name,
		sourceFlags: detailedFlags,
		sourceDetailErrors,
		datadogFlags,
		datadogDetails,
		datadogDetailErrors,
		selectedSourceEnvironments: selectedEnvironments,
		environmentMapping,
		savedFilterLookup,
	});
	printSummary(result);

	const timestamp = result.generatedAt.toISOString().replace(/[:.]/g, '-');
	const safeProjectKey = project.key.replace(/[^a-zA-Z0-9._-]/g, '_');
	const output = resolve(
		process.cwd(),
		`migration-status-launchdarkly-${safeProjectKey}-${timestamp}.xlsx`,
	);
	const path = await withProgress(
		'Writing migration status workbook…',
		() => writeMigrationStatusWorkbook(result, output),
		(filepath) => `Wrote migration status workbook to ${filepath}`,
	);
	console.log(chalk.green(`\nReport written to ${path}\n`));
	return path;
}

async function loadDetails<T>(
	label: string,
	items: T[],
	loader: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	const progress = createSpinner(label).start();
	let completed = 0;
	try {
		await mapWithConcurrency(items, DETAIL_CONCURRENCY, async (item) => {
			await loader(item);
			completed++;
			progress.text = `${label.replace(/…$/, '')} (${completed}/${items.length})…`;
		});
		progress.succeed(`Loaded ${items.length} flag detail(s)`);
	} catch (error) {
		progress.fail(label);
		throw error;
	}
}

async function loadSavedFilterLookup(
	apiKey: string,
	appKey: string,
	site: string,
	projectKey: string,
): Promise<Map<string, string>> {
	const filters = await withProgress(
		'Loading migrated Datadog saved filters…',
		async () => {
			const all: SavedFilterSummary[] = [];
			let offset = 0;
			while (true) {
				const page = await listSavedFilters(apiKey, appKey, { offset }, site);
				all.push(...page.data);
				if (all.length >= page.total || page.data.length === 0) break;
				offset += page.data.length;
			}
			return all;
		},
		(filters) => `Loaded ${filters.length} Datadog saved filter(s)`,
	);
	return new Map(
		filters.flatMap((filter) => {
			const metadata = filter.migration_metadata;
			if (
				metadata?.provider !== 'launchdarkly' ||
				metadata.project_key !== projectKey
			) {
				return [];
			}
			return [
				[
					`${metadata.segment_key}:${metadata.environment_key}:${metadata.negated}`,
					filter.id,
				] as [string, string],
			];
		}),
	);
}

function hasSelectedSegmentReferences(
	flags: LDFlag[],
	environmentKeys: string[],
): boolean {
	return flags.some((flag) =>
		environmentKeys.some((environmentKey) =>
			(flag.environments?.[environmentKey]?.rules ?? []).some((rule) =>
				rule.clauses.some((clause) => clause.op === 'segmentMatch'),
			),
		),
	);
}

function printScope(
	projectName: string,
	sourceEnvironments: Array<{ key: string; name: string }>,
	mapping: EnvironmentMapping<string>,
): void {
	console.log(chalk.bold(`Project: ${projectName}\n`));
	console.log(chalk.bold('Analysis scope:'));
	for (const source of sourceEnvironments) {
		for (const datadog of mapping.get(source.key) ?? []) {
			console.log(
				`  ${chalk.cyan(source.name)} → ${chalk.green(datadog.name)}`,
			);
		}
	}
	console.log();
}

function printSummary(result: MigrationStatusResult): void {
	const counts = migrationStatusCounts(result);
	console.log();
	console.log(chalk.bold(`Migration status for ${result.projectName}\n`));
	for (const status of [
		'not-yet-migrated',
		'partially-migrated',
		'out-of-sync',
		'in-sync',
		'needs-review',
	] as const) {
		const count = String(counts[status]).padStart(6);
		const label = flagStatusLabel(status);
		const color =
			status === 'in-sync'
				? chalk.green
				: status === 'not-yet-migrated'
					? chalk.gray
					: status === 'needs-review'
						? chalk.yellow
						: chalk.cyan;
		console.log(`${color(count)}  ${label}`);
	}
	console.log();
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.migrationStatus} />);
}

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function withProgress<T>(
	loading: string,
	action: () => Promise<T>,
	success: (value: T) => string,
): Promise<T> {
	const progress = createSpinner(loading).start();
	try {
		const value = await action();
		progress.succeed(success(value));
		return value;
	} catch (error) {
		progress.fail(loading);
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
