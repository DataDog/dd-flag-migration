import { resolve } from 'node:path';
import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import { renderStatic } from '../components/mount.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import {
	fetchAllSavedFilters,
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogStatusFlagDetail,
} from '../datadog/api.js';
import type { DatadogOrgConnection, DatadogOrgPair } from '../datadog/orgs.js';
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogStatusFlagDetail,
	EnvironmentMapping,
} from '../datadog/types.js';
import {
	linkDatadogEnvironments,
	selectSourceEnvironments,
} from '../datadog-migration/environments.js';
import { mapWithConcurrency } from '../helpers/concurrency.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import {
	compareOrgs,
	hasSavedFilterReferences,
	linkOrgFlags,
	linkSavedFilters,
} from './comparison.js';
import type { OrgDiffEnvironmentPair, OrgDiffResult } from './types.js';
import {
	orgDiffCounts,
	orgDiffStatusLabel,
	orgDiffStatusOrder,
	writeOrgDiffWorkbook,
} from './xlsx.js';

const DETAIL_CONCURRENCY = 2;

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.orgDiff} />);
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

async function loadDetails(
	org: DatadogOrgConnection,
	flags: DatadogFlagEntry[],
): Promise<{
	details: Map<string, DatadogStatusFlagDetail>;
	errors: Map<string, string>;
}> {
	const details = new Map<string, DatadogStatusFlagDetail>();
	const errors = new Map<string, string>();
	if (flags.length === 0) return { details, errors };
	const label = `Loading ${flags.length} ${org.role} org flag detail(s)`;
	const progress = createSpinner(`${label}…`).start();
	let completed = 0;
	await mapWithConcurrency(flags, DETAIL_CONCURRENCY, async (flag) => {
		try {
			details.set(
				flag.id,
				await fetchDatadogStatusFlagDetail(
					org.apiKey,
					org.appKey,
					flag.id,
					org.site,
				),
			);
		} catch (error) {
			errors.set(flag.id, formatAxiosError(error));
		}
		completed++;
		progress.text = `${label} (${completed}/${flags.length})…`;
	});
	progress.succeed(`Loaded ${details.size} ${org.role} org flag detail(s)`);
	return { details, errors };
}

function environmentPairs(
	mapping: EnvironmentMapping<string>,
	sourceEnvironments: DatadogEnvironment[],
): OrgDiffEnvironmentPair[] {
	return sourceEnvironments.flatMap((source) =>
		(mapping.get(source.id) ?? []).map((target) => ({
			sourceEnvironmentId: source.id,
			sourceEnvironmentName: source.name,
			targetEnvironmentId: target.id,
			targetEnvironmentName: target.name,
		})),
	);
}

function printScope(pair: DatadogOrgPair, pairs: OrgDiffEnvironmentPair[]) {
	console.log(
		chalk.bold('Source org: ') +
			chalk.cyan(pair.source.site) +
			chalk.bold('   Target org: ') +
			chalk.green(pair.target.site),
	);
	console.log();
	console.log(chalk.bold('Environment pairs:'));
	for (const environment of pairs) {
		console.log(
			`  ${chalk.cyan(environment.sourceEnvironmentName)} ↔ ${chalk.green(environment.targetEnvironmentName)}`,
		);
	}
	console.log();
}

function printSummary(result: OrgDiffResult): void {
	const counts = orgDiffCounts(result);
	console.log();
	console.log(
		chalk.bold(
			`Configuration diff for ${result.flags.length} flag(s) across both orgs\n`,
		),
	);
	for (const status of orgDiffStatusOrder()) {
		const count = String(counts[status]).padStart(6);
		const color =
			status === 'in-sync'
				? chalk.green
				: status === 'needs-review'
					? chalk.yellow
					: status === 'differs'
						? chalk.cyan
						: chalk.gray;
		console.log(`${color(count)}  ${orgDiffStatusLabel(status)}`);
	}
	console.log();
}

function safeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Interactive, read-only comparison of flag configuration in two orgs. */
export async function runOrgDiffWorkflow(
	pair: DatadogOrgPair,
): Promise<string | null> {
	const { source, target } = pair;
	clearScreen();
	await printHeader();

	const [sourceFlags, sourceEnvironments, targetFlags, targetEnvironments] =
		await withProgress(
			'Loading flags and environments from both orgs…',
			() =>
				Promise.all([
					fetchDatadogFlags(source.apiKey, source.appKey, source.site),
					fetchDatadogEnvironments(source.apiKey, source.appKey, source.site),
					fetchDatadogFlags(target.apiKey, target.appKey, target.site),
					fetchDatadogEnvironments(target.apiKey, target.appKey, target.site),
				]),
			([sFlags, sEnvs, tFlags, tEnvs]) =>
				`Loaded ${sFlags.length} source flag(s), ${sEnvs.length} source environment(s), ${tFlags.length} target flag(s), and ${tEnvs.length} target environment(s)`,
		);
	if (sourceEnvironments.length === 0 || targetEnvironments.length === 0) {
		console.log(
			chalk.yellow('Both orgs need at least one feature flag environment.'),
		);
		return null;
	}

	let selectedEnvironments = await selectSourceEnvironments(
		sourceEnvironments,
		[],
		'Select source org environments to compare:',
	);
	while (selectedEnvironments?.length === 0) {
		console.log(chalk.yellow('Please select at least one environment.'));
		selectedEnvironments = await selectSourceEnvironments(
			sourceEnvironments,
			[],
			'Select source org environments to compare:',
		);
	}
	if (!selectedEnvironments) return null;

	const mapping = await linkDatadogEnvironments(
		selectedEnvironments,
		targetEnvironments,
		new Map(),
		printHeader,
	);
	if (!mapping) return null;
	const pairs = environmentPairs(mapping, selectedEnvironments);

	clearScreen();
	await printHeader();
	printScope(pair, pairs);
	if (
		!(await confirm({
			message: 'Compare flag configuration for these environment pairs?',
			default: true,
		}))
	) {
		return null;
	}

	const links = linkOrgFlags(sourceFlags, targetFlags);
	const linked = links.filter((link) => link.source && link.target);
	const sourceLoad = await loadDetails(
		source,
		linked.flatMap((link) => (link.source ? [link.source] : [])),
	);
	const targetLoad = await loadDetails(
		target,
		linked.flatMap((link) => (link.target ? [link.target] : [])),
	);

	let savedFilterLinks = new Map<string, string>();
	const sourceEnvironmentIds = new Set(pairs.map((p) => p.sourceEnvironmentId));
	const targetEnvironmentIds = new Set(pairs.map((p) => p.targetEnvironmentId));
	if (
		hasSavedFilterReferences(
			sourceLoad.details.values(),
			sourceEnvironmentIds,
		) ||
		hasSavedFilterReferences(targetLoad.details.values(), targetEnvironmentIds)
	) {
		try {
			const [sourceFilters, targetFilters] = await withProgress(
				'Loading saved filters from both orgs…',
				() =>
					Promise.all([
						fetchAllSavedFilters(
							source.apiKey,
							source.appKey,
							{ include_archived: true },
							source.site,
						),
						fetchAllSavedFilters(
							target.apiKey,
							target.appKey,
							{ include_archived: true },
							target.site,
						),
					]),
				([sFilters, tFilters]) =>
					`Loaded ${sFilters.length} source and ${tFilters.length} target saved filter(s)`,
			);
			savedFilterLinks = linkSavedFilters(sourceFilters, targetFilters);
		} catch (error) {
			console.warn(
				chalk.yellow(
					`Could not load saved filters: ${formatAxiosError(error)}. Targeting that references saved filters will show as different.`,
				),
			);
		}
	}

	const result = compareOrgs({
		sourceSite: source.site,
		targetSite: target.site,
		sourceFlags,
		targetFlags,
		sourceDetails: sourceLoad.details,
		targetDetails: targetLoad.details,
		sourceDetailErrors: sourceLoad.errors,
		targetDetailErrors: targetLoad.errors,
		environmentPairs: pairs,
		savedFilterLinks,
	});
	printSummary(result);

	const timestamp = result.generatedAt.toISOString().replace(/[:.]/g, '-');
	const output = resolve(
		process.cwd(),
		`org-diff-${safeFilePart(source.site)}-${safeFilePart(target.site)}-${timestamp}.xlsx`,
	);
	const path = await withProgress(
		'Writing org diff workbook…',
		() => writeOrgDiffWorkbook(result, output),
		(filepath) => `Wrote org diff workbook to ${filepath}`,
	);
	console.log(chalk.green(`\nReport written to ${path}\n`));
	return path;
}
