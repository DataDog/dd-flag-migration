import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { filterableCheckbox } from '../components/FilterableCheckbox.js';
import { filterableSelect } from '../components/FilterableSelect.js';
import {
	type FilterCategory,
	MIGRATED_FILTER_ID,
	NOT_MIGRATED_FILTER_ID,
} from '../components/filter-matching.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import { input } from '../components/Input.js';
import {
	type MigrationRunnerHandle,
	migrationRunner,
} from '../components/MigrationRunner.js';
import { renderStatic } from '../components/mount.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import { formatVariantLabel } from '../components/VariantCounts.js';
import {
	applyRestrictionPolicy,
	applyVariantDeletes,
	createFeatureFlag,
	enableFeatureFlagEnvironment,
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogTeams,
	fetchFlagDetail,
	fetchRestrictionPolicy,
	syncAllocationsForEnvironment,
	syncVariantsCreatesAndUpdates,
	updateFlagDistributionChannel,
	updateFlagTags,
} from '../datadog/api.js';
import { buildVariantSyncDryRunRequests } from '../datadog/helpers.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogTeam,
	DDRestrictionBinding,
} from '../datadog/types.js';
import { CONFIG_DIR } from '../helpers/config.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { toSyncRequests } from '../helpers/migration.js';
import { writeJsonOutput } from '../helpers/output.js';
import {
	fetchCustomRoles,
	fetchFlag,
	fetchFlagRelease,
	fetchFlagStatuses,
	fetchFlags,
	fetchFlagsByKey,
	fetchProjectEnvironments,
	fetchProjects,
	fetchTeamsWithRoles,
	isReleaseInProgress,
	type LDFlagStatus,
	type LDProject,
} from './api.js';
import { LDMigrationSummary } from './components/LDMigrationSummary.js';
import {
	buildAllocations,
	buildFlagTags,
	buildVariants,
	findProjectEditorRoleKeys,
	findTeamsWithEditAccess,
	getEnvsToEnable,
	hasJsonArrayVariants,
	hasSemverConditions,
	mapFlagType,
	shouldSkipFlag,
} from './helpers/migration.js';
import {
	discoverSegmentRefs,
	migrateSegments,
	planDryRunSegments,
} from './segments.js';
import type { LDEnvironment, LDFlag, LDMigrationFile } from './types.js';

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.launchdarkly} />);
}

function ddEnvLabel(env: DatadogEnvironment): string {
	const prodBadge = env.is_production
		? `  ${chalk.bgHex('#632CA6').white(' Prod ')}`
		: '';
	return `${env.name}${prodBadge}`;
}

function buildDryRunRestrictionPolicy(
	flagId: string,
	editorTeamIds: string[],
	existingBindings: DDRestrictionBinding[],
	approximationNote?: string,
): {
	method: string;
	path: string;
	params: Record<string, unknown>;
	body: unknown;
} {
	const newPrincipals = editorTeamIds.map((id) => `team:${id}`);
	const editorBinding = existingBindings.find((b) => b.relation === 'editor');
	const mergedPrincipals = [
		...new Set([...(editorBinding?.principals ?? []), ...newPrincipals]),
	];
	const otherBindings = existingBindings.filter((b) => b.relation !== 'editor');
	const updatedBindings: DDRestrictionBinding[] = [
		...otherBindings,
		{ principals: mergedPrincipals, relation: 'editor' },
	];
	return {
		method: 'POST',
		path: `/api/v2/restriction_policy/feature-flag:${flagId}`,
		params: { allow_self_lockout: true },
		body: {
			...(approximationNote ? { _note: approximationNote } : {}),
			data: {
				id: `feature-flag:${flagId}`,
				type: 'restriction_policy',
				attributes: { bindings: updatedBindings },
			},
		},
	};
}

async function applyRestrictionPolicyForFlag(
	ddApiKey: string,
	ddAppKey: string,
	flagId: string,
	editorTeamIds: string[],
	ddSite: string,
	flagKey: string,
	failures: Array<{ key: string; error: string }>,
): Promise<void> {
	try {
		await applyRestrictionPolicy(
			ddApiKey,
			ddAppKey,
			flagId,
			editorTeamIds,
			ddSite,
		);
	} catch (err) {
		const error = formatAxiosError(err);
		console.log(
			chalk.yellow(
				`  ⚠ Could not set restriction policy for ${flagKey}: ${error}`,
			),
		);
		failures.push({ key: flagKey, error });
	}
}

/** Prompt the user to select a DD team handle for a mismatched LD team key. */
async function promptForTeamMapping(
	ldTeamKey: string,
	ddTeams: DatadogTeam[],
): Promise<string | null> {
	const pageSize = Math.max(
		5,
		Math.min(ddTeams.length + 1, (process.stdout.rows ?? 24) - 9),
	);

	const result = await filterableSelect<string | null>({
		message: `Map LD team "${ldTeamKey}" → Datadog team:`,
		choices: [
			{
				name: chalk.dim(`Skip — keep as "${ldTeamKey}"`),
				value: null,
			},
			...ddTeams.map((t) => ({
				name: `${t.name}  ${chalk.gray(`(${t.handle})`)}`,
				value: t.handle,
			})),
		],
		pageSize,
	});
	return result;
}

/** Find the DD flag that matches this LD flag for the given project. */
function findMatchingDatadogFlag(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	flagKey: string,
): DatadogFlagEntry | undefined {
	return datadogFlags.find(
		(f) =>
			f.migration_metadata?.project_key === projectKey &&
			f.migration_metadata?.flag_key === flagKey,
	);
}

export type ConflictType = 'none' | 'same_project' | 'manual' | 'cross_project';

export interface ConflictClassification {
	type: ConflictType;
	existingFlag?: DatadogFlagEntry;
}

export type DatadogKeyConflictType = ConflictType | 'same_run';

export interface DatadogKeyConflictClassification {
	type: DatadogKeyConflictType;
	existingFlag?: DatadogFlagEntry;
}

export interface LDFlagMigrationSpec {
	sourceKey: string;
	datadogKey: string;
}

export type NonInteractiveConflictType = 'none' | 'same_project' | 'duplicate';

export interface NonInteractiveConflictClassification {
	type: NonInteractiveConflictType;
	existingFlag?: DatadogFlagEntry;
}

export function parseLDFlagMigrationSpecs(
	flagSpecs: string[],
): LDFlagMigrationSpec[] {
	const seenSourceKeys = new Set<string>();
	return flagSpecs.map((raw) => {
		const parts = raw.split(',').map((part) => part.trim());
		if (
			parts.length > 2 ||
			parts.length === 0 ||
			parts.some((part) => part.length === 0)
		) {
			throw new Error(
				`--feature-flag must be either '<source-key>' or '<source-key>,<datadog-key>', got: ${raw}`,
			);
		}
		const [sourceKey, datadogKey = sourceKey] = parts;
		if (seenSourceKeys.has(sourceKey)) {
			throw new Error(`Duplicate LaunchDarkly flag key: ${sourceKey}`);
		}
		seenSourceKeys.add(sourceKey);
		return { sourceKey, datadogKey };
	});
}

export function classifyNonInteractiveConflict(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	sourceFlagKey: string,
	datadogFlagKey: string,
): NonInteractiveConflictClassification {
	const keyMatch = datadogFlags.find((f) => f.key === datadogFlagKey);
	if (!keyMatch) return { type: 'none' };

	const metadata = keyMatch.migration_metadata;
	if (
		metadata?.project_key === projectKey &&
		metadata.flag_key === sourceFlagKey
	) {
		return { type: 'same_project', existingFlag: keyMatch };
	}

	return { type: 'duplicate', existingFlag: keyMatch };
}

/** Classify the relationship between an LD flag and existing DD flags. */
export function classifyConflict(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	flagKey: string,
): ConflictClassification {
	const metadataMatch = findMatchingDatadogFlag(
		datadogFlags,
		projectKey,
		flagKey,
	);
	if (metadataMatch)
		return { type: 'same_project', existingFlag: metadataMatch };

	const keyMatch = datadogFlags.find((f) => f.key === flagKey);
	if (!keyMatch) return { type: 'none' };

	if (keyMatch.migration_metadata) {
		return { type: 'cross_project', existingFlag: keyMatch };
	}
	return { type: 'manual', existingFlag: keyMatch };
}

/** Classify whether a proposed DD flag key is already occupied. */
export function classifyDatadogKeyConflict(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	sourceFlagKey: string,
	datadogFlagKey: string,
	reservedDatadogKeys: ReadonlySet<string> = new Set(),
): DatadogKeyConflictClassification {
	const keyMatch = datadogFlags.find((f) => f.key === datadogFlagKey);
	if (!keyMatch) {
		if (reservedDatadogKeys.has(datadogFlagKey)) return { type: 'same_run' };
		return { type: 'none' };
	}

	const metadata = keyMatch.migration_metadata;
	if (
		metadata?.project_key === projectKey &&
		metadata.flag_key === sourceFlagKey
	) {
		return { type: 'same_project', existingFlag: keyMatch };
	}

	if (metadata) return { type: 'cross_project', existingFlag: keyMatch };

	return { type: 'manual', existingFlag: keyMatch };
}

