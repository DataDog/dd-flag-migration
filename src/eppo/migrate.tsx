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
import {
	type MigrationRunnerHandle,
	migrationRunner,
} from '../components/MigrationRunner.js';
import { renderStatic } from '../components/mount.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import { formatVariantLabel } from '../components/VariantCounts.js';
import {
	applyVariantDeletes,
	archiveFeatureFlag,
	clearAllocationsForEnvironment,
	createFeatureFlag,
	disableFeatureFlagEnvironmentWithOutcome,
	enableFeatureFlagEnvironmentWithOutcome,
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogTeams,
	fetchFlagDetail,
	fetchFlagReplacementDetails,
	fetchRestrictionPolicy,
	indexDatadogFlagKeys,
	syncAllocationsForEnvironment,
	syncVariantsCreatesAndUpdates,
	unarchiveFeatureFlag,
	updateFlagJsonSchema,
	updateFlagName,
	updateFlagTags,
} from '../datadog/api.js';
import { resolveFlagNameForSync } from '../datadog/flag-names.js';
import {
	buildVariantSyncDryRunRequests,
	eppoSourceIdLookupKey,
} from '../datadog/helpers.js';
import type {
	BucketingMode,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogTeam,
	EnvironmentMapping,
	MigrationEnvironmentMapping,
} from '../datadog/types.js';
import { CONFIG_DIR } from '../helpers/config.js';
import { shouldExportResults } from '../helpers/export.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { toSyncRequests } from '../helpers/migration.js';
import { writeJsonOutput } from '../helpers/output.js';
import {
	computeTargetTags,
	resolveMigrationTargetTags,
	selectMigrationTagMode,
	type TagSyncMode,
} from '../helpers/sync-tags.js';
import { extractEnvironments, fetchEppoFlags, fetchEppoTeams } from './api.js';
import { migrateAudiences } from './audiences.js';
import { EppoMigrationSummary } from './components/EppoMigrationSummary.js';
import {
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	buildEppoFlagTags,
	buildVariants,
	classifyExistingFlag,
	findEppoMigrationBlockers,
	getEnvsToDisable,
	getEnvsToEnable,
	hasJsonArrayVariants,
	indexEppoTeamsByFlagId,
	mapVariationType,
	matchDatadogTeamHandle,
	toCreateFlagVariants,
} from './helpers/migration.js';
import type {
	DryRunFile,
	EppoFlag,
	EppoFlagEnvironment,
	MigrationFile,
} from './types.js';

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.eppo} />);
}

function ddEnvLabel(env: DatadogEnvironment): string {
	const prodBadge = env.is_production
		? `  ${chalk.bgHex('#632CA6').white(' Prod ')}`
		: '';
	return `${env.name}${prodBadge}`;
}

function envLabel(env: EppoFlagEnvironment, flagCount: number): string {
	const prodBadge = env.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : '';
	return `${env.name}${prodBadge}  ${chalk.gray(`(${flagCount} flags)`)}`;
}

export function datadogIdForEppoFlag(
	flag: EppoFlag,
	datadogKeys: Map<string, string>,
): string | undefined {
	return (
		datadogKeys.get(flag.key) ??
		datadogKeys.get(eppoSourceIdLookupKey(String(flag.id)))
	);
}

function archivedEppoMatches(
	flag: EppoFlag,
	datadogFlags: DatadogFlagEntry[],
): DatadogFlagEntry[] {
	const matches = datadogFlags.filter(
		(existing) =>
			!!existing.archived_at &&
			existing.migration_metadata?.provider === 'eppo' &&
			existing.migration_metadata.source_id === String(flag.id),
	);
	// A replacement and its legacy predecessor share a source ID. Prefer the
	// Eppo-bucketed flag, but still reject ambiguity within the preferred group.
	const successors = matches.filter((match) => match.bucketing_mode === 'EPPO');
	return successors.length > 0 ? successors : matches;
}

/**
 * The Datadog flag that `flag` matches if it was migrated before
 * Eppo-compatible bucketing, active or archived. Its bucketing can't change,
 * so switching to Eppo bucketing means replacing it with a new `EPPO` flag.
 */
function legacyFlagFor(
	flag: EppoFlag,
	datadogKeys: Map<string, string>,
	datadogFlags: DatadogFlagEntry[],
): DatadogFlagEntry | undefined {
	const id = datadogIdForEppoFlag(flag, datadogKeys);
	if (id === undefined) return undefined;
	const existing = datadogFlags.find((entry) => entry.id === id);
	return existing !== undefined && classifyExistingFlag(existing) === 'legacy'
		? existing
		: undefined;
}

/** Active matches take precedence; archived flags require a unique source ID match. */
function indexEppoMigrationFlagKeys(
	flags: EppoFlag[],
	datadogFlags: DatadogFlagEntry[],
): Map<string, string> {
	const keys = indexDatadogFlagKeys(
		datadogFlags.filter((flag) => !flag.archived_at),
	);
	for (const flag of flags) {
		if (datadogIdForEppoFlag(flag, keys) !== undefined) continue;
		const matches = archivedEppoMatches(flag, datadogFlags);
		if (matches.length === 1) {
			keys.set(eppoSourceIdLookupKey(String(flag.id)), matches[0].id);
		}
	}
	return keys;
}

function flagLabel(
	flag: EppoFlag,
	datadogKeys: Map<string, string>,
	datadogFlags: DatadogFlagEntry[],
	replaceLegacyFlags: boolean | undefined,
): string {
	const id = datadogIdForEppoFlag(flag, datadogKeys);
	const existing = datadogFlags.find((entry) => entry.id === id);
	const indicator = id !== undefined ? chalk.green('✓') : ' ';
	const key = chalk.gray(`(${flag.key})`);
	let badge = id !== undefined ? chalk.bgGreen.black(' In Datadog ') : '';
	if (existing !== undefined) {
		const state = existing.archived_at ? 'Archived' : 'In Datadog';
		const legacy = classifyExistingFlag(existing) === 'legacy';
		if (legacy && replaceLegacyFlags === true) {
			badge = chalk.bgYellow.black(` ${state} — will replace `);
		} else if (legacy && replaceLegacyFlags === undefined) {
			badge = chalk.bgYellow.black(` ${state} — legacy bucketing `);
		} else if (existing.archived_at) {
			badge = chalk.bgYellow.black(' Archived — will restore ');
		}
	}
	return `${indicator}  ${flag.name}  ${key}${badge ? `  ${badge}` : ''}`;
}

// ─── Prompt Steps ─────────────────────────────────────────────────────────────

export async function linkEnvironments(
	eppoEnvs: EppoFlagEnvironment[],
	ddEnvs: DatadogEnvironment[],
	previousMapping: EnvironmentMapping<number>,
	headerSubtitle: string = HEADER_SUBTITLES.eppo,
): Promise<EnvironmentMapping<number> | null> {
	const selectedIds = new Set(eppoEnvs.map((env) => env.id));
	const mapping = new Map(
		[...previousMapping].filter(([id]) => selectedIds.has(id)),
	);
	let i = 0;
	let requiresSelection = false;

	while (i < eppoEnvs.length) {
		const eppoEnv = eppoEnvs[i];
		const previousIds = new Set(
			(mapping.get(eppoEnv.id) ?? []).map((env) => env.id),
		);
		const assignedElsewhere = new Set(
			[...mapping]
				.filter(([id]) => id !== eppoEnv.id)
				.flatMap(([, environments]) => environments.map((env) => env.id)),
		);
		const availableEnvironments = ddEnvs.filter(
			(env) => !assignedElsewhere.has(env.id),
		);

		clearScreen();
		await renderStatic(<Header subtitle={headerSubtitle} />);
		console.log(
			chalk.bold('Linking environment ') +
				chalk.green(`${i + 1}`) +
				chalk.bold(' of ') +
				chalk.green(`${eppoEnvs.length}`) +
				chalk.bold(':') +
				`  ${chalk.cyan(eppoEnv.name)}` +
				(eppoEnv.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : ''),
		);
		console.log();
		if (requiresSelection) {
			console.log(
				chalk.yellow(
					'  Please select at least one matching Datadog environment.\n',
				),
			);
		}

		const result = await filterableCheckbox<DatadogEnvironment>({
			message: 'Select matching Datadog environments:',
			choices: availableEnvironments.map((env) => ({
				name: ddEnvLabel(env),
				value: env,
				checked: previousIds.has(env.id),
			})),
		});

		if (result === null) {
			requiresSelection = false;
			if (i === 0) return null; // back to Eppo env selection
			i--;
		} else if (result.length === 0) {
			requiresSelection = true;
		} else {
			requiresSelection = false;
			mapping.set(eppoEnv.id, result);
			i++;
		}
	}

	return mapping;
}

