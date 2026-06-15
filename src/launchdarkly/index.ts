import fs from 'node:fs';
import path from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { CONFIG_DIR } from '../config.js';
import {
	applyRestrictionPolicy,
	createFeatureFlag,
	type DatadogTeam,
	type DDRestrictionBinding,
	enableFeatureFlagEnvironment,
	fetchDatadogEnvironments,
	fetchDatadogFlags,
	fetchDatadogTeams,
	fetchRestrictionPolicy,
	syncAllocationsForEnvironment,
	updateFlagTags,
} from '../datadog.js';
import {
	filterableCheckbox,
	filterableSelect,
} from '../filterable-checkbox.js';
import { toSyncRequests } from '../migration.js';
import { MigrationProgressBar } from '../progress-bar.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogFlagEntry,
} from '../types.js';
import {
	fetchCustomRoles,
	fetchFlag,
	fetchFlagRelease,
	fetchFlags,
	fetchFlagsByKey,
	fetchProjectEnvironments,
	fetchProjects,
	fetchTeamsWithRoles,
	isReleaseInProgress,
	type LDProject,
} from './api.js';
import {
	buildAllocations,
	buildVariants,
	findProjectEditorRoleKeys,
	findTeamsWithEditAccess,
	getEnvsToEnable,
	hasSemverConditions,
	mapFlagType,
	shouldSkipFlag,
} from './migration.js';
import { discoverSegmentRefs, migrateSegments } from './segments.js';
import type { LDEnvironment, LDFlag, LDMigrationFile } from './types.js';

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

function printHeader(): void {
	const purple = chalk.bold.hex('#632CA6');
	console.log();
	console.log(purple('╔══════════════════════════════════════════╗'));
	console.log(
		purple('║') +
			chalk.bold.white('   🚩  Feature Flag Migration Tool  🚩    ') +
			purple('║'),
	);
	console.log(
		purple('║') +
			chalk.hex('#632CA6')('          LaunchDarkly → Datadog          ') +
			purple('║'),
	);
	console.log(purple('╚══════════════════════════════════════════╝'));
	console.log();
}

function ddEnvLabel(env: DatadogEnvironment): string {
	const prodBadge = env.is_production
		? `  ${chalk.bgHex('#632CA6').white(' Prod ')}`
		: '';
	return `${env.name}${prodBadge}`;
}

function formatAxiosError(err: unknown): string {
	if (!axios.isAxiosError(err)) return String(err);
	const status = err.response?.status;
	const data = err.response?.data;
	const detail = (data as { errors?: Array<{ detail?: string }> })?.errors?.[0]
		?.detail;
	if (detail) return detail;
	const method = err.config?.method?.toUpperCase() ?? '?';
	const url = err.config?.url ?? '';
	const bodyPreview = data ? JSON.stringify(data).slice(0, 300) : 'no body';
	return `${method} ${url} — ${status ?? 'no status'}: ${bodyPreview}`;
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

export type ConflictResolution =
	| { action: 'skip' }
	| { action: 'prefix'; prefix: string };

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
				badge = `  ${chalk.bgHex('#632CA6').white(` Will prefix with ${conflictResolution.prefix}- `)}`;
			} else {
				indicator = chalk.red('✗');
				badge = `  ${chalk.bgRed.white(' Key conflict — will skip ')}`;
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
		printHeader();
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

async function selectFlags(
	flags: LDFlag[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	previouslySelected: LDFlag[] = [],
	conflictResolution?: ConflictResolution,
): Promise<LDFlag[] | null> {
	let inDatadogCount = 0;
	let prefixedCount = 0;
	let skipCount = 0;
	for (const f of flags) {
		const c = classifyConflict(datadogFlags, projectKey, f.key);
		if (c.type === 'same_project' || c.type === 'manual') inDatadogCount++;
		if (c.type === 'cross_project') {
			if (conflictResolution?.action === 'prefix') prefixedCount++;
			else skipCount++;
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
				`  ${prefixedCount} flag(s) will be prefixed with ${(conflictResolution as { action: 'prefix'; prefix: string }).prefix}-`,
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
			};
		}),
		pageSize,
	});
}

