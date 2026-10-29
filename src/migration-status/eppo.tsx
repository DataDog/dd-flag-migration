import { resolve } from 'node:path';
import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { HEADER_SUBTITLES } from '../components/Header.js';
import {
	fetchAllSavedFilters,
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogStatusFlagDetail,
} from '../datadog/api.js';
import type {
	DatadogStatusFlagDetail,
	SavedFilterSummary,
} from '../datadog/types.js';
import {
	extractEnvironments,
	fetchEppoAudiences,
	fetchEppoFlag,
	fetchEppoFlags,
} from '../eppo/api.js';
import { fingerprintConditions } from '../eppo/helpers/migration.js';
import {
	linkEnvironments,
	selectEnvironments,
	selectFlags,
} from '../eppo/migrate.js';
import type { EppoAudience, EppoFlag } from '../eppo/types.js';
import {
	compareEppoMigrationStatus,
	linkEppoFlags,
} from './eppo-comparison.js';
import {
	clearScreen,
	errorMessage,
	loadDetails,
	printHeader,
	printSummary,
	withProgress,
} from './index.js';
import { writeMigrationStatusWorkbook } from './xlsx.js';

/** Read-only: all remote calls in this workflow are inventory/detail GETs. */
export async function runEppoMigrationStatusWorkflow(
	eppoApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
): Promise<string | null> {
	clearScreen();
	await printHeader();
	const [inventory, datadogFlags, datadogEnvironments] = await withProgress(
		'Loading Eppo and Datadog inventories…',
		() =>
			Promise.all([
				fetchEppoFlags(eppoApiKey),
				fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
				fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
			]),
		([flags, ddFlags, environments]) =>
			`Loaded ${flags.length} Eppo flag(s), ${ddFlags.length} Datadog flag(s), and ${environments.length} Datadog environment(s)`,
	);
	const sourceFlags = inventory.filter(
		(flag) => !flag.type || flag.type === 'FEATURE_FLAG',
	);
	const environments = extractEnvironments(sourceFlags);
	if (
		!sourceFlags.length ||
		!environments.length ||
		!datadogEnvironments.length
	) {
		console.log(
			chalk.yellow(
				'No Eppo feature flags, Eppo environments, or Datadog environments were found to compare.',
			),
		);
		return null;
	}
	let selectedEnvironments = await selectEnvironments(
		sourceFlags,
		environments,
		[],
		'Select Eppo environments to analyze:',
	);
	while (selectedEnvironments?.length === 0) {
		console.log(chalk.yellow('Please select at least one environment.'));
		selectedEnvironments = await selectEnvironments(
			sourceFlags,
			environments,
			[],
			'Select Eppo environments to analyze:',
		);
	}
	if (!selectedEnvironments) return null;
	const environmentMapping = await linkEnvironments(
		selectedEnvironments,
		datadogEnvironments,
		new Map(),
		HEADER_SUBTITLES.migrationStatus,
	);
	if (!environmentMapping) return null;

	const datadogKeys = new Map(
		linkEppoFlags(sourceFlags, datadogFlags).flatMap((link) =>
			link.datadog && !link.identityProblem
				? [[link.source.key, link.datadog.id] as [string, string]]
				: [],
		),
	);
	let selectedFlags: EppoFlag[] | null = null;
	while (selectedFlags === null || selectedFlags.length === 0) {
		clearScreen();
		await printHeader();
		if (selectedFlags !== null)
			console.log(chalk.yellow('Please select at least one flag.'));
		selectedFlags = await selectFlags(
			sourceFlags,
			datadogKeys,
			selectedEnvironments,
			[],
			[],
			'Select flags to check:',
		);
		if (selectedFlags === null) return null;
	}
	console.log(chalk.bold('\nAnalysis scope:'));
	for (const source of selectedEnvironments) {
		for (const target of environmentMapping.get(source.id) ?? []) {
			console.log(`  ${chalk.cyan(source.name)} → ${chalk.green(target.name)}`);
		}
	}
	console.log(chalk.bold(`Flags: ${selectedFlags.length}\n`));
	if (
		!(await confirm({
			message: 'Generate migration status for this scope?',
			default: true,
		}))
	)
		return null;

	const sourceDetailErrors = new Map<string, string>();
	const sourceDetails = new Map<string, EppoFlag>();
	await loadDetails(
		'Loading Eppo flag details…',
		selectedFlags.filter(
			(flag) => !flag.variations || !flag.environments || !flag.allocations,
		),
		async (flag) => {
			try {
				sourceDetails.set(flag.key, await fetchEppoFlag(eppoApiKey, flag.id));
			} catch (error) {
				sourceDetailErrors.set(flag.key, errorMessage(error));
			}
		},
	);
	const detailedFlags = selectedFlags.map(
		(flag) => sourceDetails.get(flag.key) ?? flag,
	);
	const datadogDetails = new Map<string, DatadogStatusFlagDetail>();
	const datadogDetailErrors = new Map<string, string>();
	const linked = linkEppoFlags(detailedFlags, datadogFlags).flatMap((link) =>
		link.datadog && !link.identityProblem ? [link.datadog] : [],
	);
	await loadDetails(
		'Loading migrated Datadog flag details…',
		linked,
		async (flag) => {
			try {
				datadogDetails.set(
					flag.id,
					await fetchDatadogStatusFlagDetail(
						ddApiKey,
						ddAppKey,
						flag.id,
						ddSite,
					),
				);
			} catch (error) {
				datadogDetailErrors.set(flag.id, errorMessage(error));
			}
		},
	);

	let lookups = buildEppoAudienceLookups([], []);
	let audienceCollectionError: string | undefined;
	if (
		detailedFlags.some((flag) =>
			flag.allocations?.some(
				(allocation) =>
					environmentMapping.has(allocation.environment_id ?? -1) &&
					allocation.enabled !== false &&
					allocation.percent_exposure > 0 &&
					((allocation.audiences?.length ?? 0) > 0 ||
						(allocation.targeting_rules?.length ?? 0) > 0),
			),
		)
	) {
		try {
			lookups = await withProgress(
				'Loading Eppo audience references…',
				async () => {
					const [audiences, filters] = await Promise.all([
						fetchEppoAudiences(eppoApiKey),
						fetchAllSavedFilters(ddApiKey, ddAppKey, {}, ddSite),
					]);
					return buildEppoAudienceLookups(audiences, filters);
				},
				(value) =>
					`Loaded ${value.savedFilterLookup.size} migrated audience reference(s)`,
			);
		} catch (error) {
			audienceCollectionError = `Could not load Eppo audience references: ${errorMessage(error)}`;
			console.warn(chalk.yellow(audienceCollectionError));
		}
	}
	const result = compareEppoMigrationStatus({
		sourceFlags: detailedFlags,
		sourceDetailErrors,
		datadogFlags,
		datadogDetails,
		datadogDetailErrors,
		selectedSourceEnvironments: selectedEnvironments,
		environmentMapping,
		...lookups,
		audienceCollectionError,
	});
	printSummary(result);
	const timestamp = result.generatedAt.toISOString().replace(/[:.]/g, '-');
	const output = resolve(
		process.cwd(),
		`migration-status-eppo-${timestamp}.xlsx`,
	);
	const path = await withProgress(
		'Writing migration status workbook…',
		() => writeMigrationStatusWorkbook(result, output),
		(filepath) => `Wrote migration status workbook to ${filepath}`,
	);
	console.log(chalk.green(`\nReport written to ${path}\n`));
	return path;
}

/** Match the migration's explicit audience IDs and legacy inline fingerprints. */
export function buildEppoAudienceLookups(
	audiences: EppoAudience[],
	filters: SavedFilterSummary[],
): {
	savedFilterLookup: Map<number, string>;
	fingerprintLookup: Map<string, string>;
} {
	const savedFilterLookup = new Map<number, string>();
	const fingerprintLookup = new Map<string, string>();
	for (const audience of audiences.filter((item) => !item.is_archived)) {
		const matches = filters.filter(
			(filter) =>
				filter.migration_metadata?.provider === 'eppo' &&
				filter.migration_metadata.audience_id === audience.id,
		);
		if (matches.length !== 1) continue;
		const id = matches[0].id;
		savedFilterLookup.set(audience.id, id);
		for (const rule of audience.targeting_rules) {
			if (!rule.conditions.length) continue;
			const fingerprint = fingerprintConditions(rule.conditions);
			if (!fingerprintLookup.has(fingerprint))
				fingerprintLookup.set(fingerprint, id);
		}
	}
	return { savedFilterLookup, fingerprintLookup };
}