export async function selectEnvironments(
	flags: EppoFlag[],
	environments: EppoFlagEnvironment[],
	previouslySelected: EppoFlagEnvironment[] = [],
	message = 'Select environments to migrate from:',
): Promise<EppoFlagEnvironment[] | null> {
	const flagCount = new Map<number, number>();
	for (const flag of flags) {
		for (const env of flag.environments ?? []) {
			flagCount.set(env.id, (flagCount.get(env.id) ?? 0) + 1);
		}
	}

	const previousIds = new Set(previouslySelected.map((e) => e.id));

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(environments.length))} environments in Eppo`,
		),
	);
	console.log();

	const pageSize = Math.max(
		3,
		Math.min(environments.length, (process.stdout.rows ?? 24) - 9),
	);

	return filterableCheckbox<EppoFlagEnvironment>({
		message,
		choices: environments.map((env) => ({
			name: envLabel(env, flagCount.get(env.id) ?? 0),
			value: env,
			checked: previousIds.has(env.id),
		})),
		pageSize,
	});
}

export async function selectFlags(
	flags: EppoFlag[],
	datadogKeys: Map<string, string>,
	selectedEnvs: EppoFlagEnvironment[],
	previouslySelected: EppoFlag[] = [],
	datadogFlags: DatadogFlagEntry[] = [],
	message = 'Select flags to migrate to Datadog:',
	replaceLegacyFlags?: boolean,
): Promise<EppoFlag[] | null> {
	const selectedEnvIds = new Set(selectedEnvs.map((e) => e.id));
	const visibleFlags =
		selectedEnvIds.size > 0
			? flags.filter((f) =>
					f.environments?.some((e) => selectedEnvIds.has(e.id)),
				)
			: flags;

	const inDatadogCount = visibleFlags.filter((f) =>
		datadogIdForEppoFlag(f, datadogKeys),
	).length;
	const previousKeys = new Set(previouslySelected.map((f) => f.key));

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(visibleFlags.length))} feature flags in Eppo`,
		),
	);
	if (inDatadogCount > 0) {
		console.log(
			chalk.gray(`  ${inDatadogCount} flag(s) already exist in Datadog `) +
				chalk.green('✓'),
		);
	}
	console.log();

	const sortedFlags = visibleFlags.slice().sort((a, b) => {
		// Flags already in Datadog float to the top
		const aDD = datadogIdForEppoFlag(a, datadogKeys) ? 0 : 1;
		const bDD = datadogIdForEppoFlag(b, datadogKeys) ? 0 : 1;
		if (aDD !== bDD) return aDD - bDD;
		return a.name.localeCompare(b.name);
	});

	// Reserve lines for: found header (~3), prompt message, filter line, help tip, buffer
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

	return filterableCheckbox<EppoFlag>({
		message,
		choices: sortedFlags.map((flag) => ({
			name: flagLabel(flag, datadogKeys, datadogFlags, replaceLegacyFlags),
			value: flag,
			checked: previousKeys.has(flag.key),
			migrated: datadogIdForEppoFlag(flag, datadogKeys) !== undefined,
		})),
		pageSize,
		filterCategories: EPPO_FILTER_CATEGORIES,
	});
}

/**
 * Advanced-filter categories offered on the Eppo flag-selection screen. Eppo
 * exposes no flag lifecycle/usage-recency signal (its per-environment `active`
 * field is a config on/off toggle, not an evaluation-recency status), so the
 * available categories only describe migration state.
 */
const EPPO_FILTER_CATEGORIES: FilterCategory[] = [
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

type ConfirmAction = 'migrate' | 'select-more' | 'cancel';

/**
 * Ask whether flags migrated before Eppo-compatible bucketing keep Datadog
 * bucketing (false) or are replaced by new Eppo-bucketed flags (true).
 */
async function selectLegacyFlagHandling(
	legacyFlags: DatadogFlagEntry[],
): Promise<boolean> {
	const activeCount = legacyFlags.filter((flag) => !flag.archived_at).length;
	console.log();
	console.log(
		chalk.yellow(
			`  ${legacyFlags.length} selected flag(s) were migrated to Datadog before Eppo-compatible bucketing and use Datadog bucketing, so subjects in splits and partial rollouts are not assigned as in Eppo.`,
		),
	);
	console.log(
		chalk.gray(
			'  Keeping Datadog bucketing syncs these flags as before, restoring any that are archived. Subject assignments in Datadog stay the same.',
		),
	);
	console.log(
		chalk.gray(
			'  Switching replaces each flag with a new Eppo-bucketed flag that has the same key and a new Datadog flag ID. The old flags are archived, and their targeting filters are removed so their keys can be reused.',
		),
	);
	if (activeCount > 0) {
		console.log(
			chalk.yellow(
				`  ${activeCount} of these flag(s) are active. Switching archives them first: they serve no value until their replacements are enabled, their running experiments are cancelled, and subjects Datadog already serves may be assigned differently.`,
			),
		);
	}
	console.log();
	return select<boolean>({
		message: 'How should these flags be migrated?',
		choices: [
			{
				name: 'Keep Datadog bucketing',
				value: false,
				short: 'Keep Datadog bucketing',
			},
			{
				name: 'Switch to Eppo-compatible bucketing — replace the flags',
				value: true,
				short: 'Switch to Eppo-compatible bucketing',
			},
		],
	});
}

/** Prompt the user to select a Datadog team handle for an unmatched Eppo team. */
async function promptForTeamMapping(
	eppoTeamName: string,
	ddTeams: DatadogTeam[],
): Promise<string | null> {
	const pageSize = Math.max(
		5,
		Math.min(ddTeams.length + 1, (process.stdout.rows ?? 24) - 9),
	);

	return filterableSelect<string | null>({
		message: `Map Eppo team "${eppoTeamName}" → Datadog team:`,
		choices: [
			{
				name: chalk.dim('Skip — do not tag flags with this team'),
				value: null,
			},
			...ddTeams.map((t) => ({
				name: `${t.name}  ${chalk.gray(`(${t.handle})`)}`,
				value: t.handle,
			})),
		],
		pageSize,
	});
}

/**
 * Resolve the Datadog team handles for each selected flag's owning Eppo teams,
 * keyed by Eppo flag ID. Only Eppo teams matched to a Datadog team produce
 * `team:*` tags, so no tag points to a nonexistent Datadog team. Permissions
 * are not derived from Eppo teams. A failed lookup skips team tags.
 */
async function resolveEppoTeamHandles(
	flags: EppoFlag[],
	eppoApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	site: string,
	nonInteractive: boolean,
): Promise<Map<number, string[]>> {
	const handlesByFlagId = new Map<number, string[]>();

	const eppoSpinner = createSpinner('Fetching Eppo teams…').start();
	let teamNamesByFlagId: Map<string, string[]>;
	try {
		teamNamesByFlagId = indexEppoTeamsByFlagId(
			await fetchEppoTeams(eppoApiKey),
		);
	} catch (err) {
		eppoSpinner.warn(
			`Could not fetch Eppo teams: ${formatAxiosError(err)} — team tags will be skipped`,
		);
		return handlesByFlagId;
	}
	const teamNames = [
		...new Set(flags.flatMap((f) => teamNamesByFlagId.get(String(f.id)) ?? [])),
	].sort();
	if (teamNames.length === 0) {
		eppoSpinner.succeed('No Eppo teams own the selected flag(s)');
		return handlesByFlagId;
	}
	eppoSpinner.succeed(
		`Found ${teamNames.length} Eppo team(s) owning the selected flag(s)`,
	);

	const ddSpinner = createSpinner('Fetching Datadog teams…').start();
	let ddTeams: DatadogTeam[];
	try {
		ddTeams = await fetchDatadogTeams(ddApiKey, ddAppKey, site);
		ddSpinner.succeed(`Found ${ddTeams.length} Datadog team(s)`);
	} catch (err) {
		ddSpinner.warn(
			`Could not fetch Datadog teams: ${formatAxiosError(err)} — team tags will be skipped`,
		);
		console.log(
			chalk.dim(
				'    Verify the Datadog application key has the teams_read scope and rerun.',
			),
		);
		return handlesByFlagId;
	}

	const handleByTeamName = new Map<string, string>();
	const unmatched: string[] = [];
	for (const name of teamNames) {
		const handle = matchDatadogTeamHandle(name, ddTeams);
		if (handle) handleByTeamName.set(name, handle);
		else unmatched.push(name);
	}

	if (unmatched.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				`  ${unmatched.length} Eppo team(s) do not match any Datadog team:`,
			),
		);
		for (const name of unmatched) {
			console.log(chalk.yellow(`    • ${name}`));
		}
		console.log();

		const shouldMap = nonInteractive
			? false
			: await confirm({
					message: 'Would you like to map these to Datadog teams now?',
					default: true,
				});
		if (shouldMap) {
			for (const name of unmatched) {
				const handle = await promptForTeamMapping(name, ddTeams);
				if (handle) handleByTeamName.set(name, handle);
			}
		}

		const skippedTeams = unmatched.filter((n) => !handleByTeamName.has(n));
		if (skippedTeams.length > 0) {
			console.log(
				chalk.yellow(
					`  ⚠ Skipping team tags for ${skippedTeams.length} Eppo team(s) without a matching Datadog team: ${skippedTeams.join(', ')}`,
				),
			);
		}
	}

	for (const flag of flags) {
		const handles = [
			...new Set(
				(teamNamesByFlagId.get(String(flag.id)) ?? []).flatMap((name) => {
					const handle = handleByTeamName.get(name);
					return handle ? [handle] : [];
				}),
			),
		];
		if (handles.length > 0) handlesByFlagId.set(flag.id, handles);
	}
	return handlesByFlagId;
}

