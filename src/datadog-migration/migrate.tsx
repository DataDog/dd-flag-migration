import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
	type FilterCategory,
	MIGRATED_FILTER_ID,
	NOT_MIGRATED_FILTER_ID,
} from '../components/filter-matching.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import {
	type MigrationRunnerHandle,
	migrationRunner,
} from '../components/MigrationRunner.js';
import { MigrationSummary } from '../components/MigrationSummary.js';
import { renderStatic } from '../components/mount.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import { formatVariantLabel } from '../components/VariantCounts.js';
import {
	applyVariantDeletes,
	createFeatureFlag,
	disableFeatureFlagEnvironmentWithOutcome,
	enableFeatureFlagEnvironmentWithOutcome,
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogStatusFlagDetail,
	syncAllocationsForEnvironment,
	updateFlagDescription,
	updateFlagDistributionChannel,
	updateFlagJsonSchema,
	updateFlagName,
	updateFlagTags,
} from '../datadog/api.js';
import { resolveFlagNameForSync } from '../datadog/flag-names.js';
import type { DatadogOrgConnection, DatadogOrgPair } from '../datadog/orgs.js';
import type {
	DatadogAllocationForFlagCreation,
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogStatusFlagDetail,
	EnvironmentMapping,
	MigrationEnvironmentMapping,
	SourceVariant,
} from '../datadog/types.js';
import { mapWithConcurrency } from '../helpers/concurrency.js';
import { CONFIG_DIR } from '../helpers/config.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { toSyncRequests } from '../helpers/migration.js';
import { writeJsonOutput } from '../helpers/output.js';
import {
	resolveMigrationTargetTags,
	selectMigrationTagMode,
	type TagSyncMode,
} from '../helpers/sync-tags.js';
import {
	linkDatadogEnvironments,
	resolveDatadogEnvMap,
	selectSourceEnvironments,
} from './environments.js';
import { selectDatadogFlags } from './flag-selection.js';
import {
	buildDatadogAllocations,
	buildDatadogCreateFlagRequest,
	buildDatadogDefaultVariantKeyPerEnv,
	buildDatadogSourceVariants,
	buildDatadogVariantSyncRequests,
	type DatadogValueType,
	datadogDistributionChannel,
	datadogValueType,
	discoverSavedFilterRefs,
	findTargetFlag,
	getDatadogEnvsToDisable,
	getDatadogEnvsToEnable,
	planDatadogVariantSync,
	remapAllocationVariantKeys,
	remapDefaultVariantKeys,
	unsupportedTargetingReason,
} from './helpers/migration.js';
import {
	type DatadogSavedFilterMigrationStats,
	migrateDatadogSavedFilters,
} from './saved-filters.js';
import type { DatadogDryRunFile, DatadogMigrationFile } from './types.js';
import {
	fetchTargetVariants,
	syncDatadogVariantsCreatesAndUpdates,
} from './variants.js';

const DETAIL_CONCURRENCY = 2;

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.datadog} />);
}

function flagDisplayName(flag: DatadogFlagEntry): string {
	return flag.name ?? flag.key;
}

// ─── Prompt Steps ─────────────────────────────────────────────────────────────

const DATADOG_FILTER_CATEGORIES: FilterCategory[] = [
	{
		id: MIGRATED_FILTER_ID,
		label: 'previously-migrated',
		scope: 'flag',
		description:
			'A flag with the same key already exists in the target org (its targeting rules may still differ).',
	},
	{
		id: NOT_MIGRATED_FILTER_ID,
		label: 'not-yet-migrated',
		scope: 'flag',
		description: 'No flag with this key exists in the target org yet.',
	},
];

