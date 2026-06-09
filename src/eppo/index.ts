import fs from 'node:fs';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { CONFIG_DIR } from '../config.js';
import {
	createFeatureFlag,
	enableFeatureFlagEnvironment,
	fetchDatadogEnvironments,
	fetchDatadogFlagKeys,
	syncAllocationsForEnvironment,
	updateFlagTags,
} from '../datadog.js';
import { filterableCheckbox } from '../filterable-checkbox.js';
import { toSyncRequests } from '../migration.js';
import { MigrationProgressBar } from '../progress-bar.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	MigrationEnvironmentMapping,
} from '../types.js';
import { extractEnvironments, fetchEppoFlags } from './api.js';
import { migrateAudiences } from './audiences.js';
import {
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	getEnvsToEnable,
	hasSemverConditions,
	mapVariationType,
	normalizeJsonVariantValue,
	slugify,
} from './migration.js';
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
			chalk.hex('#632CA6')('              Eppo → Datadog              ') +
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

function envLabel(env: EppoFlagEnvironment, flagCount: number): string {
	const prodBadge = env.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : '';
	return `${env.name}${prodBadge}  ${chalk.gray(`(${flagCount} flags)`)}`;
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

function flagLabel(flag: EppoFlag, inDatadog: boolean): string {
	const indicator = inDatadog ? chalk.green('✓') : ' ';
	const name = flag.name;
	const key = chalk.gray(`(${flag.key})`);
	const badge = inDatadog
		? `  ${chalk.bgGreen.black(' In Datadog — will sync targeting ')}`
		: '';
	return `${indicator}  ${name}  ${key}${badge}`;
}

// ─── Prompt Steps ─────────────────────────────────────────────────────────────

async function linkEnvironments(
	eppoEnvs: EppoFlagEnvironment[],
	ddEnvs: DatadogEnvironment[],
	previousMapping: Map<number, DatadogEnvironment>,
): Promise<Map<number, DatadogEnvironment> | null> {
	const mapping = new Map<number, DatadogEnvironment>(previousMapping);
	let i = 0;

	while (i < eppoEnvs.length) {
		const eppoEnv = eppoEnvs[i];
		const prevChoice = mapping.get(eppoEnv.id);

		clearScreen();
		printHeader();
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
			if (i === 0) return null; // back to Eppo env selection
			i--;
		} else {
			mapping.set(eppoEnv.id, result);
			i++;
		}
	}

	return mapping;
}

async function selectEnvironments(
	flags: EppoFlag[],
	environments: EppoFlagEnvironment[],
	previouslySelected: EppoFlagEnvironment[] = [],
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
		message: 'Select environments to migrate from:',
		choices: environments.map((env) => ({
			name: envLabel(env, flagCount.get(env.id) ?? 0),
			value: env,
			checked: previousIds.has(env.id),
		})),
		pageSize,
	});
}

async function selectFlags(
	flags: EppoFlag[],
	datadogKeys: Map<string, string>,
	selectedEnvs: EppoFlagEnvironment[],
	previouslySelected: EppoFlag[] = [],
): Promise<EppoFlag[] | null> {
	const selectedEnvIds = new Set(selectedEnvs.map((e) => e.id));
	const visibleFlags =
		selectedEnvIds.size > 0
			? flags.filter((f) =>
					f.environments?.some((e) => selectedEnvIds.has(e.id)),
				)
			: flags;

	const inDatadogCount = visibleFlags.filter((f) =>
		datadogKeys.has(f.key),
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
			chalk.gray(
				`  ${inDatadogCount} flag(s) already exist in Datadog (will sync targeting for new environments) `,
			) + chalk.green('✓'),
		);
	}
	console.log();

	const sortedFlags = visibleFlags.slice().sort((a, b) => {
		// Flags already in Datadog float to the top
		const aDD = datadogKeys.has(a.key) ? 0 : 1;
		const bDD = datadogKeys.has(b.key) ? 0 : 1;
		if (aDD !== bDD) return aDD - bDD;
		return a.name.localeCompare(b.name);
	});

	// Reserve lines for: found header (~3), prompt message, filter line, help tip, buffer
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

	return filterableCheckbox<EppoFlag>({
		message: 'Select flags to migrate to Datadog:',
		choices: sortedFlags.map((flag) => ({
			name: flagLabel(flag, datadogKeys.has(flag.key)),
			value: flag,
			checked: previousKeys.has(flag.key),
			migrated: datadogKeys.has(flag.key),
		})),
		pageSize,
	});
}

