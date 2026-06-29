import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import { CONFIG_DIR } from '../config.js';
import {
	applyRestrictionPolicy,
	applyVariantDeletes,
	buildVariantSyncDryRunRequests,
	createFeatureFlag,
	type DatadogTeam,
	type DDRestrictionBinding,
	enableFeatureFlagEnvironment,
	fetchDatadogTeams,
	fetchFlagDetail,
	fetchRestrictionPolicy,
	syncAllocationsForEnvironment,
	syncVariantsCreatesAndUpdates,
	updateFlagTags,
} from '../datadog.js';
import { filterableSelect } from '../filterable-checkbox.js';
import { toSyncRequests } from '../migration.js';
import { writeJsonOutput } from '../output.js';
import { MigrationProgressBar } from '../progress-bar.js';
import { createPromptKit } from '../provider/prompt-kit.js';
import type { ProviderContext } from '../provider/types.js';
import { createSpinner } from '../spinner.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogFlagEntry,
} from '../types.js';
import {
	fetchCustomRoles,
	fetchFlag,
	fetchFlagRelease,
	fetchTeamsWithRoles,
	isReleaseInProgress,
} from './api.js';
import {
	type ConflictResolution,
	classifyConflict,
	classifyNonInteractiveConflict,
} from './conflicts.js';
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
import { clearScreen } from './prompts.js';
import { selectLDMigrationPlan } from './provider.js';
import {
	discoverSegmentRefs,
	migrateSegments,
	planDryRunSegments,
} from './segments.js';
import type { LDFlag, LDMigrationFile } from './types.js';