export type ConflictResolution =
	| { action: 'skip' }
	| { action: 'prefix'; prefix: string };

export type InteractiveDatadogTargetPlan =
	| {
			action: 'sync';
			datadogKey: string;
			existingFlag: DatadogFlagEntry;
	  }
	| {
			action: 'create';
			datadogKey: string;
			appliedPrefix?: string;
	  }
	| {
			action: 'blocked';
			datadogKey: string;
			conflict: DatadogKeyConflictClassification;
	  };

export function planInteractiveDatadogTarget(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	sourceFlagKey: string,
	targetKey: string,
	conflictResolution?: ConflictResolution,
	reservedDatadogKeys: ReadonlySet<string> = new Set(),
): InteractiveDatadogTargetPlan {
	const sourceConflict = classifyConflict(
		datadogFlags,
		projectKey,
		sourceFlagKey,
	);
	const sourceExistingFlag =
		sourceConflict.type === 'same_project' || sourceConflict.type === 'manual'
			? sourceConflict.existingFlag
			: undefined;
	if (sourceExistingFlag) {
		return {
			action: 'sync',
			datadogKey: sourceExistingFlag.key,
			existingFlag: sourceExistingFlag,
		};
	}

	const datadogKey =
		conflictResolution?.action === 'prefix'
			? `${conflictResolution.prefix}${sourceFlagKey}`
			: targetKey;
	const keyConflict = classifyDatadogKeyConflict(
		datadogFlags,
		projectKey,
		sourceFlagKey,
		datadogKey,
		reservedDatadogKeys,
	);
	if (keyConflict.type !== 'none') {
		return {
			action: 'blocked',
			datadogKey,
			conflict: keyConflict,
		};
	}

	return {
		action: 'create',
		datadogKey,
		...(conflictResolution?.action === 'prefix'
			? { appliedPrefix: conflictResolution.prefix }
			: {}),
	};
}

export function buildFlagKeyMappingsForReport(
	sourceKeys: readonly string[],
	targetKeyBySource: ReadonlyMap<string, string> | undefined,
	runtimeFlagKeyMapping: ReadonlyMap<string, string>,
): Array<{ sourceKey: string; datadogKey: string }> | undefined {
	const sourceKeyOrder = [...sourceKeys];
	const seenSourceKeys = new Set(sourceKeyOrder);
	for (const sourceKey of runtimeFlagKeyMapping.keys()) {
		if (!seenSourceKeys.has(sourceKey)) sourceKeyOrder.push(sourceKey);
	}

	const mappings = new Map<string, string>();
	if (targetKeyBySource) {
		for (const sourceKey of sourceKeyOrder) {
			mappings.set(sourceKey, targetKeyBySource.get(sourceKey) ?? sourceKey);
		}
	}
	for (const [sourceKey, datadogKey] of runtimeFlagKeyMapping) {
		mappings.set(sourceKey, datadogKey);
	}

	const result = sourceKeyOrder
		.map((sourceKey) => ({
			sourceKey,
			datadogKey: mappings.get(sourceKey) ?? sourceKey,
		}))
		.filter((mapping) => mapping.datadogKey !== mapping.sourceKey);

	if (result.length > 0 || targetKeyBySource !== undefined) return result;
	return undefined;
}

function describeDatadogKeyConflict(
	conflict: DatadogKeyConflictClassification,
): string {
	if (conflict.type === 'same_run') {
		return 'is already selected for another flag in this migration';
	}
	const metadata = conflict.existingFlag?.migration_metadata;
	if (metadata?.project_key) {
		return `already exists in Datadog from LaunchDarkly project "${metadata.project_key}"`;
	}
	if (conflict.type === 'manual') {
		return 'already exists in Datadog without LaunchDarkly migration metadata';
	}
	return 'already exists in Datadog';
}

function flagLabel(
	flag: LDFlag,
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	conflictResolution?: ConflictResolution,
): string {
	const classification = classifyConflict(datadogFlags, projectKey, flag.key);
	const name = flag.name;
	const key = chalk.gray(`(${flag.key})`);
	const kind = flag.kind === 'boolean' ? '' : chalk.dim(` [${flag.kind}]`);

	let indicator: string;
	let badge: string;

	switch (classification.type) {
		case 'same_project':
		case 'manual':
			indicator = chalk.green('✓');
			badge = `  ${chalk.bgGreen.black(' In Datadog — will sync targeting ')}`;
			break;
		case 'cross_project':
			if (conflictResolution?.action === 'prefix') {
				indicator = chalk.hex('#632CA6')('⊕');
				badge = `  ${chalk.bgHex('#632CA6').white(` Will prefix with ${conflictResolution.prefix} `)}`;
			} else {
				indicator = chalk.red('✗');
				badge = `  ${chalk.bgRed.white(' Key conflict — will skip ')}`;
			}
			break;
		case 'none':
			if (conflictResolution?.action === 'prefix') {
				indicator = chalk.hex('#632CA6')('⊕');
				badge = `  ${chalk.bgHex('#632CA6').white(` Will prefix with ${conflictResolution.prefix} `)}`;
			} else {
				indicator = ' ';
				badge = '';
			}
			break;
		default:
			indicator = ' ';
			badge = '';
	}

	return `${indicator}  ${name}  ${key}${kind}${badge}`;
}

// ─── Prompt Steps ────────────────────────────────────────────────────────────

async function selectProject(projects: LDProject[]): Promise<LDProject | null> {
	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(projects.length))} LaunchDarkly project(s)`,
		),
	);
	console.log();

	const pageSize = Math.max(
		3,
		Math.min(projects.length, (process.stdout.rows ?? 24) - 9),
	);

	const choices = projects.map((p) => ({
		name: `${p.name}  ${chalk.gray(`(${p.key})`)}`,
		value: p,
		short: p.name,
	}));

	return filterableSelect<LDProject>({
		message: 'Select a LaunchDarkly project to migrate:',
		choices,
		pageSize,
	});
}

async function selectLDEnvironments(
	ldEnvs: LDEnvironment[],
	previouslySelected: string[] = [],
): Promise<LDEnvironment[] | null> {
	const activeEnvs = ldEnvs.filter((env) => !env.archived);
	const archivedCount = ldEnvs.length - activeEnvs.length;

	const previousSet = new Set(previouslySelected);

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(activeEnvs.length))} environment(s) in the project`,
		) +
			(archivedCount > 0
				? chalk.gray(` (${archivedCount} archived environment(s) hidden)`)
				: ''),
	);
	console.log();

	const pageSize = Math.max(
		3,
		Math.min(activeEnvs.length, (process.stdout.rows ?? 24) - 9),
	);

	return filterableCheckbox<LDEnvironment>({
		message: 'Select LaunchDarkly environments to migrate:',
		choices: activeEnvs.map((env) => {
			const label =
				env.name !== env.key
					? `${env.name} ${chalk.gray(`(${env.key})`)}`
					: env.key;
			return {
				name: label,
				value: env,
				checked: previousSet.has(env.key),
			};
		}),
		pageSize,
	});
}

async function linkEnvironments(
	ldEnvs: LDEnvironment[],
	ddEnvs: DatadogEnvironment[],
	previousMapping: Map<string, DatadogEnvironment>,
): Promise<Map<string, DatadogEnvironment> | null> {
	const mapping = new Map<string, DatadogEnvironment>(previousMapping);
	let i = 0;

	while (i < ldEnvs.length) {
		const ldEnv = ldEnvs[i];
		const prevChoice = mapping.get(ldEnv.key);

		clearScreen();
		await printHeader();
		console.log(
			chalk.bold('Linking environment ') +
				chalk.green(`${i + 1}`) +
				chalk.bold(' of ') +
				chalk.green(`${ldEnvs.length}`) +
				chalk.bold(':') +
				`  ${chalk.cyan(ldEnv.name)}` +
				(ldEnv.name !== ldEnv.key ? chalk.gray(` (${ldEnv.key})`) : ''),
		);
		console.log();

		type LinkChoice = DatadogEnvironment | null;

		const result = await select<LinkChoice>({
			message: 'Select the matching Datadog environment:',
			choices: [
				{ name: chalk.dim('← Back'), value: null, short: 'Back' },
				...ddEnvs.map((env) => ({
					name: ddEnvLabel(env),
					value: env as LinkChoice,
					short: env.name,
				})),
			],
			default: prevChoice,
		});

		if (result === null) {
			if (i === 0) return null;
			i--;
		} else {
			mapping.set(ldEnv.key, result);
			i++;
		}
	}

	return mapping;
}

/**
 * Advanced-filter categories offered on the flag-selection screen for
 * LaunchDarkly. The four lifecycle statuses come from LD flag statuses; the
 * `previously-migrated` category applies to flags already migrated to Datadog.
 */
