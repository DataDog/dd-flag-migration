import chalk from 'chalk';
import { input } from '../components/Input.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import {
	createSavedFilter,
	fetchAllSavedFilters,
	fetchDatadogStatusFlagDetail,
	fetchSavedFilter,
	updateSavedFilter,
} from '../datadog/api.js';
import type { DatadogOrgPair } from '../datadog/orgs.js';
import type {
	CreateSavedFilterRequest,
	DatadogFlagEntry,
	DatadogSavedFilterMigrationMetadata,
	DatadogStatusFlagDetail,
	SavedFilterSummary,
} from '../datadog/types.js';
import { mapWithConcurrency } from '../helpers/concurrency.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { SAVED_FILTER_NAME_MAX_BYTES } from '../launchdarkly/segments.js';
import { stableJson } from '../migration-status/utils.js';

// ─── Names ────────────────────────────────────────────────────────────────────

function truncateToByteLength(value: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const codePoint of value) {
		const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
		if (bytes + codePointBytes > maxBytes) break;
		bytes += codePointBytes;
		end += codePoint.length;
	}
	return value.slice(0, end);
}

/**
 * Render the target saved filter name. Datadog saved filters are org-wide
 * (not per environment), so only the optional conflict prefix is added.
 * Returns null when the prefix alone leaves no room for the name.
 */
export function renderDatadogSavedFilterName(
	name: string,
	namePrefix?: string,
): string | null {
	const prefixPart = namePrefix ? `${namePrefix}-` : '';
	const fullName = `${prefixPart}${name}`;
	if (Buffer.byteLength(fullName, 'utf8') <= SAVED_FILTER_NAME_MAX_BYTES) {
		return fullName;
	}
	const budget =
		SAVED_FILTER_NAME_MAX_BYTES -
		Buffer.byteLength(prefixPart, 'utf8') -
		Buffer.byteLength('…', 'utf8');
	if (budget <= 0) return null;
	return `${prefixPart}${truncateToByteLength(name, budget)}…`;
}

// ─── Planning ─────────────────────────────────────────────────────────────────

export interface SavedFilterPlan {
	/** Source filters already copied to the target org (matched by metadata). */
	reused: Array<{ source: SavedFilterSummary; target: SavedFilterSummary }>;
	/** Source filters that need a new target saved filter. */
	pending: SavedFilterSummary[];
	/** Source filter IDs whose target name is already taken. */
	collisions: Set<string>;
}

function datadogMetadata(
	filter: SavedFilterSummary,
): DatadogSavedFilterMigrationMetadata | undefined {
	return filter.migration_metadata?.provider === 'datadog'
		? filter.migration_metadata
		: undefined;
}

/**
 * Match source saved filters to target saved filters. Only migration metadata
 * written by a previous Datadog-to-Datadog run counts as a match; a same-name
 * filter without that metadata is a conflict, exactly as for LaunchDarkly
 * segments, because it may be referenced by unrelated target flags.
 */
export function planSavedFilterTargets(
	sourceFilters: SavedFilterSummary[],
	targetFilters: SavedFilterSummary[],
): SavedFilterPlan {
	const targetBySourceId = new Map<string, SavedFilterSummary>();
	const targetNames = new Set<string>();
	for (const target of targetFilters) {
		targetNames.add(target.name);
		const metadata = datadogMetadata(target);
		if (metadata) targetBySourceId.set(metadata.source_id, target);
	}

	const plan: SavedFilterPlan = {
		reused: [],
		pending: [],
		collisions: new Set(),
	};
	for (const source of sourceFilters) {
		const target = targetBySourceId.get(source.id);
		if (target) {
			plan.reused.push({ source, target });
			continue;
		}
		plan.pending.push(source);
		const name = renderDatadogSavedFilterName(source.name);
		if (name !== null && targetNames.has(name)) {
			plan.collisions.add(source.id);
		}
	}
	return plan;
}

