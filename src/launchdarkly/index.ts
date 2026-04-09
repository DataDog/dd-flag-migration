import fs from 'node:fs';
import path from 'node:path';
import { confirm, password, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import {
	CONFIG_DIR,
	getLaunchDarklyApiKey,
	saveLaunchDarklyApiKey,
} from '../config.js';
import {
	createFeatureFlag,
	enableFeatureFlagEnvironment,
	fetchDatadogEnvironments,
	fetchDatadogFlagKeys,
	syncAllocationsForEnvironment,
} from '../datadog.js';
import {
	filterableCheckbox,
	filterableSelect,
} from '../filterable-checkbox.js';
import { toSyncRequests } from '../migration.js';
import type { DatadogCreateFlagRequest, DatadogEnvironment } from '../types.js';
import {
	fetchFlag,
	fetchFlagRelease,
	fetchFlags,
	fetchProjectEnvironments,
	fetchProjects,
	isReleaseInProgress,
	type LDProject,
	validateLDApiKey,
} from './api.js';
import {
	buildAllocations,
	buildVariants,
	getEnvsToEnable,
	mapFlagType,
	shouldSkipFlag,
} from './migration.js';
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

function flagLabel(flag: LDFlag, inDatadog: boolean): string {
	const indicator = inDatadog ? chalk.green('✓') : ' ';
	const name = flag.name;
	const key = chalk.gray(`(${flag.key})`);
	const badge = inDatadog
		? `  ${chalk.bgGreen.black(' In Datadog — will sync targeting ')}`
		: '';
	const kind = flag.kind === 'boolean' ? '' : chalk.dim(` [${flag.kind}]`);
	return `${indicator}  ${name}  ${key}${kind}${badge}`;
}

// ─── Prompt Steps ────────────────────────────────────────────────────────────

async function promptForLDApiKey(): Promise<string> {
	const storedKey = getLaunchDarklyApiKey();

	if (storedKey) {
		const useStored = await confirm({
			message: 'Use your saved LaunchDarkly API key?',
			default: true,
		});
		if (useStored) return storedKey;
	}

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const apiKey = await password({
			message: 'Enter your LaunchDarkly API key:',
			validate: (input) =>
				input.trim().length > 0 ? true : 'API key cannot be empty',
		});

		const spinner = ora('Validating API key…').start();
		const valid = await validateLDApiKey(apiKey.trim());

		if (valid) {
			spinner.succeed('API key validated!');
			saveLaunchDarklyApiKey(apiKey.trim());
			console.log(chalk.gray('  Key saved for future sessions.\n'));
			return apiKey.trim();
		}
		spinner.fail(chalk.red('Invalid API key. Please try again.'));
	}
}

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
	datadogKeys: Map<string, string>,
	previouslySelected: LDFlag[] = [],
): Promise<LDFlag[] | null> {
	const inDatadogCount = flags.filter((f) => datadogKeys.has(f.key)).length;
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
	console.log();

	const sortedFlags = flags.slice().sort((a, b) => {
		const aDD = datadogKeys.has(a.key) ? 0 : 1;
		const bDD = datadogKeys.has(b.key) ? 0 : 1;
		if (aDD !== bDD) return aDD - bDD;
		return a.name.localeCompare(b.name);
	});

	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

	return filterableCheckbox<LDFlag>({
		message: 'Select flags to migrate to Datadog:',
		choices: sortedFlags.map((flag) => ({
			name: flagLabel(flag, datadogKeys.has(flag.key)),
			value: flag,
			checked: previousKeys.has(flag.key),
		})),
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
	ddApiKey: string;
	ddAppKey: string;
	ddSite: string;
	dryRun: boolean;
}

async function executeMigration(
	flags: LDFlag[],
	allFlags: LDFlag[],
	envMapping: Map<string, DatadogEnvironment>,
	datadogKeys: Map<string, string>,
	selectedEnvs: string[],
	opts: MigrationOptions,
): Promise<ConfirmAction> {
	const { ldApiKey, projectKey, ddApiKey, ddAppKey, ddSite, dryRun } = opts;

	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to migrate.'));
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
	const skippedFlags: Array<{ key: string; reason: string }> = [];
	const syncedFlagKeys: string[] = [];
	const dryRunRequests: Array<{ method: string; path: string; body: unknown }> =
		[];

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
			continue;
		}

		// Check progressive rollout status via releases API
		if (skipResult.hasProgressiveRollout) {
			try {
				const release = await fetchFlagRelease(ldApiKey, projectKey, flag.key);
				if (release && isReleaseInProgress(release)) {
					spinner.warn(
						`Skipped ${chalk.cyan(flag.key)} — progressive rollout is in progress`,
					);
					skippedFlags.push({
						key: flag.key,
						reason: 'Progressive rollout is in progress',
					});
					skipped++;
					continue;
				}
				// Release is complete or not found — safe to migrate
			} catch (err) {
				spinner.warn(
					`Skipped ${chalk.cyan(flag.key)} — failed to check progressive rollout status`,
				);
				skippedFlags.push({
					key: flag.key,
					reason: 'Failed to check progressive rollout status',
				});
				skipped++;
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
			continue;
		}

		const variants = buildVariants(flag);
		if (variants.length === 0) {
			spinner.warn(`Skipped ${chalk.cyan(flag.key)} — no variants`);
			skippedFlags.push({ key: flag.key, reason: 'No variants' });
			skipped++;
			continue;
		}

		const allocations = buildAllocations(flag, envMapping);
		const envsToEnable = getEnvsToEnable(flag, envMapping);
		const existingFlagId = datadogKeys.get(flag.key);

		const allRuleCount = allocations.reduce(
			(sum, a) => sum + (a.targeting_rules?.length ?? 0),
			0,
		);
		const allFilterLabel = `${allocations.length} targeting filter(s)`;
		const allRuleLabel = allRuleCount > 0 ? `, ${allRuleCount} rule(s)` : '';

		if (existingFlagId) {
			if (envsToEnable.length === 0) {
				spinner.succeed(
					`${chalk.cyan(flag.key)} — already in Datadog, nothing to sync`,
				);
				skippedFlags.push({
					key: flag.key,
					reason: 'Already in Datadog, no new environments to enable',
				});
				skipped++;
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
					if (syncReqs.length > 0) {
						dryRunRequests.push({
							method: 'PUT',
							path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/allocations`,
							body: syncReqs,
						});
					}
					dryRunRequests.push({
						method: 'POST',
						path: `/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/enable`,
						body: {},
					});
				}
				const syncFilterLabel = `${syncFilterCount} targeting filter(s)`;
				const syncRuleLabel =
					syncRuleCount > 0 ? `, ${syncRuleCount} rule(s)` : '';
				const enableLabel =
					envsToEnable.length > 0
						? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
						: '';
				spinner.succeed(
					`${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} ` +
						`(${syncFilterLabel}${syncRuleLabel}${enableLabel})`,
				);
				syncedFlagKeys.push(flag.key);
				synced++;
			} else {
				try {
					let syncedAllocCount = 0;
					let syncedRuleCount = 0;
					for (const ddEnv of envsToEnable) {
						const syncReqs = toSyncRequests(allocations, ddEnv.id);
						if (syncReqs.length > 0) {
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
					const enableLabel =
						enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
					spinner.succeed(
						`Synced ${chalk.cyan(flag.key)} (${syncedAllocCount} targeting filter(s)${syncedRuleLabel}${enableLabel})`,
					);
					syncedFlagKeys.push(flag.key);
					synced++;
				} catch (err) {
					spinner.fail(
						`Failed to sync ${chalk.cyan(flag.key)}: ${chalk.red(formatAxiosError(err))}`,
					);
					failures.push({ key: flag.key, error: formatAxiosError(err) });
					errored++;
				}
			}
		} else {
			const request: DatadogCreateFlagRequest = {
				key: flag.key,
				name: flag.name,
				value_type: mapFlagType(flag),
				variants,
				allocations: allocations.length > 0 ? allocations : undefined,
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
						path: `/api/v2/feature-flags/${flag.key}/environments/${ddEnv.id}/enable`,
						body: {},
					});
				}

				const enableLabel =
					envsToEnable.length > 0
						? `, would enable in ${envsToEnable.map((e) => e.name).join(', ')}`
						: '';
				spinner.succeed(
					`${chalk.dim('[dry run]')} Would create ${chalk.cyan(flag.key)} ` +
						`(${allFilterLabel}${allRuleLabel}${enableLabel})`,
				);
				created++;
			} else {
				try {
					const createdFlag = await createFeatureFlag(
						ddApiKey,
						ddAppKey,
						request,
						ddSite,
					);

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
					spinner.succeed(
						`Created ${chalk.cyan(flag.key)} (${allFilterLabel}${allRuleLabel}${enableLabel})`,
					);
					created++;
				} catch (err) {
					spinner.fail(
						`Failed ${chalk.cyan(flag.key)}: ${chalk.red(formatAxiosError(err))}`,
					);
					failures.push({ key: flag.key, error: formatAxiosError(err) });
					errored++;
				}
			}
		}
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

	// ─── Persist Results ───────────────────────────────────────────────────────
	const timestamp = new Date().toISOString();
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
		const selectedFlagKeys = new Set(detailedFlags.map((f) => f.key));
		const unmigratedFlags = allFlags.filter(
			(f) => !selectedFlagKeys.has(f.key),
		);

		const migrationData: LDMigrationFile = {
			provider: 'launchdarkly',
			migratedAt: timestamp,
			success: errored === 0,
			summary: { created, synced, skipped, errored, enabled: totalEnabled },
			failures,
			enableFailures,
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			syncedFlagKeys: syncedFlagKeys.length > 0 ? syncedFlagKeys : undefined,
			flags: detailedFlags,
			unmigrated: unmigratedFlags.length > 0 ? unmigratedFlags : undefined,
			environmentMapping: environmentMappingArr,
		};
		const filename = `migration-${timestamp}.json`;
		if (!fs.existsSync(CONFIG_DIR))
			fs.mkdirSync(CONFIG_DIR, { recursive: true });
		const filepath = path.join(CONFIG_DIR, filename);
		fs.writeFileSync(filepath, JSON.stringify(migrationData, null, 2));
		console.log(chalk.gray(`  Migration saved to ${filepath}`));

		const exportToSheets = await confirm({
			message: 'Would you like to export migration results to an .xlsx file?',
			default: false,
		});
		if (exportToSheets) {
			const { exportLDMigrationToXlsx } = await import('./xlsx.js');
			await exportLDMigrationToXlsx(migrationData);
		}
	}

	console.log();
	return 'migrate';
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function runLaunchDarklyMigration(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
): Promise<void> {
	// Prompt for LD API key
	const ldApiKey = await promptForLDApiKey();

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
	let datadogKeys: Map<string, string> = new Map();
	let datadogEnvs: DatadogEnvironment[] = [];
	try {
		[allFlags, ldEnvironments, datadogKeys, datadogEnvs] = await Promise.all([
			fetchFlags(ldApiKey, selectedProject.key),
			fetchProjectEnvironments(ldApiKey, selectedProject.key),
			fetchDatadogFlagKeys(ddApiKey, ddAppKey, ddSite),
			fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
		]);
		loadSpinner.succeed(
			`Loaded ${allFlags.length} LD flag(s) · ${ldEnvironments.length} LD environment(s) · ${datadogEnvs.length} Datadog environment(s)`,
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
					datadogKeys,
					prevSelectedFlags,
				);
				if (flagResult === null) break;

				prevSelectedFlags = flagResult;
				clearScreen();
				printHeader();
				const action = await executeMigration(
					prevSelectedFlags,
					allFlags,
					prevEnvMapping,
					datadogKeys,
					prevSelectedEnvKeys,
					{
						ldApiKey,
						projectKey: selectedProject.key,
						ddApiKey,
						ddAppKey,
						ddSite,
						dryRun,
					},
				);
				if (action === 'cancel') break outer;
				if (action === 'migrate') break outer;
			}
		}
	}
}