const LD_FILTER_CATEGORIES: FilterCategory[] = [
	{
		id: 'new',
		label: 'new',
		scope: 'any environment',
		description:
			'LaunchDarkly reports new for at least one non-archived environment.',
	},
	{
		id: 'active',
		label: 'active',
		scope: 'any environment',
		description:
			'LaunchDarkly reports active for at least one non-archived environment.',
	},
	{
		id: 'inactive',
		label: 'inactive',
		scope: 'all environments',
		description:
			'LaunchDarkly reports inactive for every non-archived environment whose status could be loaded.',
	},
	{
		id: 'launched',
		label: 'launched',
		scope: 'any environment',
		description:
			'LaunchDarkly reports launched for at least one non-archived environment.',
	},
	{
		id: MIGRATED_FILTER_ID,
		label: 'previously-migrated',
		scope: 'flag',
		description:
			'A matching flag already exists in Datadog (its targeting rules may still differ).',
	},
	{
		id: NOT_MIGRATED_FILTER_ID,
		label: 'not-yet-migrated',
		scope: 'flag',
		description: 'No matching flag exists in Datadog yet.',
	},
];

type LDFlagStatusByEnv = Map<string, Map<string, LDFlagStatus> | null>;

/**
 * Collapse per-environment LD statuses for a single flag into filter
 * categories across all non-archived environments. Active/new/launched are
 * "any environment" categories. Inactive is an "all environments" category.
 *
 * A null environment entry means the status fetch failed; flags with no
 * positive status in that case stay uncategorized rather than being treated as
 * inactive everywhere.
 */
export function flagCategories(
	flagKey: string,
	statusByEnv: LDFlagStatusByEnv,
): string[] {
	const found = new Set<LDFlagStatus>();
	let hasUnknownEnvironment = false;
	let hasKnownEnvironment = false;
	for (const statuses of statusByEnv.values()) {
		if (statuses === null) {
			hasUnknownEnvironment = true;
			continue;
		}
		hasKnownEnvironment = true;
		found.add(statuses.get(flagKey) ?? 'inactive');
	}
	const positive = [...found].filter((status) => status !== 'inactive');
	if (positive.length > 0) return positive;
	if (!hasKnownEnvironment || hasUnknownEnvironment) return [];
	return ['inactive'];
}

