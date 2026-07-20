import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import chalk from 'chalk';
import { filterableCheckbox } from '../components/FilterableCheckbox.js';
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
	createFeatureFlag,
	enableFeatureFlagEnvironment,
	fetchDatadogEnvironments,
	fetchDatadogFlagKeys,
	fetchFlagDetail,
	syncAllocationsForEnvironment,
	syncVariantsCreatesAndUpdates,
	updateFlagDistributionChannel,
	updateFlagTags,
} from '../datadog/api.js';
import {
	buildVariantSyncDryRunRequests,
	eppoSourceIdLookupKey,
} from '../datadog/helpers.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	MigrationEnvironmentMapping,
} from '../datadog/types.js';
import { CONFIG_DIR } from '../helpers/config.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { toSyncRequests } from '../helpers/migration.js';
import { writeJsonOutput } from '../helpers/output.js';
import { extractEnvironments, fetchEppoFlags } from './api.js';
import { migrateAudiences } from './audiences.js';
import { EppoMigrationSummary } from './components/EppoMigrationSummary.js';
import {
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	getEnvsToEnable,
	hasJsonArrayVariants,
	hasSemverConditions,
	mapVariationType,
	normalizeJsonVariantValue,
	slugify,
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

function datadogIdForEppoFlag(
	flag: EppoFlag,
	datadogKeys: Map<string, string>,
): string | undefined {
	return (
		datadogKeys.get(flag.key) ??
		datadogKeys.get(eppoSourceIdLookupKey(String(flag.id)))
	);
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
		await printHeader();
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
			chalk.gray(
				`  ${inDatadogCount} flag(s) already exist in Datadog (will sync targeting for new environments) `,
			) + chalk.green('✓'),
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
		message: 'Select flags to migrate to Datadog:',
		choices: sortedFlags.map((flag) => ({
			name: flagLabel(
				flag,
				datadogIdForEppoFlag(flag, datadogKeys) !== undefined,
			),
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
	nonInteractive = false,
	doExport = false,
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
	const failures: Array<{ key: string; error: string }> = [];
	const enableFailures: Array<{ key: string; env: string; error: string }> = [];
	const skippedFlags: Array<{ key: string; reason: string }> = [];
	const semverForcedClientKeys: string[] = [];
	const jsonArrayWrappedKeys: string[] = [];
	let runner: MigrationRunnerHandle | undefined;

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
		if (runner) runner.finalize();
		else process.stderr.write('\n');
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
				const variants = (flag.variations ?? []).map((v) => ({
					key: slugify(v.name),
					name: v.name,
					value: isJsonFlag
						? normalizeJsonVariantValue(v.variant_key)
						: v.variant_key,
					// EppoFlagVariation.id is the stable identifier — survives renames.
					sourceId: String(v.id),
				}));
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
				const existingFlagId = datadogIdForEppoFlag(flag, datadogKeys);

				// Count targeting rules for reporting (all environments — used for new-flag path)
				const allRuleCount = allocations.reduce(
					(sum, a) => sum + (a.targeting_rules?.length ?? 0),
					0,
				);
				const allFilterLabel = `${allocations.length} targeting filter(s)`;
				const allRuleLabel =
					allRuleCount > 0 ? `, ${allRuleCount} rule(s)` : '';

				if (existingFlagId) {
					// Flag already exists in Datadog — sync targeting and enable in new environments
					const syncTags = flag.tag_names ?? [];

					if (envsToEnable.length === 0) {
						// Always sync tags (even empty array, so removals propagate).
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
								site,
							);
							const { createUpdateRequests } = buildVariantSyncDryRunRequests(
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
						} else {
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
							if (hasSemverConditions(allocations)) {
								await updateFlagDistributionChannel(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									'CLIENT',
									site,
								);
								semverForcedClientKeys.push(flag.key);
							}
						}
						const variantLabel = formatVariantLabel(variantCounts);
						doSync(
							dryRun
								? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (${syncTags.length} tag(s)${variantLabel})`
								: `${chalk.green('✓')} Synced ${chalk.cyan(flag.key)} (${syncTags.length} tag(s)${variantLabel})`,
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
							site,
						);
						const { createUpdateRequests, deleteRequests } =
							buildVariantSyncDryRunRequests(
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
								'eppo',
								site,
							);
							const variantCounts = variantSyncResult.counts;
							if (hasSemverConditions(allocations)) {
								await updateFlagDistributionChannel(
									ddApiKey,
									ddAppKey,
									existingFlagId,
									'CLIENT',
									site,
								);
								semverForcedClientKeys.push(flag.key);
							}
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

							// Now safe to delete: allocations no longer reference these.
							await applyVariantDeletes(
								ddApiKey,
								ddAppKey,
								existingFlagId,
								variantSyncResult.pendingDeletes,
								site,
							);

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
							const variantLabel = formatVariantLabel(variantCounts);
							const enableLabel =
								enabledCount > 0 ? `, enabled in ${enabledCount} env(s)` : '';
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
					// Flag does not exist — create it with targeting rules
					const tags = flag.tag_names ?? [];
					const request: DatadogCreateFlagRequest = {
						key: flag.key,
						name: flag.name,
						value_type: mapVariationType(flag.variation_type),
						variants,
						allocations: allocations.length > 0 ? allocations : undefined,
						migration_metadata: {
							provider: 'eppo',
							source_id: String(flag.id),
							source_key: flag.key,
						},
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
						doCreate(
							`${chalk.dim('[dry run]')} Would create ${chalk.cyan(flag.key)} ` +
								`(${allFilterLabel}${allRuleLabel}${enableLabel})`,
						);
					} else {
						try {
							const createdFlag = await createFeatureFlag(
								ddApiKey,
								ddAppKey,
								request,
								site,
							);
							if (hasSemverConditions(allocations)) {
								semverForcedClientKeys.push(flag.key);
							}

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
							doCreate(
								`${chalk.green('✓')} Created ${chalk.cyan(flag.key)} (${allFilterLabel}${allRuleLabel}${enableLabel})`,
							);
						} catch (err) {
							const error = formatAxiosError(err);
							doFail(flag.key, error);
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
			counts={{ created, synced, skipped, errored, enabled: totalEnabled }}
			failures={failures}
			enableFailures={enableFailures}
		/>,
	);

	const timestamp = new Date().toISOString();
	let outputData: DryRunFile | MigrationFile | undefined;

	if (dryRun) {
		const dryRunData: DryRunFile = {
			provider,
			migratedAt: timestamp,
			success: errored === 0,
			summary: { created, synced, skipped, errored, enabled: 0 },
			failures,
			enableFailures: [],
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
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
			summary: { created, synced, skipped, errored, enabled: totalEnabled },
			failures,
			enableFailures,
			skippedFlags: skippedFlags.length > 0 ? skippedFlags : undefined,
			semverForcedClientKeys:
				semverForcedClientKeys.length > 0 ? semverForcedClientKeys : undefined,
			jsonArrayWrappedKeys:
				jsonArrayWrappedKeys.length > 0 ? jsonArrayWrappedKeys : undefined,
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

			let exportToSheets: boolean;
			if (nonInteractive) {
				exportToSheets = doExport;
			} else {
				const { confirm } = await import('../components/Confirm.js');
				exportToSheets = await confirm({
					message:
						'Would you like to export migration results to an .xlsx file?',
					default: false,
				});
			}
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
		);
		return;
	}

	console.log();

	const spinner = createSpinner('Loading data…').start();
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
	envMapping: Map<number, DatadogEnvironment>;
	selectedEnvs: EppoFlagEnvironment[];
} {
	const envMapping = new Map<number, DatadogEnvironment>();
	const selectedEnvs: EppoFlagEnvironment[] = [];
	const ddByName = new Map(datadogEnvs.map((e) => [e.name, e]));
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
		envMapping.set(eppoEnv.id, ddEnv);
		selectedEnvs.push(eppoEnv);
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
		console.error(chalk.red(`  ${formatAxiosError(err)}`));
		process.exit(1);
	}

	const eppoEnvironments = extractEnvironments(flags);

	let envMapping: Map<number, DatadogEnvironment>;
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
		true,
		doExport,
	);
}
