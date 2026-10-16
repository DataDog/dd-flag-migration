import chalk from 'chalk';
import { input } from '../components/Input.js';
import { select } from '../components/Select.js';
import { spinner as createSpinner } from '../components/Spinner.js';
import {
	createSavedFilter,
	fetchAllSavedFilters,
	fetchSavedFilter,
	updateSavedFilter,
} from '../datadog/api.js';
import type { DatadogOrgPair } from '../datadog/orgs.js';
import type {
	CreateSavedFilterRequest,
	DatadogSavedFilterMigrationMetadata,
	SavedFilterSummary,
} from '../datadog/types.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import { SAVED_FILTER_NAME_MAX_BYTES } from '../launchdarkly/segments.js';

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

// ─── Migration ────────────────────────────────────────────────────────────────

export interface DatadogSavedFilterMigrationStats {
	discovered: number;
	created: number;
	updated: number;
	reused: number;
	skipped: number;
	failures: Array<{ savedFilterId: string; name: string; error: string }>;
}

export interface DatadogSavedFilterMigrationResult {
	/** Source saved filter UUID → target saved filter UUID. */
	savedFilterIdMap: Map<string, string>;
	stats: DatadogSavedFilterMigrationStats;
	dryRunRequests: Array<{ method: string; path: string; body: unknown }>;
}

type ConflictResolution =
	| { action: 'skip' }
	| { action: 'prefix'; prefix: string };

async function promptForConflictResolution(
	count: number,
): Promise<ConflictResolution> {
	console.log();
	console.log(
		chalk.yellow(
			`  ${count} saved filter name(s) would conflict with existing filters in the target org`,
		),
	);
	console.log();
	const action = await select<'skip' | 'prefix'>({
		message: 'How would you like to handle these conflicts?',
		choices: [
			{ name: 'Skip conflicting saved filters', value: 'skip' },
			{
				name: 'Add a prefix to conflicting saved filter names',
				value: 'prefix',
			},
		],
	});
	if (action === 'skip') return { action };
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
	return { action: 'prefix', prefix: prefix.trim() };
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
 * conflicts are skipped or prefixed.
 *
 * Dry runs read both orgs but never write; planned requests are returned and
 * new filters get placeholder IDs so flag requests still show the reference.
 */
export async function migrateDatadogSavedFilters(params: {
	pair: DatadogOrgPair;
	refs: string[];
	dryRun: boolean;
	nonInteractive?: boolean;
}): Promise<DatadogSavedFilterMigrationResult> {
	const { pair, refs, dryRun, nonInteractive = false } = params;
	const { target } = pair;
	const savedFilterIdMap = new Map<string, string>();
	const dryRunRequests: DatadogSavedFilterMigrationResult['dryRunRequests'] =
		[];
	const stats: DatadogSavedFilterMigrationStats = {
		discovered: refs.length,
		created: 0,
		updated: 0,
		reused: 0,
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
	let resolution: ConflictResolution = { action: 'skip' };
	if (plan.collisions.size > 0) {
		if (nonInteractive) {
			console.log(
				chalk.yellow(
					`  ${plan.collisions.size} saved filter name(s) conflict with existing filters in the target org and will be skipped`,
				),
			);
		} else {
			resolution = await promptForConflictResolution(plan.collisions.size);
		}
	}

	const writeSpinner = createSpinner(
		dryRun ? 'Planning saved filters…' : 'Migrating saved filters…',
	).start();
	const usedNames = new Set(targetFilters.map((filter) => filter.name));
	let placeholderIndex = 0;

	for (const source of plan.pending) {
		let namePrefix: string | undefined;
		if (plan.collisions.has(source.id)) {
			if (resolution.action === 'skip') {
				writeSpinner.warn(
					`Skipped saved filter "${source.name}" — name conflict in the target org`,
				);
				stats.skipped++;
				continue;
			}
			namePrefix = resolution.prefix;
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
		savedFilterIdMap.set(source.id, existing.id);
		stats.reused++;
		const namePrefix = datadogMetadata(existing)?.name_prefix;
		const name = renderDatadogSavedFilterName(source.name, namePrefix);
		if (name === null || (source.targeting_rules ?? []).length === 0) continue;
		const request = buildSavedFilterRequest(
			source,
			name,
			pair.source.site,
			namePrefix,
		);
		if (dryRun) {
			dryRunRequests.push({
				method: 'PUT',
				path: `/api/v2/feature-flags/saved-filters/${existing.id}`,
				body: {
					data: { type: 'saved-filters', id: existing.id, attributes: request },
				},
			});
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
	writeSpinner.succeed(
		`${createdVerb} ${stats.created} saved filter(s) (${stats.reused} reused, ${stats.updated} ${updatedVerb}, ${stats.skipped} skipped)`,
	);
	return { savedFilterIdMap, stats, dryRunRequests };
}