async function selectFlags(
	sourceFlags: DatadogFlagEntry[],
	targetFlags: DatadogFlagEntry[],
	previouslySelected: DatadogFlagEntry[],
): Promise<DatadogFlagEntry[] | null> {
	const inTarget = (flag: DatadogFlagEntry) =>
		findTargetFlag(targetFlags, flag) !== undefined;
	const inTargetCount = sourceFlags.filter(inTarget).length;

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(sourceFlags.length))} feature flags in the source org`,
		),
	);
	if (inTargetCount > 0) {
		console.log(
			chalk.gray(
				`  ${inTargetCount} flag(s) already exist in the target org and will sync if selected `,
			) + chalk.green('✓'),
		);
	}
	console.log(chalk.gray('  Type a tag (e.g. team:checkout) to filter by tag'));
	console.log();

	return selectDatadogFlags({
		message: 'Select flags to migrate to the target org:',
		choices: sourceFlags.map((flag) => ({
			value: flag,
			id: flag.id,
			key: flag.key,
			name: flagDisplayName(flag),
			tags: flag.tags ?? [],
			migrated: inTarget(flag),
			...(inTarget(flag)
				? { badge: chalk.bgGreen.black(' In target org — will sync ') }
				: {}),
		})),
		previouslySelectedIds: new Set(previouslySelected.map((flag) => flag.id)),
		filterCategories: DATADOG_FILTER_CATEGORIES,
	});
}

// ─── Detail Loading ───────────────────────────────────────────────────────────

async function loadSourceDetails(
	source: DatadogOrgConnection,
	flags: DatadogFlagEntry[],
): Promise<{
	details: Map<string, DatadogStatusFlagDetail>;
	errors: Map<string, string>;
}> {
	const details = new Map<string, DatadogStatusFlagDetail>();
	const errors = new Map<string, string>();
	const label = `Fetching details for ${flags.length} flag(s)…`;
	const progress = createSpinner(label).start();
	let completed = 0;
	await mapWithConcurrency(flags, DETAIL_CONCURRENCY, async (flag) => {
		try {
			details.set(
				flag.id,
				await fetchDatadogStatusFlagDetail(
					source.apiKey,
					source.appKey,
					flag.id,
					source.site,
				),
			);
		} catch (error) {
			errors.set(flag.id, formatAxiosError(error));
		}
		completed++;
		progress.text = `Fetching details for ${flags.length} flag(s)… (${completed}/${flags.length} downloaded)`;
	});
	if (errors.size > 0) {
		progress.warn(
			`Loaded details for ${details.size} flag(s); ${errors.size} could not be loaded`,
		);
	} else {
		progress.succeed(`Loaded details for ${details.size} flag(s)`);
	}
	return { details, errors };
}

// ─── Flag Writes ──────────────────────────────────────────────────────────────

type DryRunRequest = { method: string; path: string; body: unknown };

interface MigrationReport {
	dryRunRequests: DryRunRequest[];
	enableApprovalRequests: Array<{ key: string; env: string }>;
	enableFailures: Array<{ key: string; env: string; error: string }>;
	disableFailures: Array<{ key: string; env: string; error: string }>;
	disableApprovalRequests: Array<{ key: string; env: string }>;
}

interface FlagPlan {
	detail: DatadogStatusFlagDetail;
	valueType: DatadogValueType;
	variants: SourceVariant[];
	allocations: DatadogAllocationForFlagCreation[];
	/** Target environment ID → default variant key. */
	defaults: Map<string, string>;
	envsToEnable: DatadogEnvironment[];
	envsToDisable: DatadogEnvironment[];
}

interface FlagOutcome {
	message: string;
	enabled: number;
	disabled: number;
}

function flagPutRequest(flagId: string, attributes: unknown): DryRunRequest {
	return {
		method: 'PUT',
		path: `/api/v2/feature-flags/${flagId}`,
		body: { data: { type: 'feature-flags', attributes } },
	};
}

function allocationsPutRequest(
	flagId: string,
	environmentId: string,
	allocations: DatadogAllocationForFlagCreation[],
	defaultVariantKey: string | undefined,
): DryRunRequest {
	return {
		method: 'PUT',
		path:
			`/api/v2/feature-flags/${flagId}/environments/${environmentId}/allocations` +
			(defaultVariantKey !== undefined
				? `?default_variant_key=${defaultVariantKey}`
				: ''),
		body: toSyncRequests(allocations, environmentId),
	};
}

function targetingCounts(
	allocations: DatadogAllocationForFlagCreation[],
	environments: DatadogEnvironment[],
): { filters: number; rules: number } {
	let filters = 0;
	let rules = 0;
	for (const environment of environments) {
		const requests = toSyncRequests(allocations, environment.id);
		filters += requests.length;
		rules += requests.reduce(
			(sum, request) => sum + (request.targeting_rules?.length ?? 0),
			0,
		);
	}
	return { filters, rules };
}

function targetingLabel(counts: { filters: number; rules: number }): string {
	return `${counts.filters} targeting filter(s)${counts.rules > 0 ? `, ${counts.rules} rule(s)` : ''}`;
}

function environmentsLabel(
	verb: string,
	environments: DatadogEnvironment[],
): string {
	return environments.length > 0
		? `, ${verb} ${environments.map((env) => env.name).join(', ')}`
		: '';
}

async function enableEnvironments(
	target: DatadogOrgConnection,
	flagId: string,
	flagKey: string,
	environments: DatadogEnvironment[],
	report: MigrationReport,
): Promise<number> {
	let enabled = 0;
	for (const environment of environments) {
		try {
			const outcome = await enableFeatureFlagEnvironmentWithOutcome(
				target.apiKey,
				target.appKey,
				flagId,
				environment.id,
				target.site,
			);
			if (outcome === 'enabled') enabled++;
			else
				report.enableApprovalRequests.push({
					key: flagKey,
					env: environment.name,
				});
		} catch (error) {
			report.enableFailures.push({
				key: flagKey,
				env: environment.name,
				error: formatAxiosError(error),
			});
		}
	}
	return enabled;
}

async function disableEnvironments(
	target: DatadogOrgConnection,
	flagId: string,
	flagKey: string,
	environments: DatadogEnvironment[],
	report: MigrationReport,
): Promise<number> {
	let disabled = 0;
	for (const environment of environments) {
		try {
			const outcome = await disableFeatureFlagEnvironmentWithOutcome(
				target.apiKey,
				target.appKey,
				flagId,
				environment.id,
				target.site,
			);
			if (outcome === 'disabled') disabled++;
			else
				report.disableApprovalRequests.push({
					key: flagKey,
					env: environment.name,
				});
		} catch (error) {
			report.disableFailures.push({
				key: flagKey,
				env: environment.name,
				error: formatAxiosError(error),
			});
		}
	}
	return disabled;
}

/**
 * Sync an existing target flag from the source org.
 *
 * Name, description, JSON schema, distribution channel, and tags always sync. When no
 * mapped source environment is enabled, targeting is not rewritten, so
 * variant deletes are skipped (targeting references variants by UUID) and the
 * mapped target environments are disabled. Otherwise targeting and the
 * default variant are replaced in each enabled environment, variant deletes
 * run after the targeting writes, and environment state is matched.
 */
async function syncExistingFlag(
	pair: DatadogOrgPair,
	existing: DatadogFlagEntry,
	plan: FlagPlan,
	tagSyncMode: TagSyncMode,
	dryRun: boolean,
	report: MigrationReport,
): Promise<FlagOutcome> {
	const { target } = pair;
	const { detail, variants, allocations, defaults } = plan;
	const { envsToEnable, envsToDisable } = plan;
	const flagId = existing.id;
	const fullSync = envsToEnable.length > 0;
	const targetName = resolveFlagNameForSync(detail.name, existing.name);
	const description = detail.description;
	const channel = datadogDistributionChannel(detail);
	const jsonSchema = detail.jsonSchema ?? null;
	const schemaLabel = plan.valueType === 'JSON' ? ', 1 JSON schema' : '';
	const syncTags = await resolveMigrationTargetTags(
		tagSyncMode,
		detail.tags ?? [],
		flagId,
		target.apiKey,
		target.appKey,
		target.site,
	);
	const tagLabel =
		syncTags.length > 0 ? `, ${syncTags.length} tag(s)` : ', tags cleared';
	const targeting = targetingCounts(allocations, envsToEnable);

	if (dryRun) {
		const variantPlan = planDatadogVariantSync(
			variants,
			await fetchTargetVariants(target, flagId),
			plan.valueType,
		);
		const targetAllocations = remapAllocationVariantKeys(
			allocations,
			variantPlan.targetKeys,
		);
		const targetDefaults = remapDefaultVariantKeys(
			defaults,
			variantPlan.targetKeys,
		);
		const { createUpdateRequests, deleteRequests } =
			buildDatadogVariantSyncRequests(flagId, variantPlan);
		report.dryRunRequests.push(flagPutRequest(flagId, { name: targetName }));
		if (description !== undefined) {
			report.dryRunRequests.push(flagPutRequest(flagId, { description }));
		}
		if (channel !== undefined) {
			report.dryRunRequests.push(
				flagPutRequest(flagId, { distribution_channel: channel }),
			);
		}
		if (plan.valueType === 'JSON') {
			report.dryRunRequests.push(
				flagPutRequest(flagId, { json_schema: jsonSchema }),
			);
		}
		report.dryRunRequests.push(...createUpdateRequests);
		if (fullSync) {
			for (const environment of envsToEnable) {
				report.dryRunRequests.push(
					allocationsPutRequest(
						flagId,
						environment.id,
						targetAllocations,
						targetDefaults.get(environment.id),
					),
					{
						method: 'POST',
						path: `/api/v2/feature-flags/${flagId}/environments/${environment.id}/enable`,
						body: {},
					},
				);
			}
		}
		for (const environment of envsToDisable) {
			report.dryRunRequests.push({
				method: 'POST',
				path: `/api/v2/feature-flags/${flagId}/environments/${environment.id}/disable`,
				body: {},
			});
		}
		if (fullSync) report.dryRunRequests.push(...deleteRequests);
		report.dryRunRequests.push(flagPutRequest(flagId, { tags: syncTags }));
		const variantLabel = formatVariantLabel({
			added: variantPlan.toCreate.length,
			updated: variantPlan.toUpdate.length,
			deleted: fullSync ? variantPlan.toDelete.length : 0,
		});
		const prefix = `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(detail.key)}`;
		const changes = fullSync
			? `${targetingLabel(targeting)}${variantLabel}${tagLabel}, 1 name${schemaLabel}${environmentsLabel('would enable in', envsToEnable)}${environmentsLabel('would disable in', envsToDisable)}`
			: `1 name${tagLabel}${variantLabel}${schemaLabel}${environmentsLabel('would disable in', envsToDisable)}`;
		return { message: `${prefix} (${changes})`, enabled: 0, disabled: 0 };
	}

	await updateFlagName(
		target.apiKey,
		target.appKey,
		flagId,
		targetName,
		target.site,
	);
	if (description !== undefined) {
		await updateFlagDescription(
			target.apiKey,
			target.appKey,
			flagId,
			description,
			target.site,
		);
	}
	if (channel !== undefined) {
		await updateFlagDistributionChannel(
			target.apiKey,
			target.appKey,
			flagId,
			channel,
			target.site,
		);
	}
	if (plan.valueType === 'JSON') {
		await updateFlagJsonSchema(
			target.apiKey,
			target.appKey,
			flagId,
			jsonSchema,
			target.site,
		);
	}
	const variantSync = await syncDatadogVariantsCreatesAndUpdates(
		target,
		flagId,
		variants,
		plan.valueType,
	);
	if (fullSync) {
		const targetAllocations = remapAllocationVariantKeys(
			allocations,
			variantSync.plan.targetKeys,
		);
		const targetDefaults = remapDefaultVariantKeys(
			defaults,
			variantSync.plan.targetKeys,
		);
		for (const environment of envsToEnable) {
			await syncAllocationsForEnvironment(
				target.apiKey,
				target.appKey,
				flagId,
				environment.id,
				toSyncRequests(targetAllocations, environment.id),
				target.site,
				targetDefaults.get(environment.id),
			);
		}
		// Safe only now: the targeting writes above no longer reference these.
		await applyVariantDeletes(
			target.apiKey,
			target.appKey,
			flagId,
			variantSync.pendingDeletes,
			target.site,
		);
	}
	await updateFlagTags(
		target.apiKey,
		target.appKey,
		flagId,
		syncTags,
		target.site,
	);
	const enabled = fullSync
		? await enableEnvironments(target, flagId, detail.key, envsToEnable, report)
		: 0;
	const disabled = await disableEnvironments(
		target,
		flagId,
		detail.key,
		envsToDisable,
		report,
	);
	const variantLabel = formatVariantLabel({
		...variantSync.counts,
		deleted: fullSync ? variantSync.counts.deleted : 0,
	});
	const enableLabel = enabled > 0 ? `, enabled in ${enabled} env(s)` : '';
	const disableLabel = disabled > 0 ? `, disabled in ${disabled} env(s)` : '';
	const changes = fullSync
		? `${targetingLabel(targeting)}${variantLabel}${tagLabel}, 1 name${schemaLabel}${enableLabel}${disableLabel}`
		: `1 name${tagLabel}${variantLabel}${schemaLabel}${disableLabel}`;
	return {
		message: `${chalk.green('✓')} Synced ${chalk.cyan(detail.key)} (${changes})`,
		enabled,
		disabled,
	};
}

/** Create a flag in the target org with targeting for every mapped environment. */
async function createTargetFlag(
	pair: DatadogOrgPair,
	plan: FlagPlan,
	dryRun: boolean,
	report: MigrationReport,
): Promise<FlagOutcome> {
	const { source, target } = pair;
	const { detail, valueType, allocations, defaults, envsToEnable } = plan;
	const request = buildDatadogCreateFlagRequest(
		detail,
		valueType,
		allocations,
		source.site,
	);
	const ruleCount = allocations.reduce(
		(sum, allocation) => sum + (allocation.targeting_rules?.length ?? 0),
		0,
	);
	const filterLabel = targetingLabel({
		filters: allocations.length,
		rules: ruleCount,
	});
	const schemaLabel = valueType === 'JSON' ? ', 1 JSON schema' : '';

	if (dryRun) {
		report.dryRunRequests.push({
			method: 'POST',
			path: '/api/v2/feature-flags',
			body: { data: { type: 'feature-flags', attributes: request } },
		});
		// The flag key stands in for the ID that Datadog assigns on creation.
		for (const [environmentId, defaultVariantKey] of defaults) {
			report.dryRunRequests.push(
				allocationsPutRequest(
					detail.key,
					environmentId,
					allocations,
					defaultVariantKey,
				),
			);
		}
		for (const environment of envsToEnable) {
			report.dryRunRequests.push({
				method: 'POST',
				path: `/api/v2/feature-flags/${detail.key}/environments/${environment.id}/enable`,
				body: {},
			});
		}
		return {
			message: `${chalk.dim('[dry run]')} Would create ${chalk.cyan(detail.key)} (${filterLabel}${schemaLabel}${environmentsLabel('would enable in', envsToEnable)})`,
			enabled: 0,
			disabled: 0,
		};
	}

	const created = await createFeatureFlag(
		target.apiKey,
		target.appKey,
		request,
		target.site,
	);
	for (const [environmentId, defaultVariantKey] of defaults) {
		await syncAllocationsForEnvironment(
			target.apiKey,
			target.appKey,
			created.id,
			environmentId,
			toSyncRequests(allocations, environmentId),
			target.site,
			defaultVariantKey,
		);
	}
	const enabled = await enableEnvironments(
		target,
		created.id,
		detail.key,
		envsToEnable,
		report,
	);
	const enableLabel = enabled > 0 ? `, enabled in ${enabled} env(s)` : '';
	return {
		message: `${chalk.green('✓')} Created ${chalk.cyan(detail.key)} (${filterLabel}${schemaLabel}${enableLabel})`,
		enabled,
		disabled: 0,
	};
}

// ─── Migration Execution ──────────────────────────────────────────────────────

type ConfirmAction = 'migrate' | 'select-more' | 'cancel';

interface DatadogMigrationOptions {
	pair: DatadogOrgPair;
	dryRun: boolean;
	tagMode?: TagSyncMode;
	nonInteractive?: boolean;
	doExport?: boolean;
}

function buildEnvironmentMappingRecord(
	envMapping: EnvironmentMapping<string>,
	sourceEnvironments: DatadogEnvironment[],
): MigrationEnvironmentMapping[] {
	return [...envMapping].flatMap(([sourceEnvId, targets]) => {
		const sourceEnv = sourceEnvironments.find((env) => env.id === sourceEnvId);
		return targets.map((targetEnv) => ({
			sourceEnvId,
			sourceEnvName: sourceEnv?.name ?? sourceEnvId,
			datadogEnvId: targetEnv.id,
			datadogEnvName: targetEnv.name,
			datadogDdEnvNames: targetEnv.queries,
		}));
	});
}

async function executeDatadogMigration(
	flags: DatadogFlagEntry[],
	envMapping: EnvironmentMapping<string>,
	sourceEnvironments: DatadogEnvironment[],
	targetFlags: DatadogFlagEntry[],
	opts: DatadogMigrationOptions,
): Promise<ConfirmAction> {
	const {
		pair,
		dryRun,
		tagMode: configuredTagMode,
		nonInteractive = false,
		doExport = false,
	} = opts;

	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to migrate.'));
		if (nonInteractive) return 'cancel';
		return select<'select-more' | 'cancel'>({
			message: 'What would you like to do?',
			choices: [
				{ name: 'Select flags', value: 'select-more' },
				{ name: 'Cancel', value: 'cancel' },
			],
		});
	}

	console.log();
	console.log(
		chalk.bold(`You selected ${chalk.green(String(flags.length))} flag(s):`),
	);
	for (const flag of flags) {
		console.log(
			chalk.gray(`  •  ${flagDisplayName(flag)}`) +
				chalk.dim(`  (${flag.key})`),
		);
	}
	console.log();

	if (!nonInteractive) {
		const action = await select<ConfirmAction>({
			message: dryRun
				? `Simulate migration of ${flags.length} flag(s)?`
				: `Migrate ${flags.length} flag(s) to the target org?`,
			choices: [
				{
					name: dryRun
						? `Simulate ${flags.length} flag(s)`
						: `Migrate ${flags.length} flag(s)`,
					value: 'migrate',
				},
				{ name: 'Select more flags', value: 'select-more' },
				{ name: 'Cancel', value: 'cancel' },
			],
		});
		if (action === 'cancel') {
			console.log(chalk.yellow('\nMigration cancelled.'));
			return 'cancel';
		}
		if (action === 'select-more') return 'select-more';
	}

	let tagSyncMode: TagSyncMode =
		configuredTagMode ?? (nonInteractive ? 'additive' : 'replace');
	if (
		configuredTagMode === undefined &&
		!nonInteractive &&
		flags.some((flag) => findTargetFlag(targetFlags, flag) !== undefined)
	) {
		tagSyncMode = await selectMigrationTagMode();
	}

	const { details, errors: detailErrors } = await loadSourceDetails(
		pair.source,
		flags,
	);
	const sourceEnvironmentNames = new Map(
		sourceEnvironments.map((env) => [env.id, env.name]),
	);

	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run — no flags will be created\n'));
	}
	console.log();

	const report: MigrationReport = {
		dryRunRequests: [],
		enableApprovalRequests: [],
		enableFailures: [],
		disableFailures: [],
		disableApprovalRequests: [],
	};

	// ── Phase 1: Saved filters ────────────────────────────────────────────────
	let savedFilterIdMap = new Map<string, string>();
	let savedFilterStats: DatadogSavedFilterMigrationStats | undefined;
	let phase1Subheader: string | undefined;
	const refs = discoverSavedFilterRefs(
		[...details.values()],
		envMapping.keys(),
	);
	if (refs.length > 0) {
		console.log(chalk.bold('  Phase 1: Migrating saved filters'));
		console.log();
		try {
			const result = await migrateDatadogSavedFilters({
				pair,
				refs,
				dryRun,
				nonInteractive,
			});
			savedFilterIdMap = result.savedFilterIdMap;
			savedFilterStats = result.stats;
			report.dryRunRequests.push(...result.dryRunRequests);
			const { created, reused, updated, skipped } = result.stats;
			const createdVerb = dryRun ? 'would be created' : 'created';
			const updatedVerb = dryRun ? 'would update' : 'updated';
			phase1Subheader =
				chalk.gray('Phase 1 — Saved filters: ') +
				chalk.green(String(created)) +
				chalk.gray(` ${createdVerb} · `) +
				chalk.white(String(reused)) +
				chalk.gray(` reused (${updated} ${updatedVerb}) · `) +
				chalk.yellow(String(skipped)) +
				chalk.gray(' skipped');
		} catch (error) {
			console.log(
				chalk.yellow(
					`  Saved filter migration failed (${formatAxiosError(error)}) — flags that reference saved filters will be skipped`,
				),
			);
		}
		console.log();
	}

	// ── Phase 2: Flags ────────────────────────────────────────────────────────
	let created = 0,
		synced = 0,
		skipped = 0,
		errored = 0;
	let totalEnabled = 0;
	let totalDisabled = 0;
	const failures: Array<{ key: string; error: string }> = [];
	const skippedFlags: Array<{ key: string; reason: string }> = [];
	const syncedFlagKeys: string[] = [];
	const environmentMapping = buildEnvironmentMappingRecord(
		envMapping,
		sourceEnvironments,
	);
	const flagRecords = flags.map((flag) => ({
		id: flag.id,
		key: flag.key,
		name: flagDisplayName(flag),
	}));
	const timestampNow = () => new Date().toISOString();
	const buildMigrationFile = (
		migratedAt: string,
		success: boolean,
	): DatadogMigrationFile => ({
		provider: 'datadog',
		sourceSite: pair.source.site,
		targetSite: pair.target.site,
		migratedAt,
		success,
		summary: {
			created,
			synced,
			skipped,
			errored,
			enabled: totalEnabled,
			disabled: totalDisabled,
		},
		failures,
		enableApprovalRequests: report.enableApprovalRequests,
		enableFailures: report.enableFailures,
		disableFailures: report.disableFailures,
		disableApprovalRequests: report.disableApprovalRequests,
		skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
		syncedFlagKeys: syncedFlagKeys.length > 0 ? syncedFlagKeys : undefined,
		savedFilterMigration: savedFilterStats,
		flags: flagRecords,
		environmentMapping,
	});
	const saveMigrationFile = (data: DatadogMigrationFile): string => {
		if (!fs.existsSync(CONFIG_DIR))
			fs.mkdirSync(CONFIG_DIR, { recursive: true });
		const filepath = path.join(CONFIG_DIR, `migration-${data.migratedAt}.json`);
		fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
		return filepath;
	};

	let runner: MigrationRunnerHandle | undefined;
	const sigintHandler = () => {
		if (runner) runner.finalize();
		else process.stderr.write('\n');
		if (!dryRun && (created > 0 || synced > 0 || errored > 0)) {
			console.log(
				chalk.yellow('\n  Migration interrupted — saving partial results…'),
			);
			const filepath = saveMigrationFile(
				buildMigrationFile(timestampNow(), false),
			);
			console.log(chalk.gray(`  Partial migration saved to ${filepath}`));
		}
		console.log(chalk.gray('\n  Bye!'));
		process.exit(130);
	};
	process.once('SIGINT', sigintHandler);
	if (!nonInteractive) clearScreen();
	runner = migrationRunner({ total: flags.length, subheader: phase1Subheader });
	const activeRunner: MigrationRunnerHandle = runner;
	const settleStats = () => ({
		saved: created + synced,
		skipped,
		failed: errored,
	});
	const doSkip = (key: string, reason: string): void => {
		skippedFlags.push({ key, reason });
		skipped++;
		activeRunner.settleFlag({
			status: 'skipped',
			message: `Skipped ${chalk.cyan(key)} — ${reason}`,
			stats: settleStats(),
		});
	};
	const doFail = (key: string, error: string): void => {
		failures.push({ key, error });
		errored++;
		activeRunner.settleFlag({
			status: 'failed',
			message: `Failed ${chalk.cyan(key)}: ${chalk.red(error)}`,
			stats: settleStats(),
		});
	};

	try {
		for (const flag of flags) {
			activeRunner.beginFlag(flag.key);
			try {
				const detail = details.get(flag.id);
				if (!detail) {
					doFail(
						flag.key,
						detailErrors.get(flag.id) ??
							'Source flag details were not available',
					);
					continue;
				}
				const valueType = datadogValueType(detail);
				if (valueType === undefined) {
					doSkip(flag.key, 'Unknown value type');
					continue;
				}
				const variants = buildDatadogSourceVariants(detail);
				if (variants.length === 0) {
					doSkip(flag.key, 'No variants');
					continue;
				}
				const unsupported = unsupportedTargetingReason(
					detail,
					envMapping,
					sourceEnvironmentNames,
				);
				if (unsupported) {
					doSkip(flag.key, unsupported);
					continue;
				}
				const built = buildDatadogAllocations(
					detail,
					envMapping,
					savedFilterIdMap,
				);
				if ('flagSkip' in built) {
					doSkip(flag.key, built.flagSkip);
					continue;
				}
				const plan: FlagPlan = {
					detail,
					valueType,
					variants,
					allocations: built.allocations,
					defaults: buildDatadogDefaultVariantKeyPerEnv(detail, envMapping),
					envsToEnable: getDatadogEnvsToEnable(detail, envMapping),
					envsToDisable: getDatadogEnvsToDisable(detail, envMapping),
				};

				const existing = findTargetFlag(targetFlags, detail);
				if (existing) {
					if (plan.envsToEnable.length > 0) {
						activeRunner.printMessage(
							`⚠ ${chalk.cyan(flag.key)} exists in the target org — targeting filters in ${plan.envsToEnable.map((env) => env.name).join(', ')} will be overwritten`,
						);
						activeRunner.beginFlag(flag.key);
					}
					const outcome = await syncExistingFlag(
						pair,
						existing,
						plan,
						tagSyncMode,
						dryRun,
						report,
					);
					synced++;
					syncedFlagKeys.push(flag.key);
					totalEnabled += outcome.enabled;
					totalDisabled += outcome.disabled;
					activeRunner.settleFlag({
						status: 'synced',
						message: outcome.message,
						stats: settleStats(),
					});
				} else {
					const outcome = await createTargetFlag(pair, plan, dryRun, report);
					created++;
					totalEnabled += outcome.enabled;
					activeRunner.settleFlag({
						status: 'created',
						message: outcome.message,
						stats: settleStats(),
					});
				}
			} catch (error) {
				doFail(flag.key, formatAxiosError(error));
			}
		}
	} finally {
		process.removeListener('SIGINT', sigintHandler);
		activeRunner.finalize();
	}

	await renderStatic(
		<MigrationSummary
			dryRun={dryRun}
			counts={{
				created,
				synced,
				skipped,
				errored,
				enabled: totalEnabled,
				disabled: totalDisabled,
			}}
			failures={failures}
			enableApprovalRequests={report.enableApprovalRequests}
			enableFailures={report.enableFailures}
			disableFailures={report.disableFailures}
			disableApprovalRequests={report.disableApprovalRequests}
		/>,
	);

	const migratedAt = timestampNow();
	const migrationData = buildMigrationFile(migratedAt, errored === 0);
	let outputData: DatadogMigrationFile | DatadogDryRunFile = migrationData;

	if (dryRun) {
		const dryRunData: DatadogDryRunFile = {
			...migrationData,
			requests: report.dryRunRequests,
		};
		outputData = dryRunData;
		if (report.dryRunRequests.length > 0) {
			const filepath = path.join(process.cwd(), `dry-run-${migratedAt}.json`);
			fs.writeFileSync(filepath, JSON.stringify(dryRunData, null, 2));
			console.log(chalk.gray(`  Requests written to ${filepath}`));
		}
	} else if (created > 0 || synced > 0 || errored > 0) {
		const filepath = saveMigrationFile(migrationData);
		console.log(chalk.gray(`  Migration saved to ${filepath}`));

		let exportToSheets: boolean;
		if (nonInteractive) {
			exportToSheets = doExport;
		} else {
			const { confirm } = await import('../components/Confirm.js');
			exportToSheets = await confirm({
				message: 'Would you like to export migration results to an .xlsx file?',
				default: true,
			});
		}
		if (exportToSheets) {
			const { exportDatadogMigrationToXlsx } = await import('./xlsx.js');
			await exportDatadogMigrationToXlsx(migrationData);
		}
	}

	if (nonInteractive) writeJsonOutput(outputData);

	console.log();
	if (nonInteractive && errored > 0) process.exitCode = 1;
	return 'migrate';
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export interface DatadogNonInteractiveOptions {
	envMap: Array<[string, string]>;
	flagKeys: string[];
}

export interface RunDatadogMigrationOptions {
	tagMode?: TagSyncMode;
	nonInteractive?: DatadogNonInteractiveOptions;
	doExport?: boolean;
}

interface OrgInventory {
	sourceFlags: DatadogFlagEntry[];
	sourceEnvironments: DatadogEnvironment[];
	targetFlags: DatadogFlagEntry[];
	targetEnvironments: DatadogEnvironment[];
}

async function loadInventory(pair: DatadogOrgPair): Promise<OrgInventory> {
	const { source, target } = pair;
	const spinner = createSpinner('Loading data…').start();
	try {
		const [sourceFlags, sourceEnvironments, targetFlags, targetEnvironments] =
			await Promise.all([
				fetchDatadogFlags(source.apiKey, source.appKey, source.site),
				fetchDatadogEnvironments(source.apiKey, source.appKey, source.site),
				fetchDatadogFlags(target.apiKey, target.appKey, target.site),
				fetchDatadogEnvironments(target.apiKey, target.appKey, target.site),
			]);
		spinner.succeed(
			`Loaded ${sourceFlags.length} source flag(s) · ${sourceEnvironments.length} source environment(s) · ${targetFlags.length} target flag(s) · ${targetEnvironments.length} target environment(s)`,
		);
		return { sourceFlags, sourceEnvironments, targetFlags, targetEnvironments };
	} catch (error) {
		spinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(error)}`));
		process.exit(1);
	}
}