// ─── Flag Detail Loading ─────────────────────────────────────────────────────

/** Fetch full flag details (with environment configs) for selected flags. */
async function loadFlagDetails(
	ldApiKey: string,
	projectKey: string,
	flags: LDFlag[],
): Promise<LDFlag[]> {
	const detailed: LDFlag[] = [];
	for (const flag of flags) {
		if (flag.environments) {
			detailed.push(flag);
		} else {
			const full = await fetchFlag(ldApiKey, projectKey, flag.key);
			detailed.push(full);
		}
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
	const detailSpinner = ora(
		`Fetching details for ${flags.length} flag(s)…`,
	).start();
	let detailedFlags: LDFlag[];
	try {
		detailedFlags = await loadFlagDetails(ldApiKey, projectKey, flags);
		detailSpinner.succeed(`Loaded details for ${detailedFlags.length} flag(s)`);
	} catch (err) {
		detailSpinner.fail('Failed to fetch flag details');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		return 'cancel';
	}

	// Discover teams with edit access via RBAC (project-level)
	let projectEditorTeamKeys = new Set<string>();
	const roleSpinner = ora('Fetching custom roles and teams…').start();
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
		const teamSpinner = ora('Fetching Datadog teams…').start();
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
	const unresolvedEditorTeams: string[] = [];
	if (!ddTeamsFetchFailed) {
		for (const ldKey of projectEditorTeamKeys) {
			const ddHandle = teamKeyMapping?.get(ldKey) ?? ldKey;
			const ddId = ddHandleToId.get(ddHandle);
			if (ddId) {
				editorTeamIds.push(ddId);
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
	let phase1Subheader: string | undefined;
	if (dryRun) {
		// Populate the lookup with placeholder IDs so buildAllocations can
		// accurately simulate the migration for segment-backed flags.
		const refs = discoverSegmentRefs(detailedFlags, [...envMapping.keys()]);
		for (let i = 0; i < refs.length; i++) {
			const { segmentKey, envKey, negated } = refs[i];
			savedFilterLookup.set(
				`${segmentKey}:${envKey}:${negated}`,
				`dry-run-placeholder-${i}`,
			);
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
			if (segmentResult.stats.discovered > 0) {
				const { created: sc, reused: sr, skipped: ss } = segmentResult.stats;
				phase1Subheader =
					chalk.gray('Phase 1 — Segments: ') +
					chalk.green(String(sc)) +
					chalk.gray(' created · ') +
					chalk.white(String(sr)) +
					chalk.gray(' reused · ') +
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
	const dryRunRequests: Array<{ method: string; path: string; body: unknown }> =
		[];
	const progressBar = new MigrationProgressBar(
		detailedFlags.length,
		phase1Subheader,
	);

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
		progressBar ? progressBar.finalize() : process.stderr.write('\n');
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
	if (progressBar) clearScreen();
	progressBar?.start();
	try {
		for (const flag of detailedFlags) {
			let spinner = ora(`Migrating ${chalk.cyan(flag.key)}…`).start();

			// Check skip conditions
			const skipResult = shouldSkipFlag(flag, selectedEnvs);
			if (skipResult.skip) {
				spinner.warn(`Skipped ${chalk.cyan(flag.key)} — ${skipResult.reason}`);
				skippedFlags.push({
					key: flag.key,
					reason: skipResult.reason ?? 'Unknown',
				});
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
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
						spinner.warn(
							`Skipped ${chalk.cyan(flag.key)} — progressive rollout is in progress`,
						);
						skippedFlags.push({
							key: flag.key,
							reason: 'Progressive rollout is in progress',
						});
						skipped++;
						progressBar?.update(flag.key, {
							created,
							skipped,
							failed: errored,
						});
						continue;
					}
					// Release is complete or not found — safe to migrate
				} catch (_err) {
					spinner.warn(
						`Skipped ${chalk.cyan(flag.key)} — failed to check progressive rollout status`,
					);
					skippedFlags.push({
						key: flag.key,
						reason: 'Failed to check progressive rollout status',
					});
					skipped++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
					continue;
				}
			}

			if (skipResult.warn) {
				console.log(chalk.yellow(`  ⚠ ${flag.key}: ${skipResult.warn}`));
			}

			if (flag.archived) {
				spinner.warn(`Skipped ${chalk.cyan(flag.key)} — flag is archived`);
				skippedFlags.push({ key: flag.key, reason: 'Flag is archived' });
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}

			const variants = buildVariants(flag);
			if (variants.length === 0) {
				spinner.warn(`Skipped ${chalk.cyan(flag.key)} — no variants`);
				skippedFlags.push({ key: flag.key, reason: 'No variants' });
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}

			const allocationsResult = buildAllocations(
				flag,
				envMapping,
				savedFilterLookup,
			);
			if (!Array.isArray(allocationsResult)) {
				spinner.warn(
					`Skipped ${chalk.cyan(flag.key)} — ${allocationsResult.flagSkip}`,
				);
				skippedFlags.push({
					key: flag.key,
					reason: allocationsResult.flagSkip,
				});
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}
			const allocations = allocationsResult;
			const envsToEnable = getEnvsToEnable(flag, envMapping);
			const conflict = classifyConflict(datadogFlags, projectKey, flag.key);

			// Cross-project conflict: skip or prefix
			if (conflict.type === 'cross_project') {
				if (!conflictResolution || conflictResolution.action === 'skip') {
					spinner.warn(
						`Skipped ${chalk.cyan(flag.key)} — key already used by a flag from a different LaunchDarkly project`,
					);
					skippedFlags.push({
						key: flag.key,
						reason:
							'Key conflict: flag key already exists in Datadog from a different LaunchDarkly project',
					});
					skipped++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
					continue;
				}
				// prefix case: fall through to creation below
			}

			// For same_project and manual conflicts, sync onto the existing flag
			const existingFlagId =
				conflict.type === 'same_project' || conflict.type === 'manual'
					? conflict.existingFlag?.id
					: undefined;

			const allRuleCount = allocations.reduce(
				(sum, a) => sum + (a.targeting_rules?.length ?? 0),
				0,
			);
			const allFilterLabel = `${allocations.length} targeting filter(s)`;
			const allRuleLabel = allRuleCount > 0 ? `, ${allRuleCount} rule(s)` : '';

			if (existingFlagId) {
				const syncTags = flag.tags;

				if (envsToEnable.length === 0) {
					// Always sync tags and restriction policy even when no new environments need enabling.
					if (dryRun) {
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
					} else {
						await updateFlagTags(
							ddApiKey,
							ddAppKey,
							existingFlagId,
							syncTags,
							ddSite,
						);
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
					spinner.succeed(
						dryRun
							? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (${tagLabel}${policyLabel})`
							: `Synced ${chalk.cyan(flag.key)} (${tagLabel}${policyLabel})`,
					);
					syncedFlagKeys.push(flag.key);
					synced++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
					continue;
				}

				spinner.warn(
					`${chalk.cyan(flag.key)} exists in Datadog — targeting filters in ${envsToEnable.map((e) => e.name).join(', ')} will be overwritten`,
				);
				spinner = ora(`Migrating ${chalk.cyan(flag.key)}…`).start();

				if (dryRun) {
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
					const enableLabel =
						envsToEnable.length > 0
							? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
							: '';
					spinner.succeed(
						`${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} ` +
							`(${syncFilterLabel}${syncRuleLabel}${tagLabel}${enableLabel})`,
					);
					syncedFlagKeys.push(flag.key);
					synced++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
				} else {
					try {
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
						const enableLabel =
							enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
						spinner.succeed(
							`Synced ${chalk.cyan(flag.key)} (${syncedAllocCount} targeting filter(s)${syncedRuleLabel}${tagLabel}${enableLabel})`,
						);
						syncedFlagKeys.push(flag.key);
						synced++;
						progressBar?.update(flag.key, {
							created,
							skipped,
							failed: errored,
						});
					} catch (err) {
						spinner.fail(
							`Failed to sync ${chalk.cyan(flag.key)}: ${chalk.red(formatAxiosError(err))}`,
						);
						failures.push({ key: flag.key, error: formatAxiosError(err) });
						errored++;
						progressBar?.update(flag.key, {
							created,
							skipped,
							failed: errored,
						});
					}
				}
			} else {
				const usePrefix =
					conflict.type === 'cross_project' &&
					conflictResolution?.action === 'prefix';
				const ddKey = usePrefix
					? `${conflictResolution.prefix}-${flag.key}`
					: flag.key;

				const tags = flag.tags;

				const request: DatadogCreateFlagRequest = {
					key: ddKey,
					name: flag.name,
					value_type: mapFlagType(flag),
					variants,
					allocations: allocations.length > 0 ? allocations : undefined,
					migration_metadata: {
						project_key: projectKey,
						flag_key: flag.key,
						...(usePrefix ? { key_prefix: conflictResolution.prefix } : {}),
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
					spinner.succeed(
						`${chalk.dim('[dry run]')} Would create ${chalk.cyan(ddKey)} ` +
							`(${allFilterLabel}${allRuleLabel}${enableLabel})`,
					);
					created++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
				} else {
					try {
						const createdFlag = await createFeatureFlag(
							ddApiKey,
							ddAppKey,
							request,
							ddSite,
						);

						// Apply restriction policy for LD editor teams
						if (editorTeamIds.length > 0) {
							await applyRestrictionPolicyForFlag(
								ddApiKey,
								ddAppKey,
								createdFlag.id,
								editorTeamIds,
								ddSite,
								ddKey,
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
									key: ddKey,
									env: ddEnv.name,
									error: formatAxiosError(err),
								});
							}
						}

						totalEnabled += enabledCount;
						const enableLabel =
							enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
						spinner.succeed(
							`Created ${chalk.cyan(ddKey)} (${allFilterLabel}${allRuleLabel}${enableLabel})`,
						);
						created++;
						progressBar?.update(flag.key, {
							created,
							skipped,
							failed: errored,
						});
					} catch (err) {
						spinner.fail(
							`Failed ${chalk.cyan(ddKey)}: ${chalk.red(formatAxiosError(err))}`,
						);
						failures.push({ key: ddKey, error: formatAxiosError(err) });
						errored++;
						progressBar?.update(flag.key, {
							created,
							skipped,
							failed: errored,
						});
					}
				}
			}
		}
	} finally {
		process.removeListener('SIGINT', sigintHandler);
		progressBar?.finalize();
	}

	// ─── Summary ───────────────────────────────────────────────────────────────
	console.log();
	console.log(chalk.bold(dryRun ? 'Dry run complete!' : 'Migration complete!'));
	const syncedSummary =
		synced > 0
			? `  ${chalk.hex('#632CA6')(String(synced))} ${dryRun ? 'would be synced' : 'synced'}`
			: '';
	const enabledSummary =
		!dryRun && totalEnabled > 0
			? `  ${chalk.hex('#632CA6')(String(totalEnabled))} enabled`
			: '';
	console.log(
		`  ${chalk.green(String(created))} ${dryRun ? 'would be created' : 'created'}${syncedSummary}  ${chalk.yellow(String(skipped))} skipped  ${chalk.red(String(errored))} failed${enabledSummary}`,
	);
	if (failures.length > 0) {
		console.log();
		for (const f of failures) {
			console.log(`  ${chalk.red('✗')} ${f.key}: ${f.error}`);
		}
	}
	if (enableFailures.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				'  Flags created but could not be enabled in some environments:',
			),
		);
		for (const f of enableFailures) {
			console.log(`  ${chalk.yellow('⚠')} ${f.key} / ${f.env}: ${f.error}`);
		}
	}
	if (restrictionPolicyFailures.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				`  ${restrictionPolicyFailures.length} flag(s) migrated but did not have editor team restrictions applied. Reapply manually or rerun the migration.`,
			),
		);
		for (const f of restrictionPolicyFailures) {
			console.log(`  ${chalk.yellow('⚠')} ${f.key}: ${f.error}`);
		}
	}

	// ─── Persist Results ───────────────────────────────────────────────────────
	const timestamp = new Date().toISOString();

	if (dryRun && dryRunRequests.length > 0) {
		const dryRunData = {
			provider: 'launchdarkly',
			migratedAt: timestamp,
			success: true,
			summary: { created, synced, skipped, errored: 0, enabled: 0 },
			failures: [],
			enableFailures: [],
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			flags: detailedFlags.map((f) => ({
				key: f.key,
				name: f.name,
				kind: f.kind,
			})),
			environmentMapping: environmentMappingArr,
			requests: dryRunRequests,
		};
		const filename = `dry-run-${timestamp}.json`;
		const filepath = path.join(process.cwd(), filename);
		fs.writeFileSync(filepath, JSON.stringify(dryRunData, null, 2));
		console.log(chalk.gray(`  Requests written to ${filepath}`));
	}

	if (!dryRun && (created > 0 || synced > 0 || errored > 0)) {
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
			flags: detailedFlags,
			environmentMapping: environmentMappingArr,
		};
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
				message: 'Would you like to export migration results to an .xlsx file?',
				default: false,
			});
		}
		if (exportToSheets) {
			const { exportLDMigrationToXlsx } = await import('./xlsx.js');
			await exportLDMigrationToXlsx(migrationData);
		}
	}

	console.log();
	if (nonInteractive && errored > 0) process.exit(1);
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
	printHeader();
	if (dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	const projectSpinner = ora('Fetching LaunchDarkly projects…').start();
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
	const loadSpinner = ora('Fetching flags and Datadog data…').start();
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

	// Detect cross-project conflicts and prompt for resolution
	const crossProjectConflicts = allFlags.filter(
		(f) =>
			classifyConflict(datadogFlags, selectedProject.key, f.key).type ===
			'cross_project',
	);

	let conflictResolution: ConflictResolution | undefined;
	if (crossProjectConflicts.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				`  ${crossProjectConflicts.length} flag(s) have key conflicts with flags from other LaunchDarkly projects`,
			),
		);
		console.log();

		const action = await select<'skip' | 'prefix'>({
			message: 'How would you like to handle these conflicts?',
			choices: [
				{ name: 'Skip conflicting flags', value: 'skip' },
				{
					name: 'Add a prefix to conflicting flag keys',
					value: 'prefix',
				},
			],
		});

		if (action === 'skip') {
			conflictResolution = { action: 'skip' };
		} else {
			const prefix = await input({
				message: 'Enter a prefix for conflicting flag keys:',
				validate: (val) => {
					const trimmed = val.trim();
					if (trimmed.length === 0) return 'Prefix cannot be empty';
					if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed))
						return 'Prefix must contain only lowercase letters, numbers, and hyphens';
					return true;
				},
			});
			conflictResolution = { action: 'prefix', prefix: prefix.trim() };
		}
	}

	let prevSelectedEnvKeys: string[] = [];
	let prevEnvMapping = new Map<string, DatadogEnvironment>();
	let prevSelectedFlags: LDFlag[] = [];

	// eslint-disable-next-line no-constant-condition
	outer: while (true) {
		// Select LD environments
		clearScreen();
		printHeader();
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
				printHeader();
				const flagResult = await selectFlags(
					allFlags,
					datadogFlags,
					selectedProject.key,
					prevSelectedFlags,
					conflictResolution,
				);
				if (flagResult === null) break;

				prevSelectedFlags = flagResult;
				clearScreen();
				printHeader();
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
	printHeader();
	console.log(chalk.gray('  Running in non-interactive mode\n'));
	if (dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	const projectSpinner = ora('Fetching LaunchDarkly projects…').start();
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

	const loadSpinner = ora(
		`Fetching ${ni.flagKeys.length} flag(s) and Datadog data…`,
	).start();
	let selectedFlags: LDFlag[];
	let ldEnvironments: LDEnvironment[];
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];
	try {
		[selectedFlags, ldEnvironments, datadogFlags, datadogEnvs] =
			await Promise.all([
				fetchFlagsByKey(ldApiKey, selectedProject.key, ni.flagKeys),
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
		},
	);
}