type ConfirmAction = 'migrate' | 'select-more' | 'cancel';

async function confirmMigration(
	flags: EppoFlag[],
	eppoApiKey: string,
	ddApiKey: string,
	ddAppKey: string,
	envMapping: Map<number, DatadogEnvironment>,
	datadogKeys: Map<string, string>,
	provider: string,
	site: string,
	dryRun: boolean,
): Promise<ConfirmAction> {
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
	flags.forEach((f) => {
		console.log(chalk.gray(`  •  ${f.name}`) + chalk.dim(`  (${f.key})`));
	});
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

	if (action === 'select-more') {
		return 'select-more';
	}

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
			const { created: ac, reused: ar, skipped: as_ } = audienceResult.stats;
			const createdVerb = dryRun ? 'would be created' : 'created';
			console.log(
				chalk.gray(
					`  Audiences: ${ac} ${createdVerb}, ${ar} reused, ${as_} skipped as saved filters`,
				),
			);
			phase1Subheader =
				chalk.gray('Phase 1 — Audiences: ') +
				chalk.green(String(ac)) +
				chalk.gray(` ${createdVerb} · `) +
				chalk.white(String(ar)) +
				chalk.gray(' reused · ') +
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
	const failures: Array<{ key: string; error: string }> = [];
	const enableFailures: Array<{ key: string; env: string; error: string }> = [];
	const skippedFlags: Array<{ key: string; reason: string }> = [];
	const progressBar = new MigrationProgressBar(flags.length, phase1Subheader);

	const environmentMapping: MigrationEnvironmentMapping[] = [];
	for (const [eppoEnvId, ddEnv] of envMapping) {
		const eppoEnv = flags
			.flatMap((f) => f.environments ?? [])
			.find((e) => e.id === eppoEnvId);
		environmentMapping.push({
			sourceEnvId: eppoEnvId,
			sourceEnvName: eppoEnv?.name ?? String(eppoEnvId),
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
			const migrationData: MigrationFile = {
				provider,
				migratedAt: timestamp,
				success: false,
				summary: { created, synced, skipped, errored, enabled: totalEnabled },
				failures,
				enableFailures,
				skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
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
	if (progressBar) clearScreen();
	progressBar?.start();
	try {
		for (const flag of flags) {
			let spinner = ora(`Migrating ${chalk.cyan(flag.key)}…`).start();

			if (flag.type === 'BANDIT') {
				spinner.warn(
					`Skipped ${chalk.cyan(flag.key)} — BANDIT type not supported`,
				);
				skippedFlags.push({
					key: flag.key,
					reason: 'BANDIT flags not supported',
				});
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}
			if (flag.type === 'LAYER') {
				spinner.warn(
					`Skipped ${chalk.cyan(flag.key)} — LAYER type not supported`,
				);
				skippedFlags.push({
					key: flag.key,
					reason: 'LAYER flags not supported',
				});
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}
			if ((flag.allocations ?? []).some((a) => a.type === 'SWITCHBACK')) {
				spinner.warn(
					`Skipped ${chalk.cyan(flag.key)} — SWITCHBACK targeting not supported`,
				);
				skippedFlags.push({
					key: flag.key,
					reason: 'SWITCHBACK targeting not supported',
				});
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}
			const isJsonFlag = flag.variation_type === 'JSON';
			const variants = (flag.variations ?? []).map((v) => ({
				key: slugify(v.name),
				name: v.name,
				value: isJsonFlag
					? normalizeJsonVariantValue(v.variant_key)
					: v.variant_key,
			}));
			if (variants.length === 0) {
				spinner.warn(`Skipped ${chalk.cyan(flag.key)} — no variants`);
				skipped++;
				progressBar?.update(flag.key, { created, skipped, failed: errored });
				continue;
			}

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
			);
			const envsToEnable = getEnvsToEnable(flag, envMapping);
			const existingFlagId = datadogKeys.get(flag.key);

			// Count targeting rules for reporting (all environments — used for new-flag path)
			const allRuleCount = allocations.reduce(
				(sum, a) => sum + (a.targeting_rules?.length ?? 0),
				0,
			);
			const allFilterLabel = `${allocations.length} targeting filter(s)`;
			const allRuleLabel = allRuleCount > 0 ? `, ${allRuleCount} rule(s)` : '';

			if (existingFlagId) {
				// Flag already exists in Datadog — sync targeting and enable in new environments
				const syncTags = flag.tag_names ?? [];

				if (envsToEnable.length === 0) {
					// Always sync tags (even empty array, so removals propagate).
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
					} else {
						await updateFlagTags(
							ddApiKey,
							ddAppKey,
							existingFlagId,
							syncTags,
							site,
						);
					}
					spinner.succeed(
						dryRun
							? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (${syncTags.length} tag(s))`
							: `Synced ${chalk.cyan(flag.key)} (${syncTags.length} tag(s))`,
					);
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
						const dvk = defaultVariantKeyPerEnv.get(ddEnv.id);
						dryRunRequests.push({
							method: 'PUT',
							path:
								`/api/v2/feature-flags/${existingFlagId}/environments/${ddEnv.id}/allocations` +
								(dvk !== undefined ? `?default_variant_key=${dvk}` : ''),
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
					synced++;
					progressBar?.update(flag.key, { created, skipped, failed: errored });
				} else {
					try {
						// Sync targeting for each target environment
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
								site,
								defaultVariantKeyPerEnv.get(ddEnv.id),
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
							site,
						);

						// Enable the flag in each environment
						let enabledCount = 0;
						for (const ddEnv of envsToEnable) {
							try {
								await enableFeatureFlagEnvironment(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									ddEnv.id,
									site,
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
				// Flag does not exist — create it with targeting rules
				const tags = flag.tag_names ?? [];
				const request: DatadogCreateFlagRequest = {
					key: flag.key,
					name: flag.name,
					value_type: mapVariationType(flag.variation_type),
					variants,
					allocations: allocations.length > 0 ? allocations : undefined,
					...(hasSemverConditions(allocations)
						? { distribution_channel: 'CLIENT' as const }
						: {}),
					...(tags.length > 0 ? { tags } : {}),
				};

				if (dryRun) {
					dryRunRequests.push({
						method: 'POST',
						path: '/api/v2/feature-flags',
						body: { data: { type: 'feature-flags', attributes: request } },
					});
					for (const ddEnv of envsToEnable) {
						const dvk = defaultVariantKeyPerEnv.get(ddEnv.id);
						// Only sync allocations when there's a default_variant_key to set —
						// allocations are already embedded in the create request body above.
						if (dvk !== undefined) {
							// flag.key used as placeholder — real ID assigned on creation
							dryRunRequests.push({
								method: 'PUT',
								path: `/api/v2/feature-flags/${flag.key}/environments/${ddEnv.id}/allocations?default_variant_key=${dvk}`,
								body: toSyncRequests(allocations, ddEnv.id),
							});
						}
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
					progressBar?.update(flag.key, { created, skipped, failed: errored });
				} else {
					try {
						const createdFlag = await createFeatureFlag(
							ddApiKey,
							ddAppKey,
							request,
							site,
						);

						// Set per-environment default_variant_key and enable each active environment
						let enabledCount = 0;
						for (const ddEnv of envsToEnable) {
							const dvk = defaultVariantKeyPerEnv.get(ddEnv.id);
							if (dvk !== undefined) {
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
							try {
								await enableFeatureFlagEnvironment(
									ddApiKey,
									ddAppKey,
									createdFlag.id,
									ddEnv.id,
									site,
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
						progressBar?.update(flag.key, {
							created,
							skipped,
							failed: errored,
						});
					} catch (err) {
						spinner.fail(
							`Failed ${chalk.cyan(flag.key)}: ${chalk.red(formatAxiosError(err))}`,
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
			}
		}
	} finally {
		process.removeListener('SIGINT', sigintHandler);
		progressBar?.finalize();
	}

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
		failures.forEach((f) => {
			console.log(`  ${chalk.red('✗')} ${f.key}: ${f.error}`);
		});
	}
	if (enableFailures.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				'  Flags created but could not be enabled in some environments:',
			),
		);
		enableFailures.forEach((f) => {
			console.log(`  ${chalk.yellow('⚠')} ${f.key} / ${f.env}: ${f.error}`);
		});
	}

	const timestamp = new Date().toISOString();

	if (dryRun && dryRunRequests.length > 0) {
		const dryRunData: DryRunFile = {
			provider,
			migratedAt: timestamp,
			success: true,
			summary: { created, synced, skipped, errored: 0, enabled: 0 },
			failures: [],
			enableFailures: [],
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			flags,
			environmentMapping,
			requests: dryRunRequests,
		};
		const filename = `dry-run-${timestamp}.json`;
		const filepath = path.join(process.cwd(), filename);
		fs.writeFileSync(filepath, JSON.stringify(dryRunData, null, 2));
		console.log(chalk.gray(`  Requests written to ${filepath}`));
	}

	if (!dryRun && (created > 0 || synced > 0 || errored > 0)) {
		const migrationData: MigrationFile = {
			provider,
			migratedAt: timestamp,
			success: errored === 0,
			summary: { created, synced, skipped, errored, enabled: totalEnabled },
			failures,
			enableFailures,
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			flags,
			environmentMapping,
		};
		const filename = `migration-${timestamp}.json`;
		if (!fs.existsSync(CONFIG_DIR))
			fs.mkdirSync(CONFIG_DIR, { recursive: true });
		const filepath = path.join(CONFIG_DIR, filename);
		fs.writeFileSync(filepath, JSON.stringify(migrationData, null, 2));
		console.log(chalk.gray(`  Migration saved to ${filepath}`));

		const { confirm } = await import('@inquirer/prompts');
		const exportToSheets = await confirm({
			message: 'Would you like to export migration results to an .xlsx file?',
			default: false,
		});
		if (exportToSheets) {
			const { exportMigrationToXlsx } = await import('./xlsx.js');
			await exportMigrationToXlsx(migrationData);
		}
	}

	console.log();
	return 'migrate';
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runEppoMigration(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
): Promise<void> {
	// EPPO_API_KEY presence was validated in src/index.ts before this runs.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const apiKey = process.env.EPPO_API_KEY!.trim();

	console.log();

	const spinner = ora('Loading data…').start();
	let flags: EppoFlag[] = [];
	let datadogKeys: Map<string, string> = new Map();
	let datadogEnvs: DatadogEnvironment[] = [];

	try {
		[flags, datadogKeys, datadogEnvs] = await Promise.all([
			fetchEppoFlags(apiKey, {
				onProgress: (fetched) => {
					spinner.text = `Loading data… (${fetched} Eppo flag${fetched === 1 ? '' : 's'} fetched)`;
				},
			}),
			fetchDatadogFlagKeys(ddApiKey, ddAppKey, ddSite),
			fetchDatadogEnvironments(ddApiKey, ddAppKey, ddSite),
		]);
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
	let prevEnvMapping = new Map<number, DatadogEnvironment>();
	let prevSelectedFlags: EppoFlag[] = [];

	// eslint-disable-next-line no-constant-condition
	outer: while (true) {
		let selectedEnvs: EppoFlagEnvironment[];

		if (eppoEnvironments.length > 0) {
			clearScreen();
			printHeader();
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
				printHeader();
				const flagResult = await selectFlags(
					flags,
					datadogKeys,
					selectedEnvs,
					prevSelectedFlags,
				);
				if (flagResult === null) break; // escaped → back to linking

				prevSelectedFlags = flagResult;
				clearScreen();
				printHeader();
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
				);
				if (action === 'cancel') break outer;
				if (action === 'migrate') break outer;
				// action === 'select-more': loop back to selectFlags
			}
		}

		if (eppoEnvironments.length === 0) break; // nothing to go back to
	}
}