export async function runDatadogMigration(
	pair: DatadogOrgPair,
	dryRun: boolean,
	options?: RunDatadogMigrationOptions,
): Promise<void> {
	if (options?.nonInteractive) {
		await runDatadogMigrationNonInteractive(
			pair,
			dryRun,
			options.nonInteractive,
			options.doExport ?? false,
			options.tagMode,
		);
		return;
	}

	console.log();
	const inventory = await loadInventory(pair);
	const { sourceFlags, sourceEnvironments, targetFlags, targetEnvironments } =
		inventory;
	if (sourceFlags.length === 0) {
		console.log(chalk.yellow('No flags were found in the source org.'));
		return;
	}
	if (sourceEnvironments.length === 0 || targetEnvironments.length === 0) {
		console.log(
			chalk.yellow(
				'Both orgs need at least one feature flag environment to migrate.',
			),
		);
		return;
	}

	let prevSelectedEnvs: DatadogEnvironment[] = [];
	let prevEnvMapping: EnvironmentMapping<string> = new Map();
	let prevSelectedFlags: DatadogFlagEntry[] = [];

	outer: while (true) {
		clearScreen();
		await printHeader();
		const selectedEnvs = await selectSourceEnvironments(
			sourceEnvironments,
			prevSelectedEnvs,
			'Select source org environments to migrate from:',
		);
		if (selectedEnvs === null) break;
		if (selectedEnvs.length === 0) {
			console.log(
				chalk.yellow(
					'\n  Please select at least one environment to migrate from.\n',
				),
			);
			continue;
		}
		prevSelectedEnvs = selectedEnvs;

		while (true) {
			const mapping = await linkDatadogEnvironments(
				selectedEnvs,
				targetEnvironments,
				prevEnvMapping,
				printHeader,
			);
			if (mapping === null) break;
			prevEnvMapping = mapping;

			while (true) {
				clearScreen();
				await printHeader();
				const flagResult = await selectFlags(
					sourceFlags,
					targetFlags,
					prevSelectedFlags,
				);
				if (flagResult === null) break;
				prevSelectedFlags = flagResult;
				clearScreen();
				await printHeader();
				const action = await executeDatadogMigration(
					prevSelectedFlags,
					prevEnvMapping,
					sourceEnvironments,
					targetFlags,
					{ pair, dryRun, tagMode: options?.tagMode },
				);
				if (action === 'cancel' || action === 'migrate') break outer;
			}
		}
	}
}