async function selectFlags(
	flags: LDFlag[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	previouslySelected: LDFlag[] = [],
	conflictResolution?: ConflictResolution,
	statusByEnv: LDFlagStatusByEnv = new Map(),
): Promise<LDFlag[] | null> {
	let inDatadogCount = 0;
	let prefixedCount = 0;
	let skipCount = 0;
	for (const f of flags) {
		const c = classifyConflict(datadogFlags, projectKey, f.key);
		if (c.type === 'same_project' || c.type === 'manual') {
			inDatadogCount++;
		} else if (c.type === 'cross_project') {
			if (conflictResolution?.action === 'prefix') prefixedCount++;
			else skipCount++;
		} else if (conflictResolution?.action === 'prefix') {
			prefixedCount++;
		}
	}
	const previousKeys = new Set(previouslySelected.map((f) => f.key));

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(flags.length))} feature flags in the project`,
		),
	);
	if (inDatadogCount > 0) {
		console.log(
			chalk.gray(
				`  ${inDatadogCount} flag(s) already exist in Datadog (will sync targeting for new environments) `,
			) + chalk.green('✓'),
		);
	}
	if (prefixedCount > 0) {
		console.log(
			chalk.hex('#632CA6')(
				`  ${prefixedCount} flag(s) will be prefixed with ${(conflictResolution as { action: 'prefix'; prefix: string }).prefix}`,
			),
		);
	}
	if (skipCount > 0) {
		console.log(
			chalk.red(
				`  ${skipCount} flag(s) have key conflicts and will be skipped`,
			),
		);
	}
	console.log();

	const sortedFlags = flags.slice().sort((a, b) => {
		const aType = classifyConflict(datadogFlags, projectKey, a.key).type;
		const bType = classifyConflict(datadogFlags, projectKey, b.key).type;
		const aDD = aType === 'same_project' || aType === 'manual' ? 0 : 1;
		const bDD = bType === 'same_project' || bType === 'manual' ? 0 : 1;
		if (aDD !== bDD) return aDD - bDD;
		return a.name.localeCompare(b.name);
	});

	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

	return filterableCheckbox<LDFlag>({
		message: 'Select flags to migrate to Datadog:',
		choices: sortedFlags.map((flag) => {
			const conflictType = classifyConflict(
				datadogFlags,
				projectKey,
				flag.key,
			).type;
			return {
				name: flagLabel(flag, datadogFlags, projectKey, conflictResolution),
				value: flag,
				checked: previousKeys.has(flag.key),
				migrated: conflictType === 'same_project' || conflictType === 'manual',
				categories: flagCategories(flag.key, statusByEnv),
			};
		}),
		pageSize,
		filterCategories: LD_FILTER_CATEGORIES,
	});
}

// ─── Flag Detail Loading ─────────────────────────────────────────────────────

/** Fetch full flag details (with environment configs) for selected flags. */
async function loadFlagDetails(
	ldApiKey: string,
	projectKey: string,
	flags: LDFlag[],
	options?: { onProgress?: (loaded: number, total: number) => void },
): Promise<LDFlag[]> {
	const detailed: LDFlag[] = [];
	const total = flags.length;
	for (const flag of flags) {
		if (flag.environments) {
			detailed.push(flag);
		} else {
			const full = await fetchFlag(ldApiKey, projectKey, flag.key);
			detailed.push(full);
		}
		options?.onProgress?.(detailed.length, total);
	}
	return detailed;
}

// ─── Migration Execution ─────────────────────────────────────────────────────

type ConfirmAction = 'migrate' | 'select-more' | 'cancel';

interface MigrationOptions {
	ldApiKey: string;
	projectKey: string;
	projectName: string;
	ddApiKey: string;
	ddAppKey: string;
	ddSite: string;
	dryRun: boolean;
	conflictResolution?: ConflictResolution;
	nonInteractive?: boolean;
	doExport?: boolean;
	targetKeyBySource?: Map<string, string>;
}

async function executeMigration(
	flags: LDFlag[],
	envMapping: Map<string, DatadogEnvironment>,
	datadogFlags: DatadogFlagEntry[],
	selectedEnvs: string[],
	opts: MigrationOptions,
): Promise<ConfirmAction> {
	const {
		ldApiKey,
		projectKey,
		projectName,
		ddApiKey,
		ddAppKey,
		ddSite,
		dryRun,
		conflictResolution,
		nonInteractive,
		doExport,
		targetKeyBySource,
	} = opts;

	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to migrate.'));
		if (nonInteractive) return 'cancel';
		const action = await select<'select-more' | 'cancel'>({
			message: 'What would you like to do?',
			choices: [
				{ name: 'Select flags', value: 'select-more' },
				{ name: 'Cancel', value: 'cancel' },
			],
		});
		return action;
	}

	console.log();
	console.log(
		chalk.bold(`You selected ${chalk.green(String(flags.length))} flag(s):`),
	);
	for (const f of flags) {
		console.log(chalk.gray(`  •  ${f.name}`) + chalk.dim(`  (${f.key})`));
	}
	console.log();

	if (!nonInteractive) {
		const action = await select<ConfirmAction>({
			message: dryRun
				? `Simulate migration of ${flags.length} flag(s)?`
				: `Migrate ${flags.length} flag(s) to Datadog?`,
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

	// Fetch full flag details for selected flags
	const detailSpinner = createSpinner(
		`Fetching details for ${flags.length} flag(s)… (0/${flags.length} downloaded)`,
	).start();
	let detailedFlags: LDFlag[];
	try {
		detailedFlags = await loadFlagDetails(ldApiKey, projectKey, flags, {
			onProgress: (loaded, total) => {
				detailSpinner.text = `Fetching details for ${total} flag(s)… (${loaded}/${total} downloaded)`;
			},
		});
		detailSpinner.succeed(`Loaded details for ${detailedFlags.length} flag(s)`);
	} catch (err) {
		detailSpinner.fail('Failed to fetch flag details');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		return 'cancel';
	}

	// Discover teams with edit access via RBAC (project-level)
	let projectEditorTeamKeys = new Set<string>();
	const roleSpinner = createSpinner('Fetching custom roles and teams…').start();
	try {
		const [customRoles, teamsWithRoles] = await Promise.all([
			fetchCustomRoles(ldApiKey),
			fetchTeamsWithRoles(ldApiKey),
		]);

		if (customRoles.length === 0 && teamsWithRoles.length === 0) {
			roleSpinner.warn(
				'Custom Roles API not available — restriction policy editor teams will be skipped (requires Enterprise plan)',
			);
		} else {
			const editorRoleKeys = findProjectEditorRoleKeys(customRoles, projectKey);
			projectEditorTeamKeys = findTeamsWithEditAccess(
				teamsWithRoles,
				editorRoleKeys,
			);

			if (projectEditorTeamKeys.size > 0) {
				roleSpinner.succeed(
					`Found ${projectEditorTeamKeys.size} team(s) with edit access to project "${projectKey}"`,
				);
			} else {
				roleSpinner.warn(
					`No teams found with edit access to project "${projectKey}"`,
				);
			}
		}
	} catch (err) {
		roleSpinner.warn(`Could not resolve team access: ${formatAxiosError(err)}`);
	}

	// Detect LD→DD team key mismatches and prompt for interactive mapping
	let teamKeyMapping: Map<string, string> | undefined;
	let ddHandleToId = new Map<string, string>();
	let ddTeamsFetchFailed = false;
	const ldTeamKeys = [...projectEditorTeamKeys];

	if (ldTeamKeys.length > 0) {
		const teamSpinner = createSpinner('Fetching Datadog teams…').start();
		try {
			const ddTeams = await fetchDatadogTeams(ddApiKey, ddAppKey, ddSite);
			teamSpinner.succeed(`Found ${ddTeams.length} Datadog team(s)`);

			ddHandleToId = new Map(ddTeams.map((t) => [t.handle, t.id]));
			const ddHandles = new Set(ddTeams.map((t) => t.handle));
			const mismatched = [...ldTeamKeys].filter((k) => !ddHandles.has(k));

			if (mismatched.length > 0) {
				console.log();
				console.log(
					chalk.yellow(
						`  ${mismatched.length} LD team key(s) do not match any Datadog team handle:`,
					),
				);
				for (const key of mismatched) {
					console.log(chalk.yellow(`    • ${key}`));
				}
				console.log();

				const shouldMap = nonInteractive
					? false
					: await confirm({
							message:
								'Would you like to map these to Datadog team handles now?',
							default: true,
						});

				if (shouldMap) {
					teamKeyMapping = new Map<string, string>();
					for (const ldKey of mismatched) {
						const ddHandle = await promptForTeamMapping(ldKey, ddTeams);
						if (ddHandle) {
							teamKeyMapping.set(ldKey, ddHandle);
						}
					}
					if (teamKeyMapping.size > 0) {
						console.log();
						console.log(
							chalk.green(`  Mapped ${teamKeyMapping.size} team key(s)`),
						);
					}
				}
			}
		} catch (err) {
			ddTeamsFetchFailed = true;
			teamSpinner.warn(
				`Could not fetch Datadog teams: ${formatAxiosError(err)}`,
			);
		}
	}

	// Resolve LD editor-team keys to Datadog team UUIDs once. Skip-and-warn for
	// any team handle we can't resolve to a DD team ID — sending the bare
	// handle to the restriction-policy API would silently produce a broken
	// principal and undermine the access controls this feature exists to set.
	const editorTeamIds: string[] = [];
	const editorTeamHandles: string[] = [];
	const unresolvedEditorTeams: string[] = [];
	if (!ddTeamsFetchFailed) {
		for (const ldKey of projectEditorTeamKeys) {
			const ddHandle = teamKeyMapping?.get(ldKey) ?? ldKey;
			const ddId = ddHandleToId.get(ddHandle);
			if (ddId) {
				editorTeamIds.push(ddId);
				editorTeamHandles.push(ddHandle);
			} else {
				unresolvedEditorTeams.push(ddHandle);
			}
		}
	}
	if (ddTeamsFetchFailed && projectEditorTeamKeys.size > 0) {
		console.log(
			chalk.yellow(
				`  ⚠ Skipping restriction policy because Datadog teams could not be fetched.`,
			),
		);
		console.log(
			chalk.dim(
				'    Editor access will not be granted on migrated flags. Verify the Datadog application key has the teams_read scope and rerun.',
			),
		);
	} else if (unresolvedEditorTeams.length > 0) {
		console.log(
			chalk.yellow(
				`  ⚠ Skipping ${unresolvedEditorTeams.length} editor team(s) without a matching Datadog team handle: ${unresolvedEditorTeams.join(', ')}`,
			),
		);
		console.log(
			chalk.dim(
				'    These teams will not be granted editor access on migrated flags.',
			),
		);
	}

	// ── Phase 1: Migrate segments as saved filters ─────────────────────────────
	let savedFilterLookup = new Map<string, string>();
	let segmentConstantLookup = new Map<string, boolean>();
	let phase1Subheader: string | undefined;
	let segmentMigrationStats: LDMigrationFile['segmentMigration'];
	if (dryRun) {
		try {
			const segmentResult = await planDryRunSegments({
				ldApiKey,
				projectKey,
				selectedFlags: detailedFlags,
				envMapping,
			});
			savedFilterLookup = segmentResult.savedFilterLookup;
			segmentConstantLookup = segmentResult.segmentConstantLookup;
		} catch (err) {
			console.log(
				chalk.yellow(
					`  ⚠ Segment dry-run planning failed: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
			console.log(
				chalk.dim(
					'    Falling back to synthetic saved-filter IDs; empty segment folding may be inaccurate.',
				),
			);
			const refs = discoverSegmentRefs(detailedFlags, [...envMapping.keys()]);
			for (let i = 0; i < refs.length; i++) {
				const { segmentKey, envKey, negated } = refs[i];
				savedFilterLookup.set(
					`${segmentKey}:${envKey}:${negated}`,
					`dry-run-placeholder-${i}`,
				);
			}
		}
	} else {
		try {
			const segmentResult = await migrateSegments({
				ldApiKey,
				projectKey,
				selectedFlags: detailedFlags,
				envMapping,
				ddApiKey,
				ddAppKey,
				ddSite,
			});
			savedFilterLookup = segmentResult.savedFilterLookup;
			segmentConstantLookup = segmentResult.segmentConstantLookup;
			segmentMigrationStats = segmentResult.stats;
			if (segmentResult.stats.discovered > 0) {
				const {
					created: sc,
					reused: sr,
					updated: su,
					skipped: ss,
				} = segmentResult.stats;
				phase1Subheader =
					chalk.gray('Phase 1 — Segments: ') +
					chalk.green(String(sc)) +
					chalk.gray(' created · ') +
					chalk.white(String(sr)) +
					chalk.gray(` reused (${su} updated) · `) +
					chalk.yellow(String(ss)) +
					chalk.gray(' skipped as saved filters');
			}
		} catch (err) {
			console.log(
				chalk.yellow(
					`  ⚠ Segment migration failed: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
			console.log(
				chalk.dim('    Flags with segmentMatch clauses will be skipped.'),
			);
		}
	}

	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run — no flags will be created\n'));
	}
	console.log();

	let created = 0,
		synced = 0,
		skipped = 0,
		errored = 0;
	let totalEnabled = 0;
	const failures: Array<{ key: string; error: string }> = [];
	const enableFailures: Array<{ key: string; env: string; error: string }> = [];
	const restrictionPolicyFailures: Array<{ key: string; error: string }> = [];
	const skippedFlags: Array<{ key: string; reason: string }> = [];
	const syncedFlagKeys: string[] = [];
	const semverForcedClientKeys: string[] = [];
	const jsonArrayWrappedKeys: string[] = [];
	const dryRunRequests: Array<{ method: string; path: string; body: unknown }> =
		[];
	const sourceFlagKeysForReport = detailedFlags.map((flag) => flag.key);
	const runtimeFlagKeyMapping = new Map<string, string>();
	const flagKeyMappingsForReport = ():
		| Array<{ sourceKey: string; datadogKey: string }>
		| undefined =>
		buildFlagKeyMappingsForReport(
			sourceFlagKeysForReport,
			targetKeyBySource,
			runtimeFlagKeyMapping,
		);
	const reservedDatadogKeys = new Set(datadogFlags.map((flag) => flag.key));
	const recordDatadogKeyMapping = (
		sourceKey: string,
		datadogKey: string,
	): void => {
		if (datadogKey !== sourceKey)
			runtimeFlagKeyMapping.set(sourceKey, datadogKey);
	};
	let runner: MigrationRunnerHandle | undefined;

	const environmentMappingArr: LDMigrationFile['environmentMapping'] = [];
	for (const [ldEnvKey, ddEnv] of envMapping) {
		environmentMappingArr.push({
			sourceEnvId: ldEnvKey,
			sourceEnvName: ldEnvKey,
			datadogEnvId: ddEnv.id,
			datadogEnvName: ddEnv.name,
			datadogDdEnvNames: ddEnv.queries,
		});
	}

	const sigintHandler = () => {
		if (runner) runner.finalize();
		else process.stderr.write('\n');
		if (!dryRun && (created > 0 || synced > 0 || errored > 0)) {
			console.log(
				chalk.yellow('\n  Migration interrupted — saving partial results…'),
			);
			const timestamp = new Date().toISOString();
			const migrationData: LDMigrationFile = {
				provider: 'launchdarkly',
				projectKey,
				projectName,
				migratedAt: timestamp,
				success: false,
				summary: { created, synced, skipped, errored, enabled: totalEnabled },
				failures,
				enableFailures,
				skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
				syncedFlagKeys: syncedFlagKeys.length > 0 ? syncedFlagKeys : undefined,
				flagKeyMapping: flagKeyMappingsForReport(),
				segmentMigration: segmentMigrationStats,
				flags: detailedFlags,
				environmentMapping: environmentMappingArr,
			};
			const filename = `migration-${timestamp}.json`;
			if (!fs.existsSync(CONFIG_DIR))
				fs.mkdirSync(CONFIG_DIR, { recursive: true });
			const filepath = path.join(CONFIG_DIR, filename);
			fs.writeFileSync(filepath, JSON.stringify(migrationData, null, 2));
			console.log(chalk.gray(`  Partial migration saved to ${filepath}`));
		}
		console.log(chalk.gray('\n  Bye!'));
		process.exit(130);
	};
	process.once('SIGINT', sigintHandler);
	if (!nonInteractive) clearScreen();
	runner = migrationRunner({
		total: detailedFlags.length,
		subheader: phase1Subheader,
	});
	const activeRunner: MigrationRunnerHandle = runner;
	const settleStats = (): {
		saved: number;
		skipped: number;
		failed: number;
	} => ({ saved: created + synced, skipped, failed: errored });
	const doSkip = (key: string, message: string, reason: string): void => {
		skippedFlags.push({ key, reason });
		skipped++;
		activeRunner.settleFlag({
			status: 'skipped',
			message,
			stats: settleStats(),
		});
	};
	const doCreate = (message: string): void => {
		created++;
		activeRunner.settleFlag({
			status: 'created',
			message,
			stats: settleStats(),
		});
	};
	const doSync = (message: string): void => {
		synced++;
		activeRunner.settleFlag({
			status: 'synced',
			message,
			stats: settleStats(),
		});
	};
	const doFail = (key: string, error: string, message?: string): void => {
		failures.push({ key, error });
		errored++;
		activeRunner.settleFlag({
			status: 'failed',
			message: message ?? `Failed ${chalk.cyan(key)}: ${chalk.red(error)}`,
			stats: settleStats(),
		});
	};
	try {
		for (const flag of detailedFlags) {
			activeRunner.beginFlag(flag.key);
			try {
				// Check skip conditions
				const skipResult = shouldSkipFlag(flag, selectedEnvs);
				if (skipResult.skip) {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — ${skipResult.reason}`,
						skipResult.reason ?? 'Unknown',
					);
					continue;
				}

				// Check progressive rollout status via releases API
				if (skipResult.hasProgressiveRollout) {
					try {
						const release = await fetchFlagRelease(
							ldApiKey,
							projectKey,
							flag.key,
						);
						if (release && isReleaseInProgress(release)) {
							doSkip(
								flag.key,
								`Skipped ${chalk.cyan(flag.key)} — progressive rollout is in progress`,
								'Progressive rollout is in progress',
							);
							continue;
						}
						// Release is complete or not found — safe to migrate
					} catch (_err) {
						doSkip(
							flag.key,
							`Skipped ${chalk.cyan(flag.key)} — failed to check progressive rollout status`,
							'Failed to check progressive rollout status',
						);
						continue;
					}
				}

				if (skipResult.warn) {
					console.log(chalk.yellow(`  ⚠ ${flag.key}: ${skipResult.warn}`));
				}

				if (flag.archived) {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — flag is archived`,
						'Flag is archived',
					);
					continue;
				}

				const variants = buildVariants(flag);
				if (variants.length === 0) {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — no variants`,
						'No variants',
					);
					continue;
				}
				if (hasJsonArrayVariants(flag)) {
					jsonArrayWrappedKeys.push(flag.key);
				}

				const allocationsResult = buildAllocations(
					flag,
					envMapping,
					savedFilterLookup,
					segmentConstantLookup,
				);
				if (!Array.isArray(allocationsResult)) {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — ${allocationsResult.flagSkip}`,
						allocationsResult.flagSkip,
					);
					continue;
				}
				const allocations = allocationsResult;
				const envsToEnable = getEnvsToEnable(flag, envMapping);
				const targetKey = targetKeyBySource?.get(flag.key) ?? flag.key;
				const conflict = nonInteractive
					? classifyNonInteractiveConflict(
							datadogFlags,
							projectKey,
							flag.key,
							targetKey,
						)
					: classifyConflict(datadogFlags, projectKey, flag.key);

				if (nonInteractive && conflict.type === 'duplicate') {
					const existing = conflict.existingFlag;
					const metadata = existing?.migration_metadata;
					const reason =
						`Duplicate Datadog flag key "${targetKey}" already exists` +
						(metadata
							? ` from LaunchDarkly project "${metadata.project_key}"`
							: ' without LaunchDarkly migration metadata');
					doFail(flag.key, reason);
					continue;
				}
				if (
					nonInteractive &&
					conflict.type === 'none' &&
					reservedDatadogKeys.has(targetKey)
				) {
					doFail(
						flag.key,
						`Duplicate Datadog flag key "${targetKey}" was already selected by another flag in this migration`,
					);
					continue;
				}

				let resolvedDdKey = targetKey;
				let appliedPrefix: string | undefined;
				let existingFlagId =
					nonInteractive && conflict.type === 'same_project'
						? conflict.existingFlag?.id
						: undefined;
				if (!nonInteractive) {
					const targetPlan = planInteractiveDatadogTarget(
						datadogFlags,
						projectKey,
						flag.key,
						targetKey,
						conflictResolution,
						reservedDatadogKeys,
					);
					resolvedDdKey = targetPlan.datadogKey;
					if (targetPlan.action === 'sync') {
						existingFlagId = targetPlan.existingFlag.id;
						recordDatadogKeyMapping(flag.key, targetPlan.existingFlag.key);
					} else if (targetPlan.action === 'create') {
						appliedPrefix = targetPlan.appliedPrefix;
					} else {
						const conflictingKey = targetPlan.datadogKey;
						const conflictDesc = describeDatadogKeyConflict(
							targetPlan.conflict,
						);

						activeRunner.finalize();
						const action = await select<'rename' | 'skip'>({
							message: `Datadog flag key ${chalk.cyan(conflictingKey)} ${conflictDesc}. What would you like to do?`,
							choices: [
								{
									name: 'Enter a custom Datadog key for this flag',
									value: 'rename',
								},
								{ name: 'Skip this flag', value: 'skip' },
							],
						});

						if (action === 'skip') {
							activeRunner.beginFlag(flag.key);
							doSkip(
								flag.key,
								`Skipped ${chalk.cyan(flag.key)} — Datadog key ${chalk.cyan(conflictingKey)} already exists`,
								`Key conflict: Datadog flag key "${conflictingKey}" already exists`,
							);
							continue;
						}

						// Prompt for a custom key, re-checking until conflict-free.
						let customKey = '';
						for (;;) {
							customKey = await input({
								message: `Enter a custom Datadog key for ${chalk.cyan(flag.key)}:`,
								validate: (val) => {
									const trimmed = val.trim();
									if (!trimmed) return 'Key cannot be empty';
									if (!/^[a-z0-9_-]+$/.test(trimmed))
										return 'Key must be lowercase alphanumeric with hyphens or underscores';
									return true;
								},
							});
							customKey = customKey.trim();
							const recheckConflict = classifyDatadogKeyConflict(
								datadogFlags,
								projectKey,
								flag.key,
								customKey,
								reservedDatadogKeys,
							);
							if (recheckConflict.type === 'none') break;
							console.log(
								chalk.yellow(
									`  ⚠ Key "${customKey}" ${describeDatadogKeyConflict(recheckConflict)}. Try a different key.`,
								),
							);
						}
						resolvedDdKey = customKey;
						appliedPrefix = undefined;
						activeRunner.beginFlag(flag.key);
					}
				}

				const allRuleCount = allocations.reduce(
					(sum, a) => sum + (a.targeting_rules?.length ?? 0),
					0,
				);
				const allFilterLabel = `${allocations.length} targeting filter(s)`;
				const allRuleLabel =
					allRuleCount > 0 ? `, ${allRuleCount} rule(s)` : '';

				if (existingFlagId) {
					const syncTags = buildFlagTags(
						flag.tags,
						projectKey,
						editorTeamHandles,
					);

					if (envsToEnable.length === 0) {
						// Always sync tags and restriction policy even when no new environments need enabling.
						// Variant deletes are intentionally SKIPPED in this branch: this
						// path performs no allocation rewrite, so deleting a variant
						// could orphan existing DD allocation references (allocations
						// reference variants by UUID). Creates+updates are safe.
						let variantCounts = { added: 0, updated: 0, deleted: 0 };
						if (dryRun) {
							const { variants: existingVariants } = await fetchFlagDetail(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								ddSite,
							);
							const { createUpdateRequests } = buildVariantSyncDryRunRequests(
								existingFlagId,
								variants,
								existingVariants,
								'launchdarkly',
							);
							for (const r of createUpdateRequests) dryRunRequests.push(r);
							variantCounts = {
								added: createUpdateRequests.filter((r) => r.method === 'POST')
									.length,
								updated: createUpdateRequests.filter((r) => r.method === 'PUT')
									.length,
								deleted: 0,
							};
							dryRunRequests.push({
								method: 'PUT',
								path: `/api/v2/feature-flags/${existingFlagId}`,
								body: {
									data: {
										type: 'feature-flags',
										attributes: { tags: syncTags },
									},
								},
							});
							if (hasSemverConditions(allocations)) {
								dryRunRequests.push({
									method: 'PUT',
									path: `/api/v2/feature-flags/${existingFlagId}`,
									body: {
										data: {
											type: 'feature-flags',
											attributes: { distribution_channel: 'CLIENT' },
										},
									},
								});
							}
							if (editorTeamIds.length > 0) {
								const existingBindings = await fetchRestrictionPolicy(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									ddSite,
								);
								dryRunRequests.push(
									buildDryRunRestrictionPolicy(
										existingFlagId,
										editorTeamIds,
										existingBindings,
									),
								);
							}
						} else {
							const result = await syncVariantsCreatesAndUpdates(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								variants,
								'launchdarkly',
								ddSite,
							);
							variantCounts = { ...result.counts, deleted: 0 };
							await updateFlagTags(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								syncTags,
								ddSite,
							);
							if (hasSemverConditions(allocations)) {
								await updateFlagDistributionChannel(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									'CLIENT',
									ddSite,
								);
								semverForcedClientKeys.push(flag.key);
							}
							if (editorTeamIds.length > 0) {
								await applyRestrictionPolicyForFlag(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									editorTeamIds,
									ddSite,
									flag.key,
									restrictionPolicyFailures,
								);
							}
						}
						const policyLabel =
							editorTeamIds.length > 0 ? ' (permissions refreshed)' : '';
						const tagLabel = `${syncTags.length} tag(s)`;
						const variantLabel = formatVariantLabel(variantCounts);
						syncedFlagKeys.push(flag.key);
						doSync(
							dryRun
								? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (${tagLabel}${variantLabel}${policyLabel})`
								: `${chalk.green('✓')} Synced ${chalk.cyan(flag.key)} (${tagLabel}${variantLabel}${policyLabel})`,
						);
						continue;
					}

					activeRunner.printMessage(
						`⚠ ${chalk.cyan(flag.key)} exists in Datadog — targeting filters in ${envsToEnable.map((e) => e.name).join(', ')} will be overwritten`,
					);
					activeRunner.beginFlag(flag.key);

					if (dryRun) {
						const { variants: existingVariantsDry } = await fetchFlagDetail(
							ddApiKey,
							ddAppKey,
							existingFlagId,
							ddSite,
						);
						const { createUpdateRequests, deleteRequests } =
							buildVariantSyncDryRunRequests(
								existingFlagId,
								variants,
								existingVariantsDry,
								'launchdarkly',
							);
						// Variant creates+updates precede allocation PUTs.
						for (const r of createUpdateRequests) dryRunRequests.push(r);
						const variantCountsDry = {
							added: createUpdateRequests.filter((r) => r.method === 'POST')
								.length,
							updated: createUpdateRequests.filter((r) => r.method === 'PUT')
								.length,
							deleted: deleteRequests.length,
						};
						if (hasSemverConditions(allocations)) {
							dryRunRequests.push({
								method: 'PUT',
								path: `/api/v2/feature-flags/${existingFlagId}`,
								body: {
									data: {
										type: 'feature-flags',
										attributes: { distribution_channel: 'CLIENT' },
									},
								},
							});
						}
						let syncFilterCount = 0;
						let syncRuleCount = 0;
						for (const ddEnv of envsToEnable) {
							const syncReqs = toSyncRequests(allocations, ddEnv.id);
							syncFilterCount += syncReqs.length;
							syncRuleCount += syncReqs.reduce(
								(sum, r) => sum + (r.targeting_rules?.length ?? 0),
								0,
							);
							dryRunRequests.push({
								method: 'PUT',
								path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/allocations`,
								body: syncReqs,
							});
							dryRunRequests.push({
								method: 'POST',
								path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/enable`,
								body: {},
							});
						}
						// Variant deletes go AFTER allocation PUTs.
						for (const r of deleteRequests) dryRunRequests.push(r);
						dryRunRequests.push({
							method: 'PUT',
							path: `/api/v2/feature-flags/${existingFlagId}`,
							body: {
								data: {
									type: 'feature-flags',
									attributes: { tags: syncTags },
								},
							},
						});
						if (editorTeamIds.length > 0) {
							const existingBindings = await fetchRestrictionPolicy(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								ddSite,
							);
							dryRunRequests.push(
								buildDryRunRestrictionPolicy(
									existingFlagId,
									editorTeamIds,
									existingBindings,
								),
							);
						}
						const syncFilterLabel = `${syncFilterCount} targeting filter(s)`;
						const syncRuleLabel =
							syncRuleCount > 0 ? `, ${syncRuleCount} rule(s)` : '';
						const tagLabel =
							syncTags.length > 0
								? `, ${syncTags.length} tag(s)`
								: ', tags cleared';
						const variantLabel = formatVariantLabel(variantCountsDry);
						const enableLabel =
							envsToEnable.length > 0
								? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
								: '';
						syncedFlagKeys.push(flag.key);
						doSync(
							`${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} ` +
								`(${syncFilterLabel}${syncRuleLabel}${variantLabel}${tagLabel}${enableLabel})`,
						);
					} else {
						try {
							// Apply variant creates+updates first so allocation
							// variant_id resolution sees new variants. Deletes are
							// deferred until AFTER allocation sync so we never remove
							// a variant while an allocation may still reference it.
							const variantSyncResult = await syncVariantsCreatesAndUpdates(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								variants,
								'launchdarkly',
								ddSite,
							);
							const variantCounts = variantSyncResult.counts;
							if (hasSemverConditions(allocations)) {
								await updateFlagDistributionChannel(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									'CLIENT',
									ddSite,
								);
								semverForcedClientKeys.push(flag.key);
							}
							let syncedAllocCount = 0;
							let syncedRuleCount = 0;
							for (const ddEnv of envsToEnable) {
								const syncReqs = toSyncRequests(allocations, ddEnv.id);
								await syncAllocationsForEnvironment(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									ddEnv.id,
									syncReqs,
									ddSite,
								);
								syncedAllocCount += syncReqs.length;
								syncedRuleCount += syncReqs.reduce(
									(sum, r) => sum + (r.targeting_rules?.length ?? 0),
									0,
								);
							}

							// Now safe to delete: allocations no longer reference these.
							await applyVariantDeletes(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								variantSyncResult.pendingDeletes,
								ddSite,
							);

							// Update tags on existing flag (replace so removals propagate)
							await updateFlagTags(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								syncTags,
								ddSite,
							);

							// Apply restriction policy for LD editor teams
							if (editorTeamIds.length > 0) {
								await applyRestrictionPolicyForFlag(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									editorTeamIds,
									ddSite,
									flag.key,
									restrictionPolicyFailures,
								);
							}

							let enabledCount = 0;
							for (const ddEnv of envsToEnable) {
								try {
									await enableFeatureFlagEnvironment(
										ddApiKey,
										ddAppKey,
										existingFlagId,
										ddEnv.id,
										ddSite,
									);
									enabledCount++;
								} catch (err) {
									enableFailures.push({
										key: flag.key,
										env: ddEnv.name,
										error: formatAxiosError(err),
									});
								}
							}

							totalEnabled += enabledCount;
							const syncedRuleLabel =
								syncedRuleCount > 0 ? `, ${syncedRuleCount} rule(s)` : '';
							const tagLabel =
								syncTags.length > 0
									? `, ${syncTags.length} tag(s)`
									: ', tags cleared';
							const variantLabel = formatVariantLabel(variantCounts);
							const enableLabel =
								enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
							syncedFlagKeys.push(flag.key);
							doSync(
								`${chalk.green('✓')} Synced ${chalk.cyan(flag.key)} (${syncedAllocCount} targeting filter(s)${syncedRuleLabel}${variantLabel}${tagLabel}${enableLabel})`,
							);
						} catch (err) {
							const error = formatAxiosError(err);
							doFail(
								flag.key,
								error,
								`Failed to sync ${chalk.cyan(flag.key)}: ${chalk.red(error)}`,
							);
						}
					}
				} else {
					const ddKey = resolvedDdKey;
					reservedDatadogKeys.add(ddKey);
					recordDatadogKeyMapping(flag.key, ddKey);

					const tags = buildFlagTags(flag.tags, projectKey, editorTeamHandles);

					const request: DatadogCreateFlagRequest = {
						key: ddKey,
						name: flag.name,
						value_type: mapFlagType(flag),
						variants,
						allocations: allocations.length > 0 ? allocations : undefined,
						migration_metadata: {
							project_key: projectKey,
							flag_key: flag.key,
							...(appliedPrefix ? { key_prefix: appliedPrefix } : {}),
						},
						...(tags.length > 0 ? { tags } : {}),
						...(hasSemverConditions(allocations)
							? { distribution_channel: 'CLIENT' }
							: {}),
					};

					if (dryRun) {
						dryRunRequests.push({
							method: 'POST',
							path: '/api/v2/feature-flags',
							body: { data: { type: 'feature-flags', attributes: request } },
						});
						for (const ddEnv of envsToEnable) {
							dryRunRequests.push({
								method: 'POST',
								path: `/api/v2/feature-flags/<uuid-for-${ddKey}>/environments/${ddEnv.id}/enable`,
								body: {},
							});
						}

						if (editorTeamIds.length > 0) {
							dryRunRequests.push(
								buildDryRunRestrictionPolicy(
									`<uuid-for-${ddKey}>`,
									editorTeamIds,
									[],
									'Approximate — dd-source adds a creator-team principal on flag creation before this POST runs; that principal is not reflected here.',
								),
							);
						}

						const enableLabel =
							envsToEnable.length > 0
								? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
								: '';
						doCreate(
							`${chalk.dim('[dry run]')} Would create ${chalk.cyan(ddKey)} ` +
								`(${allFilterLabel}${allRuleLabel}${enableLabel})`,
						);
					} else {
						try {
							const createdFlag = await createFeatureFlag(
								ddApiKey,
								ddAppKey,
								request,
								ddSite,
							);
							if (hasSemverConditions(allocations)) {
								semverForcedClientKeys.push(flag.key);
							}

							// Apply restriction policy for LD editor teams
							if (editorTeamIds.length > 0) {
								await applyRestrictionPolicyForFlag(
									ddApiKey,
									ddAppKey,
									createdFlag.id,
									editorTeamIds,
									ddSite,
									flag.key,
									restrictionPolicyFailures,
								);
							}

							let enabledCount = 0;
							for (const ddEnv of envsToEnable) {
								try {
									await enableFeatureFlagEnvironment(
										ddApiKey,
										ddAppKey,
										createdFlag.id,
										ddEnv.id,
										ddSite,
									);
									enabledCount++;
								} catch (err) {
									enableFailures.push({
										key: flag.key,
										env: ddEnv.name,
										error: formatAxiosError(err),
									});
								}
							}

							totalEnabled += enabledCount;
							const enableLabel =
								enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
							doCreate(
								`${chalk.green('✓')} Created ${chalk.cyan(ddKey)} (${allFilterLabel}${allRuleLabel}${enableLabel})`,
							);
						} catch (err) {
							const error = formatAxiosError(err);
							doFail(
								flag.key,
								error,
								`Failed ${chalk.cyan(ddKey)}: ${chalk.red(error)}`,
							);
						}
					}
				}
			} catch (err) {
				const error = formatAxiosError(err);
				doFail(flag.key, error);
			}
		}
	} finally {
		process.removeListener('SIGINT', sigintHandler);
		activeRunner.finalize();
	}

	// ─── Summary ───────────────────────────────────────────────────────────────
	await renderStatic(
		<LDMigrationSummary
			dryRun={dryRun}
			counts={{ created, synced, skipped, errored, enabled: totalEnabled }}
			failures={failures}
			enableFailures={enableFailures}
			restrictionPolicyFailures={restrictionPolicyFailures}
		/>,
	);

	// ─── Persist Results ───────────────────────────────────────────────────────
	const timestamp = new Date().toISOString();
	let outputData: unknown;

	if (dryRun) {
		const dryRunData = {
			provider: 'launchdarkly',
			migratedAt: timestamp,
			success: errored === 0,
			summary: { created, synced, skipped, errored, enabled: 0 },
			failures,
			enableFailures: [],
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			flags: detailedFlags.map((f) => ({
				key: f.key,
				name: f.name,
				kind: f.kind,
			})),
			flagKeyMapping: flagKeyMappingsForReport(),
			environmentMapping: environmentMappingArr,
			requests: dryRunRequests,
		};
		outputData = dryRunData;
		if (dryRunRequests.length > 0) {
			const filename = `dry-run-${timestamp}.json`;
			const filepath = path.join(process.cwd(), filename);
			fs.writeFileSync(filepath, JSON.stringify(dryRunData, null, 2));
			console.log(chalk.gray(`  Requests written to ${filepath}`));
		}
	}

	if (!dryRun) {
		const migrationData: LDMigrationFile = {
			provider: 'launchdarkly',
			projectKey,
			projectName,
			migratedAt: timestamp,
			success: errored === 0,
			summary: { created, synced, skipped, errored, enabled: totalEnabled },
			failures,
			enableFailures,
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			syncedFlagKeys: syncedFlagKeys.length > 0 ? syncedFlagKeys : undefined,
			semverForcedClientKeys:
				semverForcedClientKeys.length > 0 ? semverForcedClientKeys : undefined,
			jsonArrayWrappedKeys:
				jsonArrayWrappedKeys.length > 0 ? jsonArrayWrappedKeys : undefined,
			flagKeyMapping: flagKeyMappingsForReport(),
			segmentMigration: segmentMigrationStats,
			flags: detailedFlags,
			environmentMapping: environmentMappingArr,
		};
		outputData = migrationData;
		if (created > 0 || synced > 0 || errored > 0) {
			const filename = `migration-${timestamp}.json`;
			if (!fs.existsSync(CONFIG_DIR))
				fs.mkdirSync(CONFIG_DIR, { recursive: true });
			const filepath = path.join(CONFIG_DIR, filename);
			fs.writeFileSync(filepath, JSON.stringify(migrationData, null, 2));
			console.log(chalk.gray(`  Migration saved to ${filepath}`));

			let exportToSheets: boolean;
			if (nonInteractive) {
				exportToSheets = doExport ?? false;
			} else {
				exportToSheets = await confirm({
					message:
						'Would you like to export migration results to an .xlsx file?',
					default: false,
				});
			}
			if (exportToSheets) {
				const { exportLDMigrationToXlsx } = await import('./helpers/xlsx.js');
				await exportLDMigrationToXlsx(migrationData);
			}
		}
	}

	if (nonInteractive && outputData) {
		writeJsonOutput(outputData);
	}

	console.log();
	if (nonInteractive && errored > 0) process.exitCode = 1;
	return 'migrate';
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export interface LDNonInteractiveOptions {
	projectKey: string;
	envMap: Array<[string, string]>;
	flagKeys: string[];
}