export function buildSavedFilterRequest(
	source: SavedFilterSummary,
	name: string,
	sourceSite: string,
	namePrefix?: string,
): CreateSavedFilterRequest {
	return {
		name,
		...(source.description ? { description: source.description } : {}),
		creation_type: source.creation_type ?? 'RULES',
		targeting_rules: source.targeting_rules ?? [],
		migration_metadata: {
			provider: 'datadog',
			source_id: source.id,
			source_site: sourceSite,
			...(namePrefix ? { name_prefix: namePrefix } : {}),
		},
	};
}

// ─── Adoption ─────────────────────────────────────────────────────────────────

/**
 * Find every target flag that references the given saved filters. Selected
 * flags still count: adoption happens before targeting rewrites, which may
 * later be skipped or fail (including when another saved filter cannot be
 * migrated). Draft targeting filters count too, since they may be published.
 * Returns saved filter UUID → sorted target flag keys.
 */
export function findSavedFilterUsage(
	details: Iterable<DatadogStatusFlagDetail>,
	filterIds: ReadonlySet<string>,
): Map<string, string[]> {
	const usage = new Map<string, Set<string>>();
	for (const detail of details) {
		for (const environment of detail.environments) {
			for (const allocation of environment.allocations ?? []) {
				for (const rule of allocation.targeting_rules ?? []) {
					for (const condition of rule.conditions ?? []) {
						const id = condition.saved_filter_id;
						if (!id || !filterIds.has(id)) continue;
						const keys = usage.get(id) ?? new Set();
						keys.add(detail.key);
						usage.set(id, keys);
					}
				}
			}
		}
	}
	return new Map(
		[...usage].map(([id, keys]) => [id, [...keys].sort()] as const),
	);
}

/** Order-insensitive form of a saved filter's evaluation-relevant fields. */
function canonicalSavedFilterTargeting(filter: SavedFilterSummary): string {
	const rules = (filter.targeting_rules ?? [])
		.map((rule) =>
			stableJson(
				(rule.conditions ?? [])
					.map((condition) =>
						stableJson({
							operator: condition.operator,
							attribute: condition.attribute,
							value: Array.isArray(condition.value)
								? condition.value.map((value) => String(value)).sort()
								: condition.value,
						}),
					)
					.sort(),
			),
		)
		.sort();
	return stableJson({ creation_type: filter.creation_type ?? 'RULES', rules });
}

export interface AdoptionCandidate {
	source: SavedFilterSummary;
	/** The same-name target filter, with targeting rules when it could be read. */
	target?: SavedFilterSummary;
	/** Why the target filter cannot be adopted, if it cannot. */
	blockedReason?: string;
	/** Target targeting already matches the source, so adopting changes nothing. */
	identical: boolean;
	/** All target flags that currently reference the target filter. */
	flagKeys: string[];
}

/**
 * Safe to adopt: overwriting the target filter cannot change targeting of any
 * target flag. When some target flags could not be inspected, only identical
 * filters are safe.
 */
export function isSafeAdoption(
	candidate: AdoptionCandidate,
	usageComplete: boolean,
): boolean {
	if (candidate.blockedReason !== undefined) return false;
	if (candidate.identical) return true;
	return usageComplete && candidate.flagKeys.length === 0;
}

/**
 * Pair each conflicting source filter with the target filter of the same name
 * and decide whether it can be adopted. Only an unambiguous, unmanaged target
 * filter can be adopted: a filter carrying migration metadata belongs to
 * another migration (LaunchDarkly, Eppo, or a different source filter), and
 * rewriting that metadata would break its re-migrations.
 */