// ─── Non-Interactive Entry Point ──────────────────────────────────────────────

export function resolveDatadogFlags(
	keys: string[],
	sourceFlags: DatadogFlagEntry[],
): DatadogFlagEntry[] {
	const byKey = new Map(sourceFlags.map((flag) => [flag.key, flag]));
	const missing = keys.filter((key) => !byKey.has(key));
	if (missing.length > 0) {
		throw new Error(
			`Flag(s) not found in the source org: ${missing.join(', ')}`,
		);
	}
	return [...new Set(keys)].flatMap((key) => {
		const flag = byKey.get(key);
		return flag ? [flag] : [];
	});
}

async function runDatadogMigrationNonInteractive(
	pair: DatadogOrgPair,
	dryRun: boolean,
	ni: DatadogNonInteractiveOptions,
	doExport: boolean,
	tagMode?: TagSyncMode,
): Promise<void> {
	console.log();
	console.log(chalk.gray('  Running in non-interactive mode'));
	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run mode — no flags will be created'));
	}
	console.log();

	const { sourceFlags, sourceEnvironments, targetFlags, targetEnvironments } =
		await loadInventory(pair);

	let envMapping: EnvironmentMapping<string>;
	let selectedFlags: DatadogFlagEntry[];
	try {
		({ envMapping } = resolveDatadogEnvMap(
			ni.envMap,
			sourceEnvironments,
			targetEnvironments,
		));
		selectedFlags = resolveDatadogFlags(ni.flagKeys, sourceFlags);
	} catch (error) {
		console.error(
			chalk.red(
				`\n  ${error instanceof Error ? error.message : String(error)}\n`,
			),
		);
		process.exit(1);
	}

	await executeDatadogMigration(
		selectedFlags,
		envMapping,
		sourceEnvironments,
		targetFlags,
		{ pair, dryRun, tagMode, nonInteractive: true, doExport },
	);
}