async function confirmMigration(
	flags: EppoFlag[],
	eppoApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	envMapping: EnvironmentMapping<number>,
	datadogKeys: Map<string, string>,
	provider: string,
	site: string,
	dryRun: boolean,
	datadogFlags: DatadogFlagEntry[],
	nonInteractive = false,
	doExport?: boolean,
	configuredTagMode?: TagSyncMode,
	configuredReplaceLegacyFlags?: boolean,
): Promise<ConfirmAction> {
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
	flags.forEach((f) => {
		console.log(chalk.gray(`  •  ${f.name}`) + chalk.dim(`  (${f.key})`));
	});
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

		if (action === 'select-more') {
			return 'select-more';
		}
	}

	const legacyFlags = flags.flatMap((flag) => {
		const legacy = legacyFlagFor(flag, datadogKeys, datadogFlags);
		return legacy ? [legacy] : [];
	});
	// Omitted in non-interactive mode, these flags keep Datadog bucketing.
	let replaceLegacyFlags = configuredReplaceLegacyFlags ?? false;
	if (configuredReplaceLegacyFlags === undefined && legacyFlags.length > 0) {
		if (nonInteractive) {
			console.log(
				chalk.yellow(
					`  ⚠ ${legacyFlags.length} flag(s) were migrated before Eppo-compatible bucketing and keep Datadog bucketing. Pass --replace-legacy-flags to replace them with Eppo-bucketed flags.`,
				),
			);
		} else {
			replaceLegacyFlags = await selectLegacyFlagHandling(legacyFlags);
		}
	}

	let tagSyncMode: TagSyncMode =
		configuredTagMode ?? (nonInteractive ? 'additive' : 'replace');
	if (
		configuredTagMode === undefined &&
		!nonInteractive &&
		flags.some((flag) => datadogIdForEppoFlag(flag, datadogKeys) !== undefined)
	) {
		tagSyncMode = await selectMigrationTagMode();
	}

	const teamHandlesByFlagId = await resolveEppoTeamHandles(
		flags,
		eppoApiKey,
		ddApiKey,
		ddAppKey,
		site,
		nonInteractive,
	);

	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run — no flags will be created\n'));
	}
	console.log();

	const dryRunRequests: Array<{ method: string; path: string; body: unknown }> =
		[];

	// ── Phase 1: Audience migration ──────────────────────────────────────────
	let fingerprintLookup: Map<string, string> | undefined;
	let savedFilterLookup: Map<number, string> | undefined;
	let phase1Subheader: string | undefined;
	try {
		console.log(
			chalk.bold('  Phase 1: Migrating Eppo audiences as saved filters'),
		);
		console.log();
		const audienceResult = await migrateAudiences({
			eppoApiKey,
			ddApiKey,
			ddAppKey,
			ddSite: site,
			dryRun,
		});
		fingerprintLookup = audienceResult.fingerprintLookup;
		savedFilterLookup = audienceResult.savedFilterLookup;
		dryRunRequests.push(...audienceResult.dryRunRequests);
		if (audienceResult.stats.discovered > 0) {
			const {
				created: ac,
				reused: ar,
				updated: au,
				skipped: as_,
			} = audienceResult.stats;
			const createdVerb = dryRun ? 'would be created' : 'created';
			const updatedVerb = dryRun ? 'would update' : 'updated';
			console.log(
				chalk.gray(
					`  Audiences: ${ac} ${createdVerb}, ${ar} reused (${au} ${updatedVerb}), ${as_} skipped as saved filters`,
				),
			);
			phase1Subheader =
				chalk.gray('Phase 1 — Audiences: ') +
				chalk.green(String(ac)) +
				chalk.gray(` ${createdVerb} · `) +
				chalk.white(String(ar)) +
				chalk.gray(` reused (${au} ${updatedVerb}) · `) +
				chalk.yellow(String(as_)) +
				chalk.gray(' skipped as saved filters');
		}
		console.log();
	} catch (err) {
		const msg = axios.isAxiosError(err)
			? ((err.response?.data as { message?: string } | undefined)?.message ??
				err.message)
			: String(err);
		console.log(
			chalk.yellow(
				`  Audience migration failed (${msg}) — flags will use inline targeting conditions`,
			),
		);
		console.log();
	}

	// ── Phase 2: Flag migration ───────────────────────────────────────────────
	let created = 0,
		synced = 0,
		skipped = 0,
		errored = 0;
	let totalEnabled = 0;
	let totalDisabled = 0;
	const failures: Array<{ key: string; error: string }> = [];
	const enableApprovalRequests: Array<{ key: string; env: string }> = [];
	const enableFailures: Array<{ key: string; env: string; error: string }> = [];
	const disableFailures: Array<{ key: string; env: string; error: string }> =
		[];
	const disableApprovalRequests: Array<{ key: string; env: string }> = [];
	const skippedFlags: Array<{ key: string; reason: string }> = [];
	const jsonArrayWrappedKeys: string[] = [];
	const legacyBucketingKeys: string[] = [];
	const restoredKeys: string[] = [];
	const replacedKeys: string[] = [];
	let runner: MigrationRunnerHandle | undefined;

	const environmentMapping: MigrationEnvironmentMapping[] = [];
	for (const [eppoEnvId, ddEnvs] of envMapping) {
		const eppoEnv = flags
			.flatMap((f) => f.environments ?? [])
			.find((e) => e.id === eppoEnvId);
		for (const ddEnv of ddEnvs) {
			environmentMapping.push({
				sourceEnvId: eppoEnvId,
				sourceEnvName: eppoEnv?.name ?? String(eppoEnvId),
				datadogEnvId: ddEnv.id,
				datadogEnvName: ddEnv.name,
				datadogDdEnvNames: ddEnv.queries,
			});
		}
	}

	const sigintHandler = () => {
		if (runner) runner.finalize();
		else process.stderr.write('\n');
		if (
			!dryRun &&
			(created > 0 ||
				synced > 0 ||
				errored > 0 ||
				restoredKeys.length > 0 ||
				replacedKeys.length > 0)
		) {
			console.log(
				chalk.yellow('\n  Migration interrupted — saving partial results…'),
			);
			const timestamp = new Date().toISOString();
			const migrationData: MigrationFile = {
				provider,
				migratedAt: timestamp,
				success: false,
				summary: {
					created,
					synced,
					skipped,
					errored,
					enabled: totalEnabled,
					disabled: totalDisabled,
				},
				failures,
				enableApprovalRequests,
				enableFailures,
				disableFailures,
				disableApprovalRequests,
				skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
				restoredKeys: restoredKeys.length > 0 ? restoredKeys : undefined,
				replacedKeys: replacedKeys.length > 0 ? replacedKeys : undefined,
				flags,
				environmentMapping,
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
		total: flags.length,
		subheader: phase1Subheader,
	});
	// Local non-null alias so downstream code doesn't need `!` on every call.
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
		for (const flag of flags) {
			activeRunner.beginFlag(flag.key);
			try {
				if (flag.type === 'BANDIT') {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — BANDIT type not supported`,
						'BANDIT flags not supported',
					);
					continue;
				}
				if (flag.type === 'LAYER') {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — LAYER type not supported`,
						'LAYER flags not supported',
					);
					continue;
				}
				if ((flag.allocations ?? []).some((a) => a.type === 'SWITCHBACK')) {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — SWITCHBACK targeting not supported`,
						'SWITCHBACK targeting not supported',
					);
					continue;
				}
				const isJsonFlag = flag.variation_type === 'JSON';
				const variants = buildVariants(flag);
				if (variants.length === 0) {
					doSkip(
						flag.key,
						`Skipped ${chalk.cyan(flag.key)} — no variants`,
						'No variants',
					);
					continue;
				}
				if (isJsonFlag && hasJsonArrayVariants(flag)) {
					jsonArrayWrappedKeys.push(flag.key);
				}

				const matchedFlagId = datadogIdForEppoFlag(flag, datadogKeys);
				if (matchedFlagId === undefined) {
					const archivedMatches = archivedEppoMatches(flag, datadogFlags);
					if (archivedMatches.length > 1) {
						doFail(
							flag.key,
							`Flag "${flag.key}": multiple archived Datadog flags match Eppo source ID "${flag.id}" (${archivedMatches.map((match) => match.id).join(', ')}). Restore the intended flag in Datadog and re-run the migration; no replacement was created.`,
						);
						continue;
					}
				}
				const matchedFlag = datadogFlags.find(
					(existing) => existing.id === matchedFlagId,
				);
				// A replaced legacy flag is archived (if active) and keeps no targeting
				// filters; a new EPPO flag is created in its place.
				const replacedFlag =
					replaceLegacyFlags &&
					matchedFlag !== undefined &&
					classifyExistingFlag(matchedFlag) === 'legacy'
						? matchedFlag
						: undefined;
				if (replacedFlag) {
					if (replacedFlag.migration_metadata?.source_id !== String(flag.id)) {
						doFail(
							flag.key,
							`Flag "${flag.key}": Datadog flag "${replacedFlag.key}" (${replacedFlag.id}) does not have the matching Eppo source ID "${flag.id}". It was not replaced.`,
						);
						continue;
					}
					const conflictingFlag = datadogFlags.find(
						(entry) =>
							entry.id !== replacedFlag.id &&
							!entry.archived_at &&
							(entry.key === flag.key ||
								(entry.migration_metadata?.provider === 'eppo' &&
									entry.migration_metadata.source_id === String(flag.id))),
					);
					if (conflictingFlag) {
						doFail(
							flag.key,
							`Flag "${flag.key}": active Datadog flag "${conflictingFlag.key}" (${conflictingFlag.id}) already uses the replacement key or Eppo source ID. No flag was replaced.`,
						);
						continue;
					}
				}
				const existingFlagId = replacedFlag ? undefined : matchedFlagId;
				const existingFlag = replacedFlag ? undefined : matchedFlag;
				const existingKind =
					existingFlag !== undefined
						? classifyExistingFlag(existingFlag)
						: undefined;
				if (existingFlag !== undefined && existingKind === 'native') {
					doFail(
						flag.key,
						`Flag "${flag.key}": a Datadog flag with key "${existingFlag.key}" already exists and was not migrated from Eppo, so it was not overwritten. Rename or delete it in Datadog and re-run the migration.`,
					);
					continue;
				}
				if (existingFlag !== undefined && existingFlag.key !== flag.key) {
					doFail(
						flag.key,
						`Flag "${flag.key}": it is linked to the Datadog flag "${existingFlag.key}", whose key differs. The flag key is part of every Eppo bucketing salt, so the keys must match; the flag was not synced.`,
					);
					continue;
				}
				// Every new flag buckets the Eppo way, whether or not it has splits
				// today: the mode is immutable and the flag can gain splits before
				// cutover. Flags migrated before Eppo bucketing keep Datadog's.
				const bucketingMode: BucketingMode =
					existingKind === 'legacy' ? 'DATADOG' : 'EPPO';

				// Environments without an Eppo default are left out. A new EPPO flag
				// keeps no default there, and an existing flag keeps its Datadog one.
				const defaultVariantKeyPerEnv = buildDefaultVariantKeyPerEnv(
					flag,
					envMapping,
				);
				const allocations = buildAllocations(
					flag,
					envMapping,
					fingerprintLookup,
					savedFilterLookup,
					defaultVariantKeyPerEnv,
					bucketingMode,
				);
				// New flags and re-migrations, legacy ones included, fail on the same
				// conditions.
				const blockers = findEppoMigrationBlockers(
					flag,
					envMapping,
					allocations,
					bucketingMode,
				);
				if (blockers.length > 0) {
					doFail(flag.key, blockers.join(' '));
					continue;
				}
				if (bucketingMode === 'DATADOG') {
					legacyBucketingKeys.push(flag.key);
					activeRunner.printMessage(
						`⚠ ${chalk.cyan(flag.key)} was migrated before Eppo-compatible bucketing — it keeps Datadog bucketing, so subjects in splits and partial rollouts are not assigned as in Eppo. To switch it to Eppo-compatible bucketing, re-migrate it and choose to replace it (--replace-legacy-flags in non-interactive mode)`,
					);
					activeRunner.beginFlag(flag.key);
				}
				const envsToEnable = getEnvsToEnable(flag, envMapping);
				const envsToDisable = getEnvsToDisable(flag, envMapping);
				// Inactive mapped environments get their targeting too, so they bucket
				// like Eppo if they are enabled later.
				const envsToSync = [...envsToEnable, ...envsToDisable];
				const targetName = resolveFlagNameForSync(
					flag.name,
					existingFlag?.name,
				);
				// A renamed source variation keeps its original Datadog key.
				const datadogDefaultVariantKey = (
					envId: string,
					sourceKeyToDatadogKey: ReadonlyMap<string, string>,
				): string | undefined => {
					const sourceKey = defaultVariantKeyPerEnv.get(envId);
					return sourceKey === undefined
						? undefined
						: (sourceKeyToDatadogKey.get(sourceKey) ?? sourceKey);
				};

				// Count targeting rules for reporting (all environments — used for new-flag path)
				const allRuleCount = allocations.reduce(
					(sum, a) => sum + (a.targeting_rules?.length ?? 0),
					0,
				);
				const allFilterLabel = `${allocations.length} targeting filter(s)`;
				const allRuleLabel =
					allRuleCount > 0 ? `, ${allRuleCount} rule(s)` : '';
				// Every branch writes targeting for all mapped environments.
				const rolloutCount = allocations.filter(
					(a) => a.exposure_schedule !== undefined,
				).length;
				const rolloutLabel =
					rolloutCount > 0 ? `, ${rolloutCount} partial rollout(s)` : '';

				const restorationLabel = existingFlag?.archived_at
					? ', 1 flag restoration'
					: '';
				if (existingFlagId) {
					// Flag already exists in Datadog — sync targeting and enable in new environments
					const sourceTags = buildEppoFlagTags(
						flag.tag_names ?? [],
						teamHandlesByFlagId.get(flag.id),
					);
					const syncTags = await resolveMigrationTargetTags(
						tagSyncMode,
						sourceTags,
						existingFlagId,
						ddApiKey,
						ddAppKey,
						site,
					);

					if (existingFlag?.archived_at) {
						if (dryRun) {
							dryRunRequests.push({
								method: 'POST',
								path: `/api/v2/feature-flags/${existingFlagId}/unarchive`,
								body: {},
							});
						} else {
							try {
								await unarchiveFeatureFlag(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									site,
								);
							} catch (err) {
								throw new Error(
									`Failed to restore archived flag "${flag.key}" (${existingFlagId}): ${formatAxiosError(err)}`,
								);
							}
							existingFlag.archived_at = null;
						}
						restoredKeys.push(flag.key);
						activeRunner.printMessage(
							`${dryRun ? '[dry run] Would restore' : 'Restored'} ${chalk.cyan(flag.key)} (${existingFlagId}) — reusing the existing flag for sync`,
						);
						activeRunner.beginFlag(flag.key);
					}

					if (dryRun) {
						dryRunRequests.push({
							method: 'PUT',
							path: `/api/v2/feature-flags/${existingFlagId}`,
							body: {
								data: {
									type: 'feature-flags',
									attributes: { name: targetName },
								},
							},
						});
					}

					// These source APIs expose no flag schema. Full sync removes any
					// Datadog schema before variant writes so source edits can propagate.
					const schemaLabel =
						mapVariationType(flag.variation_type) === 'JSON'
							? ', 1 JSON schema'
							: '';
					if (mapVariationType(flag.variation_type) === 'JSON') {
						if (dryRun) {
							dryRunRequests.push({
								method: 'PUT',
								path: `/api/v2/feature-flags/${existingFlagId}`,
								body: {
									data: {
										type: 'feature-flags',
										attributes: { json_schema: null },
									},
								},
							});
						} else {
							await updateFlagJsonSchema(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								null,
								site,
							);
						}
					}

					if (envsToEnable.length === 0) {
						// Always sync tags. Overwrite mode propagates removals; merge
						// mode preserves tags that exist only in Datadog. Targeting in the
						// inactive mapped environments is synced before they are disabled.
						// Variant deletes are intentionally SKIPPED in this branch: Datadog
						// environments outside the mapping may still reference a variant
						// (allocations reference variants by UUID), and nothing here
						// rewrites them. Creates+updates are safe.
						let variantCounts = { added: 0, updated: 0, deleted: 0 };
						let disabledCount = 0;
						let syncFilterCount = 0;
						if (dryRun) {
							const { variants: existingVariants } = await fetchFlagDetail(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								site,
							);
							const { createUpdateRequests, sourceKeyToDatadogKey } =
								buildVariantSyncDryRunRequests(
									existingFlagId,
									variants,
									existingVariants,
									'eppo',
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
							for (const ddEnv of envsToSync) {
								const syncReqs = toSyncRequests(allocations, ddEnv.id);
								syncFilterCount += syncReqs.length;
								const dvk = datadogDefaultVariantKey(
									ddEnv.id,
									sourceKeyToDatadogKey,
								);
								dryRunRequests.push({
									method: 'PUT',
									path:
										`/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/allocations` +
										(dvk !== undefined ? `?default_variant_key=${dvk}` : ''),
									body: syncReqs,
								});
							}
							for (const ddEnv of envsToDisable) {
								dryRunRequests.push({
									method: 'POST',
									path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/disable`,
									body: {},
								});
							}
						} else {
							await updateFlagName(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								targetName,
								site,
							);
							const result = await syncVariantsCreatesAndUpdates(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								variants,
								'eppo',
								site,
							);
							variantCounts = { ...result.counts, deleted: 0 };
							await updateFlagTags(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								syncTags,
								site,
							);
							for (const ddEnv of envsToSync) {
								const syncReqs = toSyncRequests(allocations, ddEnv.id);
								await syncAllocationsForEnvironment(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									ddEnv.id,
									syncReqs,
									site,
									datadogDefaultVariantKey(
										ddEnv.id,
										result.sourceKeyToDatadogKey,
									),
									result.variantKeyToId,
								);
								syncFilterCount += syncReqs.length;
							}
							for (const ddEnv of envsToDisable) {
								try {
									const outcome =
										await disableFeatureFlagEnvironmentWithOutcome(
											ddApiKey,
											ddAppKey,
											existingFlagId,
											ddEnv.id,
											site,
										);

									if (outcome === 'disabled') {
										disabledCount++;
									} else {
										disableApprovalRequests.push({
											key: flag.key,
											env: ddEnv.name,
										});
									}
								} catch (err) {
									disableFailures.push({
										key: flag.key,
										env: ddEnv.name,
										error: formatAxiosError(err),
									});
								}
							}
							totalDisabled += disabledCount;
						}
						const variantLabel = formatVariantLabel(variantCounts);
						const disableLabel = dryRun
							? envsToDisable.length > 0
								? `, would disable in ${envsToDisable.map((e) => e.name).join(', ')}`
								: ''
							: disabledCount > 0
								? `, disabled in ${disabledCount} env(s)`
								: '';
						const filterLabel = `, ${syncFilterCount} targeting filter(s)`;
						doSync(
							dryRun
								? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (1 name, ${syncTags.length} tag(s)${filterLabel}${rolloutLabel}${variantLabel}${schemaLabel}${restorationLabel}${disableLabel})`
								: `${chalk.green('✓')} Synced ${chalk.cyan(flag.key)} (1 name, ${syncTags.length} tag(s)${filterLabel}${rolloutLabel}${variantLabel}${schemaLabel}${restorationLabel}${disableLabel})`,
						);
						continue;
					}

					activeRunner.printMessage(
						`⚠ ${chalk.cyan(flag.key)} exists in Datadog — targeting filters in ${envsToSync.map((e) => e.name).join(', ')} will be overwritten`,
					);
					activeRunner.beginFlag(flag.key);

					if (dryRun) {
						const { variants: existingVariantsDry } = await fetchFlagDetail(
							ddApiKey,
							ddAppKey,
							existingFlagId,
							site,
						);
						const {
							createUpdateRequests,
							deleteRequests,
							sourceKeyToDatadogKey,
						} = buildVariantSyncDryRunRequests(
							existingFlagId,
							variants,
							existingVariantsDry,
							'eppo',
						);
						// Variant creates+updates must precede allocation PUTs so that
						// new variants exist when allocations reference them.
						for (const r of createUpdateRequests) dryRunRequests.push(r);
						const variantCounts = {
							added: createUpdateRequests.filter((r) => r.method === 'POST')
								.length,
							updated: createUpdateRequests.filter((r) => r.method === 'PUT')
								.length,
							deleted: deleteRequests.length,
						};
						let syncFilterCount = 0;
						let syncRuleCount = 0;
						for (const ddEnv of envsToSync) {
							const syncReqs = toSyncRequests(allocations, ddEnv.id);
							syncFilterCount += syncReqs.length;
							syncRuleCount += syncReqs.reduce(
								(sum, r) => sum + (r.targeting_rules?.length ?? 0),
								0,
							);
							const dvk = datadogDefaultVariantKey(
								ddEnv.id,
								sourceKeyToDatadogKey,
							);
							dryRunRequests.push({
								method: 'PUT',
								path:
									`/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/allocations` +
									(dvk !== undefined ? `?default_variant_key=${dvk}` : ''),
								body: syncReqs,
							});
						}
						for (const ddEnv of envsToEnable) {
							dryRunRequests.push({
								method: 'POST',
								path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/enable`,
								body: {},
							});
						}
						for (const ddEnv of envsToDisable) {
							dryRunRequests.push({
								method: 'POST',
								path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/disable`,
								body: {},
							});
						}
						// Variant deletes go AFTER allocation PUTs — allocations may have
						// been pointing at variants slated for removal until just now.
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
						const syncFilterLabel = `${syncFilterCount} targeting filter(s)`;
						const syncRuleLabel =
							syncRuleCount > 0 ? `, ${syncRuleCount} rule(s)` : '';
						const tagLabel =
							syncTags.length > 0
								? `, ${syncTags.length} tag(s)`
								: ', tags cleared';
						const variantLabel = formatVariantLabel(variantCounts);
						const enableLabel =
							envsToEnable.length > 0
								? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
								: '';
						const disableLabel =
							envsToDisable.length > 0
								? `, would disable in ${envsToDisable.map((e) => e.name).join(', ')}`
								: '';
						doSync(
							`${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} ` +
								`(${syncFilterLabel}${syncRuleLabel}${rolloutLabel}${variantLabel}${tagLabel}, 1 name${schemaLabel}${restorationLabel}${enableLabel}${disableLabel})`,
						);
					} else {
						try {
							await updateFlagName(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								targetName,
								site,
							);
							// Apply variant creates+updates first so allocation
							// variant_id resolution sees new variants. Deletes are
							// deferred until AFTER allocation sync so we never remove
							// a variant while an allocation may still reference it.
							const variantSyncResult = await syncVariantsCreatesAndUpdates(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								variants,
								'eppo',
								site,
							);
							const variantCounts = variantSyncResult.counts;
							// Sync targeting for every mapped environment before any is
							// enabled, so an environment never serves stale defaults.
							let syncedAllocCount = 0;
							let syncedRuleCount = 0;
							for (const ddEnv of envsToSync) {
								const syncReqs = toSyncRequests(allocations, ddEnv.id);
								await syncAllocationsForEnvironment(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									ddEnv.id,
									syncReqs,
									site,
									datadogDefaultVariantKey(
										ddEnv.id,
										variantSyncResult.sourceKeyToDatadogKey,
									),
									variantSyncResult.variantKeyToId,
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
								site,
							);

							// Update tags using the strategy selected for this migration.
							await updateFlagTags(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								syncTags,
								site,
							);

							// Match the source flag state in each mapped environment.
							let enabledCount = 0;
							for (const ddEnv of envsToEnable) {
								try {
									const outcome = await enableFeatureFlagEnvironmentWithOutcome(
										ddApiKey,
										ddAppKey,
										existingFlagId,
										ddEnv.id,
										site,
									);
									if (outcome === 'enabled') enabledCount++;
									else
										enableApprovalRequests.push({
											key: flag.key,
											env: ddEnv.name,
										});
								} catch (err) {
									enableFailures.push({
										key: flag.key,
										env: ddEnv.name,
										error: formatAxiosError(err),
									});
								}
							}

							let disabledCount = 0;
							for (const ddEnv of envsToDisable) {
								try {
									const outcome =
										await disableFeatureFlagEnvironmentWithOutcome(
											ddApiKey,
											ddAppKey,
											existingFlagId,
											ddEnv.id,
											site,
										);

									if (outcome === 'disabled') {
										disabledCount++;
									} else {
										disableApprovalRequests.push({
											key: flag.key,
											env: ddEnv.name,
										});
									}
								} catch (err) {
									disableFailures.push({
										key: flag.key,
										env: ddEnv.name,
										error: formatAxiosError(err),
									});
								}
							}

							totalEnabled += enabledCount;
							totalDisabled += disabledCount;
							const syncedRuleLabel =
								syncedRuleCount > 0 ? `, ${syncedRuleCount} rule(s)` : '';
							const tagLabel =
								syncTags.length > 0
									? `, ${syncTags.length} tag(s)`
									: ', tags cleared';
							const variantLabel = formatVariantLabel(variantCounts);
							const enableLabel =
								enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
							const disableLabel =
								disabledCount > 0
									? `, disabled in ${disabledCount} env(s)`
									: '';
							doSync(
								`${chalk.green('✓')} Synced ${chalk.cyan(flag.key)} (${syncedAllocCount} targeting filter(s)${syncedRuleLabel}${rolloutLabel}${variantLabel}${tagLabel}, 1 name${schemaLabel}${restorationLabel}${enableLabel}${disableLabel})`,
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
					// Flag does not exist — create it with targeting rules and Eppo
					// bucketing, without a flag-level default: environments without an
					// Eppo default keep none, so unmatched subjects get the SDK fallback.
					const sourceTags = buildEppoFlagTags(
						flag.tag_names ?? [],
						teamHandlesByFlagId.get(flag.id),
					);
					// Allocations are already embedded in the create request, so an
					// environment is synced again only to set its Eppo default. This
					// happens before any environment is enabled, so no environment
					// serves without its default.
					const envDefaultsToSet = envsToSync.flatMap((ddEnv) => {
						const dvk = defaultVariantKeyPerEnv.get(ddEnv.id);
						return dvk !== undefined ? [{ ddEnv, dvk }] : [];
					});

					// The flag being replaced must be archived, so the new flag can take
					// its key. Targeting filter keys are unique per org, including on
					// archived flags, and the new flag reuses the Eppo allocation keys,
					// so the old flag's targeting filters are cleared first.
					let archivedByRun = false;
					let clearedEnvCount = 0;
					let replacementId: string | undefined;
					let replacementDetails:
						| Awaited<ReturnType<typeof fetchFlagReplacementDetails>>
						| undefined;
					const replacementState = (): string => {
						if (!replacedFlag) return '';
						const notes: string[] = [];
						if (archivedByRun) {
							notes.push(
								`This migration archived flag "${replacedFlag.key}" (${replacedFlag.id})${replacementId ? '.' : ', so it serves no value until it is replaced.'}`,
							);
						}
						if (clearedEnvCount > 0) {
							notes.push(
								`The targeting filters of flag "${replacedFlag.key}" (${replacedFlag.id}) were cleared in ${clearedEnvCount} env(s).`,
							);
						}
						if (replacementId) {
							notes.push(
								`The replacement (${replacementId}) was created. Re-run the migration to finish syncing it.`,
							);
						} else if (notes.length > 0) {
							notes.push(
								'Re-run the migration with replacement enabled to create its replacement.',
							);
						}
						return notes.length > 0 ? ` ${notes.join(' ')}` : '';
					};
					if (replacedFlag) {
						// Look up the current state before archiving, which disables every
						// environment and cannot be undone by a later read failure.
						const details = await fetchFlagReplacementDetails(
							ddApiKey,
							ddAppKey,
							replacedFlag.id,
							site,
						);
						replacementDetails = details;
						if (
							details.key !== replacedFlag.key ||
							details.eppoSourceId !== String(flag.id)
						) {
							throw new Error(
								`Datadog flag "${replacedFlag.key}" (${replacedFlag.id}) no longer matches the expected key and Eppo source ID "${flag.id}". Re-run the migration to refresh the flag list. No replacement was attempted.`,
							);
						}
						const replacementEnabledEnvs = new Set(
							envsToEnable.map((env) => env.id),
						);
						const missingEnvs = details.enabledEnvironmentIds.filter(
							(envId) => !replacementEnabledEnvs.has(envId),
						);
						if (missingEnvs.length > 0) {
							throw new Error(
								`Datadog flag "${replacedFlag.key}" (${replacedFlag.id}) is enabled in environments the replacement would not enable (${missingEnvs.join(', ')}). Map each to an active Eppo environment before replacing the flag.`,
							);
						}
						if (details.requiresApproval) {
							throw new Error(
								`Datadog flag "${replacedFlag.key}" (${replacedFlag.id}) requires approval for changes. Automatic replacement cannot preserve that protection; keep Datadog bucketing for this flag.`,
							);
						}
						const bindings = await fetchRestrictionPolicy(
							ddApiKey,
							ddAppKey,
							replacedFlag.id,
							site,
						);
						if (bindings.length > 0) {
							throw new Error(
								`Datadog flag "${replacedFlag.key}" (${replacedFlag.id}) has a restriction policy. Automatic replacement cannot preserve that policy; keep Datadog bucketing for this flag.`,
							);
						}
						const wasActive = !details.archived;
						if (wasActive) {
							if (dryRun) {
								dryRunRequests.push({
									method: 'POST',
									path: `/api/v2/feature-flags/${replacedFlag.id}/archive`,
									body: {},
								});
							} else {
								try {
									await archiveFeatureFlag(
										ddApiKey,
										ddAppKey,
										replacedFlag.id,
										site,
									);
								} catch (err) {
									throw new Error(
										`Failed to confirm the archive of flag "${replacedFlag.key}" (${replacedFlag.id}): ${formatAxiosError(err)} No replacement was created. Verify the old flag's archive status in Datadog before retrying.`,
									);
								}
								archivedByRun = true;
								replacedFlag.archived_at = new Date().toISOString();
							}
						}
						const envIdsToClear = details.environmentIdsWithTargeting;
						for (const envId of envIdsToClear) {
							if (dryRun) {
								dryRunRequests.push({
									method: 'PUT',
									path: `/api/v2/feature-flags/${replacedFlag.id}/environments/${envId}/allocations`,
									body: [],
								});
							} else {
								try {
									await clearAllocationsForEnvironment(
										ddApiKey,
										ddAppKey,
										replacedFlag.id,
										envId,
										site,
									);
								} catch (err) {
									throw new Error(
										`Failed to clear the targeting filters of flag "${replacedFlag.key}" (${replacedFlag.id}): ${formatAxiosError(err)} No replacement was created.${replacementState()}`,
									);
								}
								clearedEnvCount++;
							}
						}
						const archiveLabel = wasActive
							? `${dryRun ? 'would archive it and clear' : 'archived it and cleared'}`
							: `${dryRun ? 'would clear' : 'cleared'}`;
						activeRunner.printMessage(
							`${dryRun ? '[dry run] Would replace' : 'Replacing'} ${wasActive ? '' : 'archived '}flag ${chalk.cyan(replacedFlag.key)} (${replacedFlag.id}) with an Eppo-bucketed flag — ${archiveLabel} its targeting filters in ${envIdsToClear.length} env(s)`,
						);
						activeRunner.beginFlag(flag.key);
					}
					const replacementLabel = replacedFlag
						? `, replaces flag ${replacedFlag.id}`
						: '';
					// A replacement keeps the predecessor's Datadog-side settings: its
					// distribution channel, and its tags under the selected tag mode.
					const tags = replacementDetails
						? computeTargetTags(
								tagSyncMode,
								sourceTags,
								replacementDetails.tags,
							).target
						: sourceTags;
					const distributionChannel = replacementDetails?.distributionChannel;
					const request: DatadogCreateFlagRequest = {
						key: flag.key,
						name: flag.name,
						value_type: mapVariationType(flag.variation_type),
						variants: toCreateFlagVariants(variants),
						allocations: allocations.length > 0 ? allocations : undefined,
						migration_metadata: {
							provider: 'eppo',
							source_id: String(flag.id),
							source_key: flag.key,
						},
						bucketing_mode: 'EPPO',
						...(tags.length > 0 ? { tags } : {}),
						...(distributionChannel
							? { distribution_channel: distributionChannel }
							: {}),
					};

					if (dryRun) {
						dryRunRequests.push({
							method: 'POST',
							path: '/api/v2/feature-flags',
							body: { data: { type: 'feature-flags', attributes: request } },
						});
						for (const { ddEnv, dvk } of envDefaultsToSet) {
							// flag.key used as placeholder — real ID assigned on creation
							dryRunRequests.push({
								method: 'PUT',
								path: `/api/v2/feature-flags/${flag.key}/environments/${ddEnv.id}/allocations?default_variant_key=${dvk}`,
								body: toSyncRequests(allocations, ddEnv.id),
							});
						}
						for (const ddEnv of envsToEnable) {
							dryRunRequests.push({
								method: 'POST',
								path: `/api/v2/feature-flags/${flag.key}/environments/${ddEnv.id}/enable`,
								body: {},
							});
						}

						const enableLabel =
							envsToEnable.length > 0
								? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
								: '';
						if (replacedFlag) replacedKeys.push(flag.key);
						doCreate(
							`${chalk.dim('[dry run]')} Would create ${chalk.cyan(flag.key)} ` +
								`(${allFilterLabel}${allRuleLabel}${rolloutLabel}${enableLabel}${replacementLabel})`,
						);
					} else {
						try {
							const createdFlag = await createFeatureFlag(
								ddApiKey,
								ddAppKey,
								request,
								site,
							);

							if (replacedFlag) {
								replacementId = createdFlag.id;
								replacedKeys.push(flag.key);
							}

							// Set every per-environment default before enabling any
							// environment; a failure here leaves the flag disabled.
							for (const { ddEnv, dvk } of envDefaultsToSet) {
								await syncAllocationsForEnvironment(
									ddApiKey,
									ddAppKey,
									createdFlag.id,
									ddEnv.id,
									toSyncRequests(allocations, ddEnv.id),
									site,
									dvk,
								);
							}
							let enabledCount = 0;
							for (const ddEnv of envsToEnable) {
								try {
									const outcome = await enableFeatureFlagEnvironmentWithOutcome(
										ddApiKey,
										ddAppKey,
										createdFlag.id,
										ddEnv.id,
										site,
									);
									if (outcome === 'enabled') enabledCount++;
									else
										enableApprovalRequests.push({
											key: flag.key,
											env: ddEnv.name,
										});
								} catch (err) {
									enableFailures.push({
										key: flag.key,
										env: ddEnv.name,
										error: `${formatAxiosError(err)}${replacementState()}`,
									});
								}
							}

							totalEnabled += enabledCount;
							const enableLabel =
								enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
							doCreate(
								`${chalk.green('✓')} Created ${chalk.cyan(flag.key)} (${allFilterLabel}${allRuleLabel}${rolloutLabel}${enableLabel}${replacementLabel})`,
							);
						} catch (err) {
							const error = formatAxiosError(err);
							doFail(flag.key, `${error}${replacementState()}`);
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

	await renderStatic(
		<EppoMigrationSummary
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
			enableApprovalRequests={enableApprovalRequests}
			enableFailures={enableFailures}
			disableFailures={disableFailures}
			disableApprovalRequests={disableApprovalRequests}
		/>,
	);

	const timestamp = new Date().toISOString();
	let outputData: DryRunFile | MigrationFile | undefined;

	if (dryRun) {
		const dryRunData: DryRunFile = {
			provider,
			migratedAt: timestamp,
			success: errored === 0,
			summary: { created, synced, skipped, errored, enabled: 0, disabled: 0 },
			failures,
			enableApprovalRequests: [],
			enableFailures: [],
			disableFailures: [],
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			legacyBucketingKeys:
				legacyBucketingKeys.length > 0 ? legacyBucketingKeys : undefined,
			restoredKeys: restoredKeys.length > 0 ? restoredKeys : undefined,
			replacedKeys: replacedKeys.length > 0 ? replacedKeys : undefined,
			flags,
			environmentMapping,
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
		const migrationData: MigrationFile = {
			provider,
			migratedAt: timestamp,
			success: errored === 0,
			summary: {
				created,
				synced,
				skipped,
				errored,
				enabled: totalEnabled,
				disabled: totalDisabled,
			},
			failures,
			enableApprovalRequests,
			enableFailures,
			disableFailures,
			disableApprovalRequests,
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			jsonArrayWrappedKeys:
				jsonArrayWrappedKeys.length > 0 ? jsonArrayWrappedKeys : undefined,
			legacyBucketingKeys:
				legacyBucketingKeys.length > 0 ? legacyBucketingKeys : undefined,
			restoredKeys: restoredKeys.length > 0 ? restoredKeys : undefined,
			replacedKeys: replacedKeys.length > 0 ? replacedKeys : undefined,
			flags,
			environmentMapping,
		};
		outputData = migrationData;
		if (created > 0 || synced > 0 || errored > 0) {
			const filename = `migration-${timestamp}.json`;
			if (!fs.existsSync(CONFIG_DIR))
				fs.mkdirSync(CONFIG_DIR, { recursive: true });
			const filepath = path.join(CONFIG_DIR, filename);
			fs.writeFileSync(filepath, JSON.stringify(migrationData, null, 2));
			console.log(chalk.gray(`  Migration saved to ${filepath}`));

			const exportToSheets = await shouldExportResults(
				doExport,
				!nonInteractive,
				() =>
					confirm({
						message:
							'Would you like to export migration results to an .xlsx file?',
						default: true,
					}),
			);
			if (exportToSheets) {
				const { exportMigrationToXlsx } = await import('./helpers/xlsx.js');
				await exportMigrationToXlsx(migrationData);
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

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export interface EppoNonInteractiveOptions {
	envMap: Array<[string, string]>;
	flagKeys: string[];
}

export interface RunEppoMigrationOptions {
	tagMode?: TagSyncMode;
	/** See MigrateArgs.replaceLegacyFlags. */
	replaceLegacyFlags?: boolean;
	nonInteractive?: EppoNonInteractiveOptions;
	doExport?: boolean;
}

export async function runEppoMigration(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	options?: RunEppoMigrationOptions,
): Promise<void> {
	// EPPO_API_KEY presence was validated in src/index.ts before this runs.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const apiKey = process.env.EPPO_API_KEY!.trim();

	if (options?.nonInteractive) {
		await runEppoMigrationNonInteractive(
			apiKey,
			ddApiKey,
			ddAppKey,
			ddSite,
			dryRun,
			options.nonInteractive,
			options.doExport ?? false,
			options.tagMode,
			options.replaceLegacyFlags,
		);
		return;
	}

	console.log();

	const spinner = createSpinner('Loading data…').start();
	let flags: EppoFlag[] = [];
	let datadogKeys: Map<string, string> = new Map();
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];

	try {
		[flags, datadogFlags, datadogEnvs] = await Promise.all([
			fetchEppoFlags(apiKey, {
				onProgress: (fetched) => {
					spinner.text = `Loading data… (${fetched} Eppo flag${fetched === 1 ? '' : 's'} fetched)`;
				},
			}),
			fetchDatadogFlags(ddApiKey, ddAppKey, ddSite, { includeArchived: true }),
			fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
		]);
		datadogKeys = indexEppoMigrationFlagKeys(flags, datadogFlags);
		spinner.succeed(
			`Loaded ${flags.length} Eppo flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		spinner.fail('Failed to load data');
		if (axios.isAxiosError(err)) {
			const msg =
				(err.response?.data as { message?: string } | undefined)?.message ??
				err.message;
			console.error(chalk.red(`  ${msg}`));
		}
		process.exit(1);
	}

	const eppoEnvironments = extractEnvironments(flags);

	let prevSelectedEnvs: EppoFlagEnvironment[] = [];
	let prevEnvMapping: EnvironmentMapping<number> = new Map();
	let prevSelectedFlags: EppoFlag[] = [];

	// eslint-disable-next-line no-constant-condition
	outer: while (true) {
		let selectedEnvs: EppoFlagEnvironment[];

		if (eppoEnvironments.length > 0) {
			clearScreen();
			await printHeader();
			const envResult = await selectEnvironments(
				flags,
				eppoEnvironments,
				prevSelectedEnvs,
			);
			if (envResult === null) break; // escaped → exit
			if (envResult.length === 0) {
				console.log(
					chalk.yellow(
						'\n  Please select at least one environment to migrate from.\n',
					),
				);
				continue;
			}
			prevSelectedEnvs = envResult;
			selectedEnvs = envResult;
			// Reset flag selections if the environment selection changed
			const envIds = new Set(envResult.map((e) => e.id));
			const prevEnvIds = new Set(
				prevSelectedFlags.flatMap(
					(f) => f.environments?.map((e) => e.id) ?? [],
				),
			);
			if ([...envIds].some((id) => !prevEnvIds.has(id))) prevSelectedFlags = [];
		} else {
			selectedEnvs = [];
		}

		// Link each selected Eppo environment to a Datadog environment
		while (true) {
			const mapping = await linkEnvironments(
				selectedEnvs,
				datadogEnvs,
				prevEnvMapping,
			);
			if (mapping === null) break; // escaped → back to Eppo env selection

			prevEnvMapping = mapping;

			while (true) {
				clearScreen();
				await printHeader();
				const flagResult = await selectFlags(
					flags,
					datadogKeys,
					selectedEnvs,
					prevSelectedFlags,
					datadogFlags,
					undefined,
					options?.replaceLegacyFlags,
				);
				if (flagResult === null) break; // escaped → back to linking

				prevSelectedFlags = flagResult;
				clearScreen();
				await printHeader();
				const action = await confirmMigration(
					prevSelectedFlags,
					apiKey,
					ddApiKey,
					ddAppKey,
					prevEnvMapping,
					datadogKeys,
					'eppo',
					ddSite,
					dryRun,
					datadogFlags,
					false,
					options?.doExport,
					options?.tagMode,
					options?.replaceLegacyFlags,
				);
				if (action === 'cancel') break outer;
				if (action === 'migrate') break outer;
				// action === 'select-more': loop back to selectFlags
			}
		}

		if (eppoEnvironments.length === 0) break; // nothing to go back to
	}
}

// ─── Non-Interactive Entry Point ─────────────────────────────────────────────

export function resolveEppoEnvMap(
	pairs: Array<[string, string]>,
	eppoEnvs: EppoFlagEnvironment[],
	datadogEnvs: DatadogEnvironment[],
): {
	envMapping: EnvironmentMapping<number>;
	selectedEnvs: EppoFlagEnvironment[];
} {
	const envMapping: EnvironmentMapping<number> = new Map();
	const selectedEnvs: EppoFlagEnvironment[] = [];
	const ddByName = new Map(datadogEnvs.map((e) => [e.name, e]));
	const sourceByDatadogEnvironment = new Map<string, number>();
	for (const [src, dst] of pairs) {
		const eppoEnv = eppoEnvs.find((e) => e.name === src);
		if (!eppoEnv) {
			const available = eppoEnvs.map((e) => e.name).join(', ');
			throw new Error(
				`Eppo environment not found: "${src}". Available: ${available}`,
			);
		}
		const ddEnv = ddByName.get(dst);
		if (!ddEnv) {
			const available = datadogEnvs.map((e) => e.name).join(', ');
			throw new Error(
				`Datadog environment not found: "${dst}". Available: ${available}`,
			);
		}
		const existingSource = sourceByDatadogEnvironment.get(ddEnv.id);
		if (existingSource !== undefined && existingSource !== eppoEnv.id) {
			const existingEnvironment = eppoEnvs.find(
				(env) => env.id === existingSource,
			);
			throw new Error(
				`Datadog environment "${ddEnv.name}" cannot be mapped from both Eppo environments "${existingEnvironment?.name ?? existingSource}" and "${eppoEnv.name}"`,
			);
		}
		sourceByDatadogEnvironment.set(ddEnv.id, eppoEnv.id);
		const mappedEnvironments = envMapping.get(eppoEnv.id) ?? [];
		if (!mappedEnvironments.some((env) => env.id === ddEnv.id)) {
			mappedEnvironments.push(ddEnv);
		}
		envMapping.set(eppoEnv.id, mappedEnvironments);
		if (!selectedEnvs.some((env) => env.id === eppoEnv.id)) {
			selectedEnvs.push(eppoEnv);
		}
	}
	return { envMapping, selectedEnvs };
}

export function resolveEppoFlags(
	keys: string[],
	allFlags: EppoFlag[],
	selectedEnvIds?: Set<number>,
): EppoFlag[] {
	const byKey = new Map(allFlags.map((f) => [f.key, f]));
	const selected: EppoFlag[] = [];
	const missing: string[] = [];
	for (const key of keys) {
		const f = byKey.get(key);
		if (f) selected.push(f);
		else missing.push(key);
	}
	if (missing.length > 0) {
		throw new Error(`Flag(s) not found in Eppo: ${missing.join(', ')}`);
	}
	if (selectedEnvIds && selectedEnvIds.size > 0) {
		const noEnv = selected.filter(
			(f) => !f.environments?.some((e) => selectedEnvIds.has(e.id)),
		);
		if (noEnv.length > 0) {
			throw new Error(
				`Flag(s) not present in any mapped Eppo environment: ${noEnv.map((f) => f.key).join(', ')}`,
			);
		}
	}
	return selected;
}

async function runEppoMigrationNonInteractive(
	apiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	ni: EppoNonInteractiveOptions,
	doExport: boolean,
	tagMode?: TagSyncMode,
	replaceLegacyFlags?: boolean,
): Promise<void> {
	console.log();
	console.log(chalk.gray('  Running in non-interactive mode'));
	if (dryRun) {
		console.log(chalk.bold.yellow('  Dry run mode — no flags will be created'));
	}
	console.log();

	const spinner = createSpinner('Loading data…').start();
	let flags: EppoFlag[] = [];
	let datadogKeys: Map<string, string> = new Map();
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];

	try {
		[flags, datadogFlags, datadogEnvs] = await Promise.all([
			fetchEppoFlags(apiKey, {
				onProgress: (fetched) => {
					spinner.text = `Loading data… (${fetched} Eppo flag${fetched === 1 ? '' : 's'} fetched)`;
				},
			}),
			fetchDatadogFlags(ddApiKey, ddAppKey, ddSite, { includeArchived: true }),
			fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
		]);
		datadogKeys = indexEppoMigrationFlagKeys(flags, datadogFlags);
		spinner.succeed(
			`Loaded ${flags.length} Eppo flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		spinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		process.exit(1);
	}

	const eppoEnvironments = extractEnvironments(flags);

	let envMapping: EnvironmentMapping<number>;
	let selectedFlags: EppoFlag[];
	try {
		({ envMapping } = resolveEppoEnvMap(
			ni.envMap,
			eppoEnvironments,
			datadogEnvs,
		));
		selectedFlags = resolveEppoFlags(
			ni.flagKeys,
			flags,
			new Set(envMapping.keys()),
		);
	} catch (err) {
		console.error(
			chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`),
		);
		process.exit(1);
	}

	await confirmMigration(
		selectedFlags,
		apiKey,
		ddApiKey,
		ddAppKey,
		envMapping,
		datadogKeys,
		'eppo',
		ddSite,
		dryRun,
		datadogFlags,
		true,
		doExport,
		tagMode,
		replaceLegacyFlags,
	);
}