export function planSavedFilterAdoptions(
	sources: SavedFilterSummary[],
	targetFilters: SavedFilterSummary[],
	usage: ReadonlyMap<string, string[]>,
): AdoptionCandidate[] {
	const targetsByName = new Map<string, SavedFilterSummary[]>();
	for (const target of targetFilters) {
		const matches = targetsByName.get(target.name) ?? [];
		matches.push(target);
		targetsByName.set(target.name, matches);
	}
	const claimed = new Set<string>();
	return sources.map((source) => {
		const name = renderDatadogSavedFilterName(source.name);
		const matches = name === null ? [] : (targetsByName.get(name) ?? []);
		const blocked = (
			reason: string,
			target?: SavedFilterSummary,
		): AdoptionCandidate => ({
			source,
			...(target ? { target } : {}),
			blockedReason: reason,
			identical: false,
			flagKeys: target ? (usage.get(target.id) ?? []) : [],
		});
		if (matches.length !== 1) {
			return blocked(
				matches.length === 0
					? 'no target saved filter with this name'
					: `${matches.length} target saved filters share this name`,
			);
		}
		const [target] = matches;
		if (target.migration_metadata) {
			return blocked(
				`managed by a ${target.migration_metadata.provider} migration`,
				target,
			);
		}
		if (claimed.has(target.id)) {
			return blocked('already adopted by another source saved filter', target);
		}
		if (target.targeting_rules === undefined) {
			return blocked('targeting could not be read', target);
		}
		claimed.add(target.id);
		return {
			source,
			target,
			identical:
				canonicalSavedFilterTargeting(source) ===
				canonicalSavedFilterTargeting(target),
			flagKeys: usage.get(target.id) ?? [],
		};
	});
}

// ─── Migration ────────────────────────────────────────────────────────────────

export interface DatadogSavedFilterMigrationStats {
	discovered: number;
	created: number;
	updated: number;
	reused: number;
	/** Same-name target filters taken over by this migration. */
	adopted: number;
	skipped: number;
	failures: Array<{ savedFilterId: string; name: string; error: string }>;
}

export interface DatadogSavedFilterMigrationResult {
	/** Source saved filter UUID → target saved filter UUID. */
	savedFilterIdMap: Map<string, string>;
	stats: DatadogSavedFilterMigrationStats;
	dryRunRequests: Array<{ method: string; path: string; body: unknown }>;
}

const USAGE_CHECK_CONCURRENCY = 2;
const USAGE_PREVIEW_LIMIT = 5;

type ConflictFallback =
	| { action: 'skip' }
	| { action: 'prefix'; prefix: string };

interface ConflictResolution {
	/** Source saved filter UUID → same-name target filter to take over. */
	adopt: Map<string, SavedFilterSummary>;
	/** Applied to every conflict that is not adopted. */
	fallback: ConflictFallback;
}

/** What the adopt option needs to check target flag usage. */
export interface SavedFilterAdoptionContext {
	targetFlags: DatadogFlagEntry[];
}

async function promptForConflictAction(
	count: number,
	canAdopt: boolean,
): Promise<'skip' | 'prefix' | 'adopt'> {
	console.log();
	console.log(
		chalk.yellow(
			`  ${count} saved filter name(s) would conflict with existing filters in the target org`,
		),
	);
	console.log();
	return select<'skip' | 'prefix' | 'adopt'>({
		message: 'How would you like to handle these conflicts?',
		choices: [
			{ name: 'Skip conflicting saved filters', value: 'skip' },
			{
				name: 'Add a prefix to conflicting saved filter names',
				value: 'prefix',
			},
			...(canAdopt
				? [
						{
							name: 'Adopt the existing saved filters (overwrite their targeting after a usage check)',
							value: 'adopt' as const,
						},
					]
				: []),
		],
	});
}

async function promptForPrefix(): Promise<string> {
	const prefix = await input({
		message: 'Enter a prefix for conflicting saved filter names:',
		validate: (value) => {
			const trimmed = value.trim();
			if (trimmed.length === 0) return 'Prefix cannot be empty';
			if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed))
				return 'Prefix must contain only lowercase letters, numbers, and hyphens';
			return true;
		},
	});
	return prefix.trim();
}

/**
 * Read the same-name target filters' targeting and every target flag's
 * targeting, then plan which conflicts can be adopted.
 */
