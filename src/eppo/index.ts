import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import chalk from 'chalk';
import { CONFIG_DIR } from '../config.js';
import {
	applyVariantDeletes,
	buildVariantSyncDryRunRequests,
	createFeatureFlag,
	enableFeatureFlagEnvironment,
	fetchFlagDetail,
	syncAllocationsForEnvironment,
	syncVariantsCreatesAndUpdates,
	updateFlagTags,
} from '../datadog.js';
import { toSyncRequests } from '../migration.js';
import { writeJsonOutput } from '../output.js';
import { MigrationProgressBar } from '../progress-bar.js';
import { createPromptKit } from '../provider/prompt-kit.js';
import type { ProviderContext } from '../provider/types.js';
import { createSpinner } from '../spinner.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	MigrationEnvironmentMapping,
} from '../types.js';
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
import { resolveEppoEnvMap, resolveEppoFlags } from './non-interactive.js';
import { clearScreen } from './prompts.js';
import { selectEppoMigrationPlan } from './provider.js';
import type { DryRunFile, EppoFlag, MigrationFile } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export interface ExecuteEppoMigrationParams {
	flags: EppoFlag[];
	eppoApiKey: string;
	ddApiKey: string;
	ddAppKey: string;
	envMapping: Map<number, DatadogEnvironment>;
	datadogKeys: Map<string, string>;
	site: string;
	dryRun: boolean;
	nonInteractive: boolean;
	doExport: boolean;
}

// Phase B for Eppo: audience migration, flag creation, env enabling, xlsx
// export. The user has already confirmed via Phase A (see
// EppoProvider.selectMigrationPlan) so this function executes unconditionally.
export async function executeEppoMigration(
	params: ExecuteEppoMigrationParams,
): Promise<void> {
	const {
		flags,
		eppoApiKey,
		ddApiKey,
		ddAppKey,
		envMapping,
		datadogKeys,
		site,
		dryRun,
		nonInteractive,
		doExport,
	} = params;
	const provider = 'eppo';

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
	const progressBar = nonInteractive
		? undefined
		: new MigrationProgressBar(flags.length, phase1Subheader);

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
	if (!nonInteractive) clearScreen();
	progressBar?.start();
	try {
		for (const flag of flags) {
			let spinner = createSpinner(`Migrating ${chalk.cyan(flag.key)}…`).start();

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
				// EppoFlagVariation.id is the stable identifier — survives renames.
				sourceId: String(v.id),
			}));
			if (variants.length === 0) {
				spinner.warn(`Skipped ${chalk.cyan(flag.key)} — no variants`);
				skippedFlags.push({ key: flag.key, reason: 'No variants' });
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
					}
					const variantLabel = formatVariantLabel(variantCounts);
					spinner.succeed(
						dryRun
							? `${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} (${syncTags.length} tag(s)${variantLabel})`
							: `Synced ${chalk.cyan(flag.key)} (${syncTags.length} tag(s)${variantLabel})`,
					);
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
					spinner.succeed(
						`${chalk.dim('[dry run]')} Would sync ${chalk.cyan(flag.key)} ` +
							`(${syncFilterLabel}${syncRuleLabel}${variantLabel}${tagLabel}${enableLabel})`,
					);
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
							'eppo',
							site,
						);
						const variantCounts = variantSyncResult.counts;
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
						spinner.succeed(
							`Synced ${chalk.cyan(flag.key)} (${syncedAllocCount} targeting filter(s)${syncedRuleLabel}${variantLabel}${tagLabel}${enableLabel})`,
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
	let outputData: DryRunFile | MigrationFile | undefined;

	if (dryRun) {
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
				const { confirm } = await import('@inquirer/prompts');
				exportToSheets = await confirm({
					message:
						'Would you like to export migration results to an .xlsx file?',
					default: false,
				});
			}
			if (exportToSheets) {
				const { exportMigrationToXlsx } = await import('./xlsx.js');
				await exportMigrationToXlsx(migrationData);
			}
		}
	}

	if (nonInteractive && outputData) {
		writeJsonOutput(outputData);
	}

	console.log();
	if (nonInteractive && errored > 0) process.exitCode = 1;
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
	const ctx: ProviderContext = {
		promptKit: createPromptKit(),
		datadog: { apiKey: ddApiKey, appKey: ddAppKey, site: ddSite },
		dryRun,
		nonInteractive: options?.nonInteractive
			? {
					envMap: options.nonInteractive.envMap,
					flagKeys: options.nonInteractive.flagKeys,
				}
			: undefined,
	};

	const plan = await selectEppoMigrationPlan(ctx);
	if (!plan) return;

	await executeEppoMigration({
		flags: plan.selectedFlags,
		eppoApiKey: plan.extras.eppoApiKey,
		ddApiKey,
		ddAppKey,
		envMapping: plan.envMapping,
		datadogKeys: plan.extras.datadogKeys,
		site: ddSite,
		dryRun,
		nonInteractive: !!options?.nonInteractive,
		doExport: options?.doExport ?? false,
	});
}

// Re-exported so external callers (tests, callers importing from `./eppo`) can
// continue to find these here.
export { resolveEppoEnvMap, resolveEppoFlags };