export interface RunLaunchDarklyMigrationOptions {
	nonInteractive?: LDNonInteractiveOptions;
	doExport?: boolean;
}

export async function runLaunchDarklyMigration(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	options?: RunLaunchDarklyMigrationOptions,
): Promise<void> {
	// LAUNCHDARKLY_API_KEY presence was validated in src/index.ts before this runs.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const ldApiKey = process.env.LAUNCHDARKLY_API_KEY!.trim();

	if (options?.nonInteractive) {
		await runLaunchDarklyMigrationNonInteractive(
			ldApiKey,
			ddApiKey,
			ddAppKey,
			ddSite,
			dryRun,
			options.nonInteractive,
			options.doExport ?? false,
		);
		return;
	}

	// Fetch projects from LD API
	clearScreen();
	await printHeader();
	if (dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
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

	// Select a project
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

	// Fetch flags, project environments, and DD data in parallel
	const loadSpinner = createSpinner('Fetching flags and Datadog data…').start();
	let allFlags: LDFlag[];
	let ldEnvironments: LDEnvironment[];
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];
	try {
		[allFlags, ldEnvironments, datadogFlags, datadogEnvs] = await Promise.all([
			fetchFlags(ldApiKey, selectedProject.key),
			fetchProjectEnvironments(ldApiKey, selectedProject.key),
			fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
			fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
		]);
		loadSpinner.succeed(
			`Loaded ${allFlags.length} LD flag(s) · ${ldEnvironments.length} LD environment(s) · ${datadogFlags.length} Datadog flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		loadSpinner.fail('Failed to load data');
		if (axios.isAxiosError(err)) {
			const url = err.config?.url ?? 'unknown URL';
			const status = err.response?.status ?? 'no status';
			const msg =
				(err.response?.data as { message?: string } | undefined)?.message ??
				err.message;
			console.error(
				chalk.red(
					`  ${err.config?.method?.toUpperCase() ?? 'GET'} ${url} → ${status}: ${msg}`,
				),
			);
		} else if (err instanceof Error) {
			console.error(chalk.red(`  ${err.message}`));
		}
		return;
	}

	if (allFlags.length === 0) {
		console.log(chalk.yellow('\n  No flags found in this project.\n'));
		return;
	}

	// Detect prefix used by previously-migrated flags for this project
	const alreadyMigratedForProject = datadogFlags.filter(
		(f) => f.migration_metadata?.project_key === selectedProject.key,
	);
	let detectedPrefix: string | undefined;
	for (const f of alreadyMigratedForProject) {
		const storedPrefix = f.migration_metadata?.key_prefix;
		if (storedPrefix) {
			// New format already includes separator; old format does not — infer from key
			if (/[-_]$/.test(storedPrefix)) {
				detectedPrefix = storedPrefix;
			} else {
				const origKey = f.migration_metadata?.flag_key;
				if (origKey && f.key.endsWith(`-${origKey}`))
					detectedPrefix = `${storedPrefix}-`;
				else if (origKey && f.key.endsWith(`_${origKey}`))
					detectedPrefix = `${storedPrefix}_`;
				else detectedPrefix = `${storedPrefix}-`;
			}
			break;
		}
		// Fallback: no key_prefix stored — infer separator from key vs original key
		const origKey = f.migration_metadata?.flag_key;
		if (origKey && f.key !== origKey) {
			if (f.key.endsWith(`-${origKey}`))
				detectedPrefix = f.key.slice(0, f.key.length - origKey.length);
			else if (f.key.endsWith(`_${origKey}`))
				detectedPrefix = f.key.slice(0, f.key.length - origKey.length);
			if (detectedPrefix) break;
		}
	}

	// Always prompt for prefix before flag selection
	console.log();
	type PrefixAction = 'skip' | 'use-detected' | 'custom';
	const prefixChoices: { name: string; value: PrefixAction }[] = [
		...(detectedPrefix
			? [
					{
						name: `Use existing prefix "${detectedPrefix}"`,
						value: 'use-detected' as PrefixAction,
					},
				]
			: [
					{
						name: 'Add a prefix to flag keys',
						value: 'custom' as PrefixAction,
					},
				]),
		...(detectedPrefix
			? [{ name: 'Add a prefix to flag keys', value: 'custom' as PrefixAction }]
			: []),
		{ name: 'Skip — no prefix', value: 'skip' },
	];

	const prefixAction = await select<PrefixAction>({
		message: 'Would you like to add a prefix to all migrated flag keys?',
		choices: prefixChoices,
	});

	let conflictResolution: ConflictResolution;
	if (prefixAction === 'skip') {
		conflictResolution = { action: 'skip' };
	} else if (prefixAction === 'use-detected') {
		// detectedPrefix is guaranteed non-undefined when this option appears
		// biome-ignore lint/style/noNonNullAssertion: only offered when detectedPrefix is set
		conflictResolution = { action: 'prefix', prefix: detectedPrefix! };
	} else {
		const prefix = await input({
			message: 'Enter a prefix for flag keys:',
			validate: (val) => {
				const trimmed = val.trim();
				if (trimmed.length === 0) return 'Prefix cannot be empty';
				if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed))
					return 'Prefix must contain only lowercase letters, numbers, hyphens, or underscores';
				if (!/[-_]$/.test(trimmed)) return 'Prefix must end with - or _';
				return true;
			},
		});
		conflictResolution = { action: 'prefix', prefix: prefix.trim() };
	}

	let prevSelectedEnvKeys: string[] = [];
	let prevEnvMapping = new Map<string, DatadogEnvironment>();
	let prevSelectedFlags: LDFlag[] = [];
	const statusEnvs = ldEnvironments.filter((env) => !env.archived);
	// Cache of LD flag lifecycle statuses per non-archived environment key,
	// fetched lazily and reused across re-selection loops.
	const statusByEnv: LDFlagStatusByEnv = new Map();

	// eslint-disable-next-line no-constant-condition
	outer: while (true) {
		// Select LD environments
		clearScreen();
		await printHeader();
		const envResult = await selectLDEnvironments(
			ldEnvironments,
			prevSelectedEnvKeys,
		);
		if (envResult === null) break;
		if (envResult.length === 0) {
			console.log(
				chalk.yellow(
					'\n  Please select at least one environment to migrate from.\n',
				),
			);
			continue;
		}
		prevSelectedEnvKeys = envResult.map((e) => e.key);

		// Fetch flag lifecycle statuses for all non-archived environments so the
		// advanced-filter screen can answer "active anywhere" and "inactive
		// everywhere". Failures are non-fatal — filtering simply treats affected
		// flags as uncategorized unless another environment proves a positive
		// status. Fetched lazily and cached, so re-selection loops stay silent.
		const envsToLoad = statusEnvs.filter((env) => !statusByEnv.has(env.key));
		if (envsToLoad.length > 0) {
			const statusSpinner = createSpinner(
				'Loading LaunchDarkly flag statuses…',
			).start();
			let failedCount = 0;
			for (const env of envsToLoad) {
				try {
					statusByEnv.set(
						env.key,
						await fetchFlagStatuses(ldApiKey, selectedProject.key, env.key),
					);
				} catch {
					statusByEnv.set(env.key, null);
					failedCount++;
				}
			}
			const loadedCount = envsToLoad.length - failedCount;
			if (failedCount > 0) {
				statusSpinner.warn(
					`Loaded flag statuses for ${loadedCount} environment(s); ${failedCount} could not be loaded (affected flags stay uncategorized)`,
				);
			} else {
				statusSpinner.succeed(
					`Loaded flag statuses for ${loadedCount} environment(s)`,
				);
			}
		}

		// Link LD environments → DD environments
		while (true) {
			const mapping = await linkEnvironments(
				envResult,
				datadogEnvs,
				prevEnvMapping,
			);
			if (mapping === null) break;

			prevEnvMapping = mapping;

			// Select flags
			while (true) {
				clearScreen();
				await printHeader();
				const flagResult = await selectFlags(
					allFlags,
					datadogFlags,
					selectedProject.key,
					prevSelectedFlags,
					conflictResolution,
					statusByEnv,
				);
				if (flagResult === null) break;

				prevSelectedFlags = flagResult;
				clearScreen();
				await printHeader();
				const action = await executeMigration(
					prevSelectedFlags,
					prevEnvMapping,
					datadogFlags,
					prevSelectedEnvKeys,
					{
						ldApiKey,
						projectKey: selectedProject.key,
						projectName: selectedProject.name,
						ddApiKey,
						ddAppKey,
						ddSite,
						dryRun,
						conflictResolution,
					},
				);
				if (action === 'cancel') break outer;
				if (action === 'migrate') break outer;
			}
		}
	}
}

// ─── Non-Interactive Entry Point ─────────────────────────────────────────────

export function resolveLDEnvMap(
	pairs: Array<[string, string]>,
	ldEnvironments: LDEnvironment[],
	datadogEnvs: DatadogEnvironment[],
): { envMapping: Map<string, DatadogEnvironment>; selectedEnvKeys: string[] } {
	const envMapping = new Map<string, DatadogEnvironment>();
	const selectedEnvKeys: string[] = [];
	const ddByName = new Map(datadogEnvs.map((e) => [e.name, e]));
	for (const [src, dst] of pairs) {
		// Match LD env: key first, then name
		const ldEnv =
			ldEnvironments.find((e) => e.key === src) ??
			ldEnvironments.find((e) => e.name === src);
		if (!ldEnv) {
			const available = ldEnvironments
				.filter((e) => !e.archived)
				.map((e) => (e.key === e.name ? e.key : `${e.key} (${e.name})`))
				.join(', ');
			throw new Error(
				`LaunchDarkly environment not found: "${src}". Available: ${available}`,
			);
		}
		if (ldEnv.archived) {
			throw new Error(
				`LaunchDarkly environment "${ldEnv.key}" is archived and cannot be migrated`,
			);
		}
		const ddEnv = ddByName.get(dst);
		if (!ddEnv) {
			const available = datadogEnvs.map((e) => e.name).join(', ');
			throw new Error(
				`Datadog environment not found: "${dst}". Available: ${available}`,
			);
		}
		envMapping.set(ldEnv.key, ddEnv);
		selectedEnvKeys.push(ldEnv.key);
	}
	return { envMapping, selectedEnvKeys };
}

async function runLaunchDarklyMigrationNonInteractive(
	ldApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	ni: LDNonInteractiveOptions,
	doExport: boolean,
): Promise<void> {
	console.log(chalk.gray('  Running in non-interactive mode\n'));
	if (dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	let flagSpecs: LDFlagMigrationSpec[];
	try {
		flagSpecs = parseLDFlagMigrationSpecs(ni.flagKeys);
	} catch (err) {
		console.error(
			chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`),
		);
		process.exit(1);
	}
	const sourceFlagKeys = flagSpecs.map((spec) => spec.sourceKey);
	const targetKeyBySource = new Map(
		flagSpecs.map((spec) => [spec.sourceKey, spec.datadogKey]),
	);

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
		`Fetching ${sourceFlagKeys.length} flag(s) and Datadog data…`,
	).start();
	let selectedFlags: LDFlag[];
	let ldEnvironments: LDEnvironment[];
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];
	try {
		[selectedFlags, ldEnvironments, datadogFlags, datadogEnvs] =
			await Promise.all([
				fetchFlagsByKey(ldApiKey, selectedProject.key, sourceFlagKeys),
				fetchProjectEnvironments(ldApiKey, selectedProject.key),
				fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
				fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
			]);
		loadSpinner.succeed(
			`Loaded ${selectedFlags.length} LD flag(s) · ${ldEnvironments.length} LD environment(s) · ${datadogFlags.length} Datadog flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		loadSpinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		process.exit(1);
	}

	let envMapping: Map<string, DatadogEnvironment>;
	let selectedEnvKeys: string[];
	try {
		({ envMapping, selectedEnvKeys } = resolveLDEnvMap(
			ni.envMap,
			ldEnvironments,
			datadogEnvs,
		));
	} catch (err) {
		console.error(
			chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`),
		);
		process.exit(1);
	}

	await executeMigration(
		selectedFlags,
		envMapping,
		datadogFlags,
		selectedEnvKeys,
		{
			ldApiKey,
			projectKey: selectedProject.key,
			projectName: selectedProject.name,
			ddApiKey,
			ddAppKey,
			ddSite,
			dryRun,
			// Default to skip for cross-project conflicts in non-interactive mode.
			conflictResolution: { action: 'skip' },
			nonInteractive: true,
			doExport,
			targetKeyBySource,
		},
	);
}