async function assessAdoptions(
	pair: DatadogOrgPair,
	conflicts: SavedFilterSummary[],
	targetFilters: SavedFilterSummary[],
	adoption: SavedFilterAdoptionContext,
): Promise<{ candidates: AdoptionCandidate[]; usageComplete: boolean }> {
	const { target } = pair;
	const { targetFlags } = adoption;
	const label = `Checking ${targetFlags.length} target flag(s) for saved filter usage…`;
	const spinner = createSpinner(label).start();

	const names = new Set(
		conflicts.map((source) => renderDatadogSavedFilterName(source.name)),
	);
	const sameName = targetFilters.filter((filter) => names.has(filter.name));
	const withRules = new Map<string, SavedFilterSummary>();
	await mapWithConcurrency(
		sameName,
		USAGE_CHECK_CONCURRENCY,
		async (filter) => {
			try {
				withRules.set(
					filter.id,
					await fetchSavedFilter(
						target.apiKey,
						target.appKey,
						filter.id,
						target.site,
					),
				);
			} catch {
				// Leave targeting unknown so the filter is reported as not adoptable.
				withRules.set(filter.id, {
					id: filter.id,
					name: filter.name,
					migration_metadata: filter.migration_metadata,
				});
			}
		},
	);

	const details: DatadogStatusFlagDetail[] = [];
	let failed = 0;
	let completed = 0;
	await mapWithConcurrency(
		targetFlags,
		USAGE_CHECK_CONCURRENCY,
		async (flag) => {
			try {
				details.push(
					await fetchDatadogStatusFlagDetail(
						target.apiKey,
						target.appKey,
						flag.id,
						target.site,
					),
				);
			} catch {
				failed++;
			}
			completed++;
			spinner.text = `${label} (${completed}/${targetFlags.length})`;
		},
	);
	if (failed > 0) {
		spinner.warn(
			`Checked ${details.length} target flag(s); ${failed} could not be loaded`,
		);
	} else {
		spinner.succeed(`Checked ${details.length} target flag(s)`);
	}

	const usage = findSavedFilterUsage(
		details,
		new Set(sameName.map((filter) => filter.id)),
	);
	const candidates = planSavedFilterAdoptions(
		conflicts,
		targetFilters.map((filter) => withRules.get(filter.id) ?? filter),
		usage,
	);
	return { candidates, usageComplete: failed === 0 };
}

function printAdoptionReport(
	candidates: AdoptionCandidate[],
	usageComplete: boolean,
): void {
	console.log();
	if (!usageComplete) {
		console.log(
			chalk.yellow(
				'  Some target flags could not be checked, so only saved filters whose targeting already matches count as safe',
			),
		);
	}
	for (const candidate of candidates) {
		const name = candidate.source.name;
		const { flagKeys } = candidate;
		if (candidate.blockedReason !== undefined) {
			console.log(
				chalk.gray(`  – ${name}: cannot adopt (${candidate.blockedReason})`),
			);
		} else if (candidate.identical) {
			console.log(
				chalk.green(`  ✓ ${name}: targeting already matches the source`),
			);
		} else if (isSafeAdoption(candidate, usageComplete)) {
			console.log(chalk.green(`  ✓ ${name}: not used by any target flags`));
		} else if (flagKeys.length === 0) {
			console.log(
				chalk.yellow(
					`  ⚠ ${name}: targeting differs; usage could not be fully checked`,
				),
			);
		} else {
			const preview = flagKeys.slice(0, USAGE_PREVIEW_LIMIT).join(', ');
			const more =
				flagKeys.length > USAGE_PREVIEW_LIMIT
					? `, +${flagKeys.length - USAGE_PREVIEW_LIMIT} more`
					: '';
			console.log(
				chalk.yellow(
					`  ⚠ ${name}: targeting differs and ${flagKeys.length} target flag(s) use it: ${preview}${more}`,
				),
			);
		}
	}
	console.log();
}