export type {
	ConflictClassification,
	ConflictResolution,
	ConflictType,
	LDFlagMigrationSpec,
	NonInteractiveConflictClassification,
	NonInteractiveConflictType,
} from './conflicts.js';
// Re-exported so external callers (tests, callers importing from `./launchdarkly`)
// can continue to find these here.
export {
	classifyConflict,
	classifyNonInteractiveConflict,
	parseLDFlagMigrationSpecs,
} from './conflicts.js';
export { resolveLDEnvMap } from './non-interactive.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatVariantLabel(counts: {
	added: number;
	updated: number;
	deleted: number;
}): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`${counts.added} variant(s) added`);
	if (counts.updated > 0) parts.push(`${counts.updated} variant(s) updated`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} variant(s) deleted`);
	return parts.length > 0 ? `, ${parts.join(', ')}` : '';
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

export interface ExecuteLDMigrationParams {
	flags: LDFlag[];
	envMapping: Map<string, DatadogEnvironment>;
	datadogFlags: DatadogFlagEntry[];
	selectedEnvs: string[];
	ldApiKey: string;
	projectKey: string;
	projectName: string;
	ddApiKey: string;
	ddAppKey: string;
	ddSite: string;
	dryRun: boolean;
	conflictResolution?: ConflictResolution;
	nonInteractive: boolean;
	doExport: boolean;
	targetKeyBySource?: Map<string, string>;
}

// Phase B for LaunchDarkly: segment migration, conflict-resolved flag creation,
// variant/allocation sync, restriction policies, env enabling, xlsx export.
// The user has already confirmed via Phase A (see ldProvider.selectMigrationPlan)
// so this function executes unconditionally.
export async function executeLDMigration(
	params: ExecuteLDMigrationParams,
): Promise<void> {
	const {
		flags,
		envMapping,
		datadogFlags,
		selectedEnvs,
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
	} = params;

	// Fetch full flag details for selected flags
	const detailSpinner = createSpinner(
		`Fetching details for ${flags.length} flag(s)…`,
	).start();
	let detailedFlags: LDFlag[];
	try {
		detailedFlags = await loadFlagDetails(ldApiKey, projectKey, flags);
		detailSpinner.succeed(`Loaded details for ${detailedFlags.length} flag(s)`);
	} catch (err) {
		detailSpinner.fail('Failed to fetch flag details');
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		return;
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
	const dryRunRequests: Array<{ method: string; path: string; body: unknown }> =
		[];
	const flagKeyMapping =
		targetKeyBySource === undefined
			? undefined
			: detailedFlags
					.map((flag) => ({
						sourceKey: flag.key,
						datadogKey: targetKeyBySource.get(flag.key) ?? flag.key,
					}))
					.filter((mapping) => mapping.datadogKey !== mapping.sourceKey);
	const progressBar = nonInteractive
		? undefined
		: new MigrationProgressBar(detailedFlags.length, phase1Subheader);

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
				flagKeyMapping,
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
	progressBar?.start();
	try {
		for (const flag of detailedFlags) {
			let spinner = createSpinner(`Migrating ${chalk.cyan(flag.key)}…`).start();

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
				segmentConstantLookup,
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
				spinner.fail(`Failed ${chalk.cyan(flag.key)}: ${chalk.red(reason)}`);
				failures.push({ key: flag.key, error: reason });
				errored++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}

			// Cross-project conflict: skip or prefix
			if (!nonInteractive && conflict.type === 'cross_project') {
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
				conflict.type === 'same_project' ||
				(!nonInteractive && conflict.type === 'manual')
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
					spinner.succeed(
						dryRun
							? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (${tagLabel}${variantLabel}${policyLabel})`
							: `Synced ${chalk.cyan(flag.key)} (${tagLabel}${variantLabel}${policyLabel})`,
					);
					syncedFlagKeys.push(flag.key);
					synced++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
					continue;
				}

				spinner.warn(
					`${chalk.cyan(flag.key)} exists in Datadog — targeting filters in ${envsToEnable.map((e) => e.name).join(', ')} will be overwritten`,
				);
				spinner = createSpinner(`Migrating ${chalk.cyan(flag.key)}…`).start();

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
					spinner.succeed(
						`${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} ` +
							`(${syncFilterLabel}${syncRuleLabel}${variantLabel}${tagLabel}${enableLabel})`,
					);
					syncedFlagKeys.push(flag.key);
					synced++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
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
						spinner.succeed(
							`Synced ${chalk.cyan(flag.key)} (${syncedAllocCount} targeting filter(s)${syncedRuleLabel}${variantLabel}${tagLabel}${enableLabel})`,
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
					!nonInteractive &&
					conflict.type === 'cross_project' &&
					conflictResolution?.action === 'prefix';
				const ddKey = usePrefix
					? `${conflictResolution.prefix}-${flag.key}`
					: targetKey;

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
			flagKeyMapping,
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
			flagKeyMapping,
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
				const { exportLDMigrationToXlsx } = await import('./xlsx.js');
				await exportLDMigrationToXlsx(migrationData);
			}
		}
	}

	if (nonInteractive && outputData) {
		writeJsonOutput(outputData);
	}

	console.log();
	if (nonInteractive && errored > 0) process.exitCode = 1;
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
	const ctx: ProviderContext = {
		promptKit: createPromptKit(),
		datadog: { apiKey: ddApiKey, appKey: ddAppKey, site: ddSite },
		dryRun,
		nonInteractive: options?.nonInteractive
			? {
					envMap: options.nonInteractive.envMap,
					flagKeys: options.nonInteractive.flagKeys,
					projectKey: options.nonInteractive.projectKey,
				}
			: undefined,
	};

	const plan = await selectLDMigrationPlan(ctx);
	if (!plan) return;

	await executeLDMigration({
		flags: plan.selectedFlags,
		envMapping: plan.envMapping,
		datadogFlags: plan.extras.datadogFlags,
		selectedEnvs: Array.from(plan.envMapping.keys()),
		ldApiKey: plan.extras.ldApiKey,
		projectKey: plan.extras.projectKey,
		projectName: plan.extras.projectName,
		ddApiKey,
		ddAppKey,
		ddSite,
		dryRun,
		conflictResolution: plan.extras.conflictResolution,
		nonInteractive: !!options?.nonInteractive,
		doExport: options?.doExport ?? false,
		targetKeyBySource: plan.extras.targetKeyBySource,
	});
}