async function resolveConflicts(
	pair: DatadogOrgPair,
	conflicts: SavedFilterSummary[],
	targetFilters: SavedFilterSummary[],
	adoption: SavedFilterAdoptionContext | undefined,
): Promise<ConflictResolution> {
	const action = await promptForConflictAction(
		conflicts.length,
		adoption !== undefined,
	);
	if (action === 'prefix') {
		return {
			adopt: new Map(),
			fallback: { action: 'prefix', prefix: await promptForPrefix() },
		};
	}
	if (action === 'skip' || adoption === undefined) {
		return { adopt: new Map(), fallback: { action: 'skip' } };
	}

	const { candidates, usageComplete } = await assessAdoptions(
		pair,
		conflicts,
		targetFilters,
		adoption,
	);
	printAdoptionReport(candidates, usageComplete);
	const adoptable = candidates.filter(
		(candidate) => candidate.blockedReason === undefined,
	);
	const safe = adoptable.filter((candidate) =>
		isSafeAdoption(candidate, usageComplete),
	);
	const risky = adoptable.length - safe.length;
	const blocked = candidates.length - adoptable.length;
	const rest = candidates.length - safe.length;

	let chosen = safe;
	let fallback: ConflictFallback = { action: 'skip' };
	if (rest > 0) {
		const choice = await select<'all' | 'safe-skip' | 'safe-prefix'>({
			message: 'Which saved filters should be adopted?',
			choices: [
				...(risky > 0
					? [
							{
								name: `Adopt all ${adoptable.length}, including ${risky} that may change target flag evaluations${blocked > 0 ? ` (skip ${blocked} that cannot be adopted)` : ''}`,
								value: 'all' as const,
							},
						]
					: []),
				{
					name: `Adopt the ${safe.length} safe filter(s) and skip the other ${rest}`,
					value: 'safe-skip',
				},
				{
					name: `Adopt the ${safe.length} safe filter(s) and add a prefix to the other ${rest}`,
					value: 'safe-prefix',
				},
			],
		});
		if (choice === 'all') chosen = adoptable;
		if (choice === 'safe-prefix') {
			fallback = { action: 'prefix', prefix: await promptForPrefix() };
		}
	}
	return {
		adopt: new Map(
			chosen.flatMap((candidate) =>
				candidate.target
					? [[candidate.source.id, candidate.target] as const]
					: [],
			),
		),
		fallback,
	};
}

function dryRunPut(
	id: string,
	request: CreateSavedFilterRequest,
): DatadogSavedFilterMigrationResult['dryRunRequests'][number] {
	return {
		method: 'PUT',
		path: `/api/v2/feature-flags/saved-filters/${id}`,
		body: { data: { type: 'saved-filters', id, attributes: request } },
	};
}

async function fetchReferencedSourceFilters(
	pair: DatadogOrgPair,
	refs: string[],
	stats: DatadogSavedFilterMigrationStats,
): Promise<SavedFilterSummary[]> {
	const { source } = pair;
	const needed = new Set(refs);
	const listed = await fetchAllSavedFilters(
		source.apiKey,
		source.appKey,
		{ include_rules: true },
		source.site,
	);
	const found = new Map(
		listed
			.filter((filter) => needed.has(filter.id))
			.map((filter) => [filter.id, filter]),
	);
	// Archived filters are not listed but can still be referenced.
	for (const id of needed) {
		if (found.has(id)) continue;
		try {
			found.set(
				id,
				await fetchSavedFilter(source.apiKey, source.appKey, id, source.site),
			);
		} catch (error) {
			stats.skipped++;
			stats.failures.push({
				savedFilterId: id,
				name: id,
				error: formatAxiosError(error),
			});
		}
	}
	return refs.flatMap((id) => {
		const filter = found.get(id);
		return filter ? [filter] : [];
	});
}

/**
 * Phase 1 of a Datadog-to-Datadog migration: copy the saved filters that the
 * selected flags reference into the target org. Mirrors the LaunchDarkly
 * segment flow — previously copied filters are PUT-replaced so source edits
 * propagate (Tier 2: filters outside this selection are untouched and nothing
 * is deleted), new filters are created with `migration_metadata`, and name
 * conflicts are skipped, prefixed, or adopted. Adopting takes over the
 * same-name target filter: it is PUT-replaced with the source targeting and
 * metadata, after a usage check of every target flag. Adoption is offered only
 * interactively and only when `adoption` is provided.
 *
 * Dry runs read both orgs but never write; planned requests are returned and
 * new filters get placeholder IDs so flag requests still show the reference.
 */
export async function migrateDatadogSavedFilters(params: {
	pair: DatadogOrgPair;
	refs: string[];
	dryRun: boolean;
	nonInteractive?: boolean;
	adoption?: SavedFilterAdoptionContext;
}): Promise<DatadogSavedFilterMigrationResult> {
	const { pair, refs, dryRun, nonInteractive = false, adoption } = params;
	const { target } = pair;
	const savedFilterIdMap = new Map<string, string>();
	const dryRunRequests: DatadogSavedFilterMigrationResult['dryRunRequests'] =
		[];
	const stats: DatadogSavedFilterMigrationStats = {
		discovered: refs.length,
		created: 0,
		updated: 0,
		reused: 0,
		adopted: 0,
		skipped: 0,
		failures: [],
	};
	if (refs.length === 0) return { savedFilterIdMap, stats, dryRunRequests };

	const loadSpinner = createSpinner(
		`Loading ${refs.length} referenced saved filter(s)…`,
	).start();
	let sourceFilters: SavedFilterSummary[];
	let targetFilters: SavedFilterSummary[];
	try {
		[sourceFilters, targetFilters] = await Promise.all([
			fetchReferencedSourceFilters(pair, refs, stats),
			fetchAllSavedFilters(target.apiKey, target.appKey, {}, target.site),
		]);
		loadSpinner.succeed(
			`Loaded ${sourceFilters.length} source saved filter(s) and ${targetFilters.length} target saved filter(s)`,
		);
	} catch (error) {
		loadSpinner.fail('Failed to load saved filters');
		throw error;
	}

	const plan = planSavedFilterTargets(sourceFilters, targetFilters);
	let resolution: ConflictResolution = {
		adopt: new Map(),
		fallback: { action: 'skip' },
	};
	if (plan.collisions.size > 0) {
		if (nonInteractive) {
			console.log(
				chalk.yellow(
					`  ${plan.collisions.size} saved filter name(s) conflict with existing filters in the target org and will be skipped`,
				),
			);
		} else {
			resolution = await resolveConflicts(
				pair,
				plan.pending.filter((source) => plan.collisions.has(source.id)),
				targetFilters,
				adoption,
			);
		}
	}

	const writeSpinner = createSpinner(
		dryRun ? 'Planning saved filters…' : 'Migrating saved filters…',
	).start();
	const usedNames = new Set(targetFilters.map((filter) => filter.name));
	let placeholderIndex = 0;

	for (const source of plan.pending) {
		let namePrefix: string | undefined;
		const adoptTarget = resolution.adopt.get(source.id);
		if (adoptTarget) {
			if ((source.targeting_rules ?? []).length === 0) {
				writeSpinner.warn(
					`Skipped saved filter "${source.name}" — no targeting rules`,
				);
				stats.skipped++;
				continue;
			}
			const request = buildSavedFilterRequest(
				source,
				adoptTarget.name,
				pair.source.site,
			);
			if (dryRun) {
				dryRunRequests.push(dryRunPut(adoptTarget.id, request));
				savedFilterIdMap.set(source.id, adoptTarget.id);
				stats.adopted++;
				continue;
			}
			try {
				await updateSavedFilter(
					target.apiKey,
					target.appKey,
					adoptTarget.id,
					request,
					target.site,
				);
				savedFilterIdMap.set(source.id, adoptTarget.id);
				stats.adopted++;
			} catch (error) {
				const message = formatAxiosError(error);
				writeSpinner.warn(
					`Failed to adopt saved filter "${source.name}": ${message}`,
				);
				stats.failures.push({
					savedFilterId: source.id,
					name: source.name,
					error: message,
				});
			}
			continue;
		}
		if (plan.collisions.has(source.id)) {
			if (resolution.fallback.action === 'skip') {
				writeSpinner.warn(
					`Skipped saved filter "${source.name}" — name conflict in the target org`,
				);
				stats.skipped++;
				continue;
			}
			namePrefix = resolution.fallback.prefix;
		}
		const name = renderDatadogSavedFilterName(source.name, namePrefix);
		if (name === null || usedNames.has(name)) {
			writeSpinner.warn(
				`Skipped saved filter "${source.name}" — no available name in the target org`,
			);
			stats.skipped++;
			continue;
		}
		if ((source.targeting_rules ?? []).length === 0) {
			writeSpinner.warn(
				`Skipped saved filter "${source.name}" — no targeting rules`,
			);
			stats.skipped++;
			continue;
		}
		const request = buildSavedFilterRequest(
			source,
			name,
			pair.source.site,
			namePrefix,
		);
		if (dryRun) {
			dryRunRequests.push({
				method: 'POST',
				path: '/api/v2/feature-flags/saved-filters',
				body: { data: { type: 'saved-filters', attributes: request } },
			});
			savedFilterIdMap.set(
				source.id,
				`dry-run-saved-filter-${placeholderIndex++}`,
			);
			usedNames.add(name);
			stats.created++;
			continue;
		}
		try {
			const { id } = await createSavedFilter(
				target.apiKey,
				target.appKey,
				request,
				target.site,
			);
			savedFilterIdMap.set(source.id, id);
			usedNames.add(name);
			stats.created++;
		} catch (error) {
			const message = formatAxiosError(error);
			writeSpinner.warn(
				`Failed to create saved filter "${source.name}": ${message}`,
			);
			stats.failures.push({
				savedFilterId: source.id,
				name: source.name,
				error: message,
			});
		}
	}

	for (const { source, target: existing } of plan.reused) {
		stats.reused++;
		const namePrefix = datadogMetadata(existing)?.name_prefix;
		const name = renderDatadogSavedFilterName(source.name, namePrefix);
		if (name === null || (source.targeting_rules ?? []).length === 0) {
			stats.skipped++;
			continue;
		}
		const request = buildSavedFilterRequest(
			source,
			name,
			pair.source.site,
			namePrefix,
		);
		if (dryRun) {
			dryRunRequests.push(dryRunPut(existing.id, request));
			savedFilterIdMap.set(source.id, existing.id);
			stats.updated++;
			continue;
		}
		try {
			await updateSavedFilter(
				target.apiKey,
				target.appKey,
				existing.id,
				request,
				target.site,
			);
			// Only expose filters whose source targeting was successfully copied.
			// Otherwise dependent flags would be migrated using stale targeting.
			savedFilterIdMap.set(source.id, existing.id);
			stats.updated++;
		} catch (error) {
			const message = formatAxiosError(error);
			writeSpinner.warn(
				`Failed to update saved filter "${source.name}": ${message}`,
			);
			stats.failures.push({
				savedFilterId: source.id,
				name: source.name,
				error: message,
			});
		}
	}

	const createdVerb = dryRun ? 'Would create' : 'Created';
	const updatedVerb = dryRun ? 'would update' : 'updated';
	const adoptedLabel =
		stats.adopted > 0
			? `, ${stats.adopted} ${dryRun ? 'would adopt' : 'adopted'}`
			: '';
	writeSpinner.succeed(
		`${createdVerb} ${stats.created} saved filter(s) (${stats.reused} reused, ${stats.updated} ${updatedVerb}${adoptedLabel}, ${stats.skipped} skipped)`,
	);
	return { savedFilterIdMap, stats, dryRunRequests };
}
