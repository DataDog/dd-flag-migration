import { input, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import { createSavedFilter, listSavedFilters } from '../datadog.js';
import { createSpinner } from '../spinner.js';
import type {
	DatadogCondition,
	DatadogEnvironment,
	DatadogTargetingRule,
	LDSavedFilterMigrationMetadata,
	SavedFilterSummary,
} from '../types.js';
import { fetchSegment, fetchSegments } from './api.js';
import { mapOperator } from './migration.js';
import { negateTargetingRules } from './negation.js';
import type { LDFlag, LDSegment } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const SAVED_FILTER_NAME_MAX_BYTES = 200;

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface SegmentRef {
	segmentKey: string;
	envKey: string;
	negated: boolean;
}

/**
 * Scan user-selected flags for segmentMatch clauses and return unique
 * (segmentKey, envKey, negated) tuples. Only considers the provided envKeys.
 */
export function discoverSegmentRefs(
	flags: LDFlag[],
	envKeys: string[],
): SegmentRef[] {
	const seen = new Set<string>();
	const refs: SegmentRef[] = [];

	for (const flag of flags) {
		for (const envKey of envKeys) {
			const envConfig = flag.environments?.[envKey];
			if (!envConfig) continue;

			for (const rule of envConfig.rules) {
				if (rule.disabled) continue;
				for (const clause of rule.clauses) {
					if (clause.op !== 'segmentMatch') continue;
					for (const segmentKey of clause.values as string[]) {
						const negated = clause.negate;
						const key = `${segmentKey}:${envKey}:${negated}`;
						if (!seen.has(key)) {
							seen.add(key);
							refs.push({ segmentKey, envKey, negated });
						}
					}
				}
			}
		}
	}

	return refs;
}

// ─── Creation Type ────────────────────────────────────────────────────────────

/**
 * Determine whether the saved filter should be created as LIST or RULES.
 * LIST only for pure key-in segments (single rule, single clause, op:in,
 * attribute:key) with no excluded or included lists.
 */
export function getCreationType(segment: LDSegment): 'RULES' | 'LIST' {
	if (
		segment.excluded.length === 0 &&
		segment.included.length === 0 &&
		segment.rules.length === 1 &&
		segment.rules[0].clauses.length === 1 &&
		segment.rules[0].clauses[0].op === 'in' &&
		segment.rules[0].clauses[0].attribute === 'key'
	) {
		return 'LIST';
	}
	return 'RULES';
}

// ─── Name Rendering ───────────────────────────────────────────────────────────

/** Truncate a string to at most maxBytes UTF-8 bytes at a codepoint boundary. */
function truncateToByteLength(str: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const codePoint of str) {
		const cpBytes = Buffer.byteLength(codePoint, 'utf8');
		if (bytes + cpBytes > maxBytes) break;
		bytes += cpBytes;
		end += codePoint.length;
	}
	return str.slice(0, end);
}

/**
 * Render the saved filter name for a segment+env+negated combination.
 * Truncates the segment name if the full name would exceed 200 UTF-8 bytes.
 * Returns null if the envelope (prefixes + env suffix) alone exceeds 200 bytes.
 */
export function renderSavedFilterName(
	segmentName: string,
	envKey: string,
	negated: boolean,
	namePrefix?: string,
): string | null {
	const notPart = negated ? 'NOT ' : '';
	const prefixPart = namePrefix ? `${namePrefix}-` : '';
	const suffixPart = ` (${envKey})`;

	const fullName = `${notPart}${prefixPart}${segmentName}${suffixPart}`;
	if (Buffer.byteLength(fullName, 'utf8') <= SAVED_FILTER_NAME_MAX_BYTES) {
		return fullName;
	}

	const envelopeBytes =
		Buffer.byteLength(notPart, 'utf8') +
		Buffer.byteLength(prefixPart, 'utf8') +
		Buffer.byteLength('…', 'utf8') +
		Buffer.byteLength(suffixPart, 'utf8');

	const budget = SAVED_FILTER_NAME_MAX_BYTES - envelopeBytes;
	if (budget <= 0) return null;

	const truncated = truncateToByteLength(segmentName, budget);
	return `${notPart}${prefixPart}${truncated}…${suffixPart}`;
}

// ─── Rule Building ────────────────────────────────────────────────────────────

/**
 * Map one LD segment to DD targeting rules for the non-negated saved filter.
 * Formula: (rules ∨ included) ∧ ¬excluded
 * Returns null if the segment uses unsupported features.
 */
export function buildNonNegatedRules(
	segment: LDSegment,
): DatadogTargetingRule[] | null {
	if (
		segment.includedContexts.length > 0 ||
		segment.excludedContexts.length > 0
	) {
		return null; // multi-context unsupported
	}

	// Check for nested segmentMatch in segment rules
	for (const rule of segment.rules) {
		for (const clause of rule.clauses) {
			if (clause.op === 'segmentMatch') return null;
		}
	}

	const groups: DatadogTargetingRule[] = [];

	// Rule groups
	for (const rule of segment.rules) {
		const conditions: DatadogCondition[] = [];
		for (const clause of rule.clauses) {
			const mapped = mapOperator(clause.op, clause.negate, clause.values);
			if ('skip' in mapped) return null;
			conditions.push({
				operator: mapped.operator,
				attribute: clause.attribute,
				value: mapped.values,
			});
		}
		groups.push({ conditions });
	}

	// Included group
	if (segment.included.length > 0) {
		groups.push({
			conditions: [
				{ operator: 'ONE_OF', attribute: 'key', value: segment.included },
			],
		});
	}

	// AND excluded into every group
	if (segment.excluded.length > 0) {
		const excludeCondition: DatadogCondition = {
			operator: 'NOT_ONE_OF',
			attribute: 'key',
			value: [...segment.excluded],
		};
		for (const group of groups) {
			group.conditions.push(excludeCondition);
		}
	}

	return groups;
}

/**
 * Build targeting rules for the negated saved filter from scratch.
 * Formula: (¬rules ∧ ¬included) ∨ excluded
 * Does NOT pipe the non-negated filter through negateTargetingRules.
 * Returns null if unsupported or explosion guard fires.
 */
export function buildNegatedRules(
	segment: LDSegment,
): DatadogTargetingRule[] | null {
	if (
		segment.includedContexts.length > 0 ||
		segment.excludedContexts.length > 0
	) {
		return null;
	}

	for (const rule of segment.rules) {
		for (const clause of rule.clauses) {
			if (clause.op === 'segmentMatch') return null;
		}
	}

	let negatedRulesGroups: DatadogTargetingRule[];

	if (segment.rules.length > 0) {
		// Map segment rules to DD targeting rules
		const ruleGroups: DatadogTargetingRule[] = [];
		for (const rule of segment.rules) {
			const conditions: DatadogCondition[] = [];
			for (const clause of rule.clauses) {
				const mapped = mapOperator(clause.op, clause.negate, clause.values);
				if ('skip' in mapped) return null;
				conditions.push({
					operator: mapped.operator,
					attribute: clause.attribute,
					value: mapped.values,
				});
			}
			ruleGroups.push({ conditions });
		}

		const negated = negateTargetingRules(ruleGroups);
		if (negated === null) return null; // explosion or unsupported operator
		negatedRulesGroups = negated;
	} else {
		// Empty rules → ¬rules = tautology (single group with zero conditions)
		negatedRulesGroups = [{ conditions: [] }];
	}

	// AND key NOT_ONE_OF included into every ¬rules group
	if (segment.included.length > 0) {
		const notIncluded: DatadogCondition = {
			operator: 'NOT_ONE_OF',
			attribute: 'key',
			value: [...segment.included],
		};
		for (const group of negatedRulesGroups) {
			group.conditions.push(notIncluded);
		}
	}

	// OR group: key ONE_OF excluded
	if (segment.excluded.length > 0) {
		negatedRulesGroups.push({
			conditions: [
				{ operator: 'ONE_OF', attribute: 'key', value: segment.excluded },
			],
		});
	}

	return negatedRulesGroups;
}

// ─── migrateSegments ──────────────────────────────────────────────────────────

export interface SegmentMigrationStats {
	discovered: number;
	created: number;
	negated: number;
	skipped: number;
	reused: number;
	failures: Array<{ segmentKey: string; envKey: string; error: string }>;
}

export interface SegmentMigrationResult {
	/** "segKey:envKey:negated" → savedFilterId */
	savedFilterLookup: Map<string, string>;
	/** "segKey:envKey:negated" → constant segmentMatch result */
	segmentConstantLookup: Map<string, boolean>;
	stats: SegmentMigrationStats;
}

function isMatchNoneSegment(segment: LDSegment): boolean {
	return (
		segment.rules.length === 0 &&
		segment.included.length === 0 &&
		segment.includedContexts.length === 0
	);
}

function createSegmentMigrationStats(): SegmentMigrationStats {
	return {
		discovered: 0,
		created: 0,
		negated: 0,
		skipped: 0,
		reused: 0,
		failures: [],
	};
}

function segmentLookupKey(ref: SegmentRef): string {
	return `${ref.segmentKey}:${ref.envKey}:${ref.negated}`;
}

function discoveredSegmentCount(refs: SegmentRef[]): number {
	return new Set(refs.map((r) => `${r.segmentKey}:${r.envKey}`)).size;
}

function groupSegmentRefsByEnv(refs: SegmentRef[]): Map<string, Set<string>> {
	const neededByEnv = new Map<string, Set<string>>();
	for (const ref of refs) {
		if (!neededByEnv.has(ref.envKey)) neededByEnv.set(ref.envKey, new Set());
		neededByEnv.get(ref.envKey)?.add(ref.segmentKey);
	}
	return neededByEnv;
}

async function fetchReferencedSegments(
	ldApiKey: string,
	projectKey: string,
	refs: SegmentRef[],
	stats: SegmentMigrationStats,
): Promise<Map<string, Map<string, LDSegment>>> {
	const neededByEnv = groupSegmentRefsByEnv(refs);
	const fetchSpinner = createSpinner(
		'Fetching segments from LaunchDarkly…',
	).start();
	const segmentsByKey = new Map<string, Map<string, LDSegment>>();

	try {
		for (const [envKey, neededKeys] of neededByEnv) {
			const envSegments = new Map<string, LDSegment>();
			segmentsByKey.set(envKey, envSegments);

			const allSegments = await fetchSegments(ldApiKey, projectKey, envKey);
			for (const seg of allSegments) {
				if (neededKeys.has(seg.key)) {
					envSegments.set(seg.key, seg);
				}
			}

			// Fallback: fetch any still-missing segments individually
			for (const key of neededKeys) {
				if (!envSegments.has(key)) {
					const seg = await fetchSegment(ldApiKey, projectKey, envKey, key);
					if (seg) {
						envSegments.set(key, seg);
					} else {
						fetchSpinner.warn(
							`Segment "${key}" not found in env "${envKey}" — dependent flag rules will be skipped`,
						);
						stats.skipped++;
					}
				}
			}
		}
		fetchSpinner.succeed('Fetched segments from LaunchDarkly');
		return segmentsByKey;
	} catch (err) {
		fetchSpinner.fail('Failed to fetch segments from LaunchDarkly');
		throw err;
	}
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
	const body = data ? JSON.stringify(data).slice(0, 300) : 'no body';
	return `${method} ${url} — ${status ?? 'no status'}: ${body}`;
}

/**
 * Phase 1: Migrate LaunchDarkly segments as Datadog saved filters.
 * Discovers segments referenced by selectedFlags, fetches them from LD,
 * checks for existing DD saved filters (idempotency), handles cross-project
 * name conflicts, and creates saved filters for new segments.
 *
 * Returns a lookup map keyed by "segKey:envKey:negated" → savedFilterId.
 */
export async function migrateSegments(params: {
	ldApiKey: string;
	projectKey: string;
	selectedFlags: LDFlag[];
	envMapping: Map<string, DatadogEnvironment>;
	ddApiKey: string;
	ddAppKey: string;
	ddSite: string;
}): Promise<SegmentMigrationResult> {
	const {
		ldApiKey,
		projectKey,
		selectedFlags,
		envMapping,
		ddApiKey,
		ddAppKey,
		ddSite,
	} = params;
	const savedFilterLookup = new Map<string, string>();
	const segmentConstantLookup = new Map<string, boolean>();
	const stats = createSegmentMigrationStats();

	const envKeys = [...envMapping.keys()];

	// ── Step 1: Discover needed segments ──────────────────────────────────────
	const discoverSpinner = createSpinner(
		'Discovering segments referenced by flags…',
	).start();
	const refs = discoverSegmentRefs(selectedFlags, envKeys);
	stats.discovered = discoveredSegmentCount(refs);
	discoverSpinner.succeed(
		`Found ${stats.discovered} segment(s) across ${envKeys.length} environment(s)`,
	);

	if (refs.length === 0) {
		return { savedFilterLookup, segmentConstantLookup, stats };
	}

	// ── Step 2: Fetch segments from LD ────────────────────────────────────────
	const segmentsByKey = await fetchReferencedSegments(
		ldApiKey,
		projectKey,
		refs,
		stats,
	);

	// ── Step 3: List existing DD saved filters for idempotency ────────────────
	const idempotencySpinner = createSpinner(
		'Checking for already-migrated saved filters…',
	).start();
	const existingFilters: SavedFilterSummary[] = [];
	let offset = 0;
	while (true) {
		const page = await listSavedFilters(ddApiKey, ddAppKey, { offset }, ddSite);
		existingFilters.push(...page.data);
		if (existingFilters.length >= page.total || page.data.length === 0) break;
		offset += page.data.length;
	}

	// Index by tuple → savedFilterId (for idempotency) and by name (for collision detection)
	const existingByTuple = new Map<string, string>();
	const existingByName = new Map<string, SavedFilterSummary>();
	for (const sf of existingFilters) {
		existingByName.set(sf.name, sf);
		if (sf.migration_metadata?.provider === 'launchdarkly') {
			const m = sf.migration_metadata;
			const tupleKey = `launchdarkly:${m.project_key}:${m.segment_key}:${m.environment_key}:${m.negated}`;
			existingByTuple.set(tupleKey, sf.id);
		}
	}
	idempotencySpinner.succeed(
		`Loaded ${existingFilters.length} existing saved filter(s)`,
	);

	// ── Step 3b: Idempotency pre-pass — mark already-migrated refs ──────────
	interface PendingFilter {
		ref: SegmentRef;
		segment: LDSegment;
		namePrefix?: string;
		isReused: boolean;
	}
	const pendingFilters: PendingFilter[] = [];

	for (const ref of refs) {
		const segment = segmentsByKey.get(ref.envKey)?.get(ref.segmentKey);
		if (!segment) continue; // fetch failed; already counted as skipped

		if (segment.deleted) {
			stats.skipped++;
			continue;
		}

		if (isMatchNoneSegment(segment)) {
			segmentConstantLookup.set(segmentLookupKey(ref), ref.negated);
			stats.skipped++;
			continue;
		}

		const tupleKey = `launchdarkly:${projectKey}:${ref.segmentKey}:${ref.envKey}:${ref.negated}`;
		if (existingByTuple.has(tupleKey)) {
			const existingId = existingByTuple.get(tupleKey) ?? '';
			const existingSf = existingFilters.find((sf) => sf.id === existingId);
			savedFilterLookup.set(segmentLookupKey(ref), existingId);
			stats.reused++;
			pendingFilters.push({
				ref,
				segment,
				namePrefix:
					existingSf?.migration_metadata?.provider === 'launchdarkly'
						? existingSf.migration_metadata.name_prefix
						: undefined,
				isReused: true,
			});
			continue;
		}

		pendingFilters.push({ ref, segment, isReused: false });
	}

	const newPendingFilters = pendingFilters.filter((p) => !p.isReused);

	// ── Step 3c: Cross-project name collision detection & resolution ──────────
	const collisionSet = new Set<PendingFilter>();
	const thisRunNames = new Map<string, PendingFilter>();

	for (const pending of newPendingFilters) {
		const name = renderSavedFilterName(
			pending.segment.name,
			pending.ref.envKey,
			pending.ref.negated,
			pending.namePrefix,
		);
		if (name === null) continue; // envelope overflow — handled at create time

		// Check against existing DD filters from a different project (or no metadata)
		const existing = existingByName.get(name);
		if (existing) {
			const ldMeta =
				existing.migration_metadata?.provider === 'launchdarkly'
					? existing.migration_metadata
					: null;
			const sameProject =
				ldMeta !== null &&
				ldMeta.project_key === projectKey &&
				ldMeta.segment_key === pending.ref.segmentKey &&
				ldMeta.environment_key === pending.ref.envKey;
			if (!sameProject) {
				collisionSet.add(pending);
				continue;
			}
		}

		// Check intra-run collisions
		if (thisRunNames.has(name)) {
			collisionSet.add(pending);
			// biome-ignore lint/style/noNonNullAssertion: safe after .has() check above
			const first = thisRunNames.get(name)!;
			collisionSet.add(first);
		} else {
			thisRunNames.set(name, pending);
		}
	}

	const collisions = [...collisionSet];

	let conflictResolution:
		| { action: 'skip' }
		| { action: 'prefix'; prefix: string }
		| undefined;

	if (collisions.length > 0) {
		// Re-run short-circuit: check if all colliding filters already have a name_prefix recorded
		const allHavePrefix = collisions.every((p) => {
			const tupleKey = `launchdarkly:${projectKey}:${p.ref.segmentKey}:${p.ref.envKey}:${p.ref.negated}`;
			const existingId = existingByTuple.get(tupleKey);
			if (!existingId) return false;
			const sf = existingFilters.find((f) => f.id === existingId);
			if (sf?.migration_metadata?.provider !== 'launchdarkly') return false;
			return sf.migration_metadata.name_prefix !== undefined;
		});

		if (!allHavePrefix) {
			console.log();
			console.log(
				chalk.yellow(
					`  ${collisions.length} saved filter name(s) would conflict with existing filters`,
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

			if (action === 'prefix') {
				const prefix = await input({
					message: 'Enter a prefix for conflicting saved filter names:',
					validate: (val) => {
						const trimmed = val.trim();
						if (trimmed.length === 0) return 'Prefix cannot be empty';
						if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed))
							return 'Prefix must contain only lowercase letters, numbers, and hyphens';
						return true;
					},
				});
				conflictResolution = { action: 'prefix', prefix: prefix.trim() };
			} else {
				conflictResolution = { action: 'skip' };
			}
		}
	}

	// ── Step 4: Create saved filters ──────────────────────────────────────────
	const savedFilterSpinner = createSpinner('Creating saved filters…').start();
	const createdNamesSoFar = new Set<string>(existingByName.keys());

	for (const pending of newPendingFilters) {
		const { ref, segment } = pending;
		const lookupKey = segmentLookupKey(ref);

		// Determine name prefix
		let namePrefix = pending.namePrefix;
		if (collisionSet.has(pending)) {
			if (conflictResolution?.action === 'skip') {
				savedFilterSpinner.warn(
					`Skipped saved filter for "${ref.segmentKey}" — name conflict`,
				);
				stats.skipped++;
				continue;
			} else if (conflictResolution?.action === 'prefix') {
				namePrefix = conflictResolution.prefix;
			} else {
				// allHavePrefix short-circuit: no resolution was needed
				// (this path is safe — name_prefix already in metadata prevents collision)
			}
		}

		// Render name
		const name = renderSavedFilterName(
			segment.name,
			ref.envKey,
			ref.negated,
			namePrefix,
		);
		if (name === null) {
			savedFilterSpinner.warn(
				`Skipped "${ref.segmentKey}" — saved filter name exceeds 200 bytes after truncation envelope`,
			);
			stats.skipped++;
			continue;
		}

		// Check truncation-induced collisions
		if (createdNamesSoFar.has(name)) {
			const existingSf = existingByName.get(name);
			const tupleKey = `launchdarkly:${projectKey}:${ref.segmentKey}:${ref.envKey}:${ref.negated}`;
			if (existingSf && existingByTuple.get(tupleKey) === existingSf.id) {
				// Same tuple — idempotent reuse
				savedFilterLookup.set(lookupKey, existingSf.id);
				stats.reused++;
				continue;
			}
			savedFilterSpinner.warn(
				`Skipped "${ref.segmentKey}" — saved filter name collision after truncation`,
			);
			stats.skipped++;
			continue;
		}

		// Build targeting rules
		const targetingRules = ref.negated
			? buildNegatedRules(segment)
			: buildNonNegatedRules(segment);

		if (targetingRules === null) {
			savedFilterSpinner.warn(
				`Skipped "${ref.segmentKey}" — unsupported segment (multi-context, nested segmentMatch, or negation explosion)`,
			);
			stats.skipped++;
			continue;
		}

		const description = ref.negated
			? segment.description
				? `Inverse of: ${segment.description}`
				: `Inverse of ${segment.name}`
			: segment.description;

		const metadata: LDSavedFilterMigrationMetadata = {
			provider: 'launchdarkly',
			project_key: projectKey,
			segment_key: ref.segmentKey,
			environment_key: ref.envKey,
			negated: ref.negated,
			...(namePrefix ? { name_prefix: namePrefix } : {}),
		};

		try {
			const { id } = await createSavedFilter(
				ddApiKey,
				ddAppKey,
				{
					name,
					...(description ? { description } : {}),
					creation_type: getCreationType(segment),
					targeting_rules: targetingRules,
					migration_metadata: metadata,
				},
				ddSite,
			);
			savedFilterLookup.set(lookupKey, id);
			createdNamesSoFar.add(name);
			stats.created++;
			if (ref.negated) stats.negated++;
		} catch (err) {
			const error = formatAxiosError(err);
			savedFilterSpinner.warn(
				`Failed to create saved filter for "${ref.segmentKey}": ${error}`,
			);
			stats.failures.push({
				segmentKey: ref.segmentKey,
				envKey: ref.envKey,
				error,
			});
		}
	}

	savedFilterSpinner.succeed(
		`Created ${stats.created} saved filter(s) (${stats.negated} negated variants, ${stats.reused} reused, ${stats.skipped} skipped)`,
	);

	return { savedFilterLookup, segmentConstantLookup, stats };
}

/**
 * Dry-run Phase 1: fetch referenced LaunchDarkly segments and prepare the lookup
 * maps used by allocation building without creating Datadog saved filters.
 * Empty match-none segments are folded as constants; all other resolvable
 * segment refs receive synthetic saved-filter IDs for the dry-run request body.
 */
export async function planDryRunSegments(params: {
	ldApiKey: string;
	projectKey: string;
	selectedFlags: LDFlag[];
	envMapping: Map<string, DatadogEnvironment>;
}): Promise<SegmentMigrationResult> {
	const { ldApiKey, projectKey, selectedFlags, envMapping } = params;
	const savedFilterLookup = new Map<string, string>();
	const segmentConstantLookup = new Map<string, boolean>();
	const stats = createSegmentMigrationStats();
	const envKeys = [...envMapping.keys()];

	const discoverSpinner = createSpinner(
		'Discovering segments referenced by flags…',
	).start();
	const refs = discoverSegmentRefs(selectedFlags, envKeys);
	stats.discovered = discoveredSegmentCount(refs);
	discoverSpinner.succeed(
		`Found ${stats.discovered} segment(s) across ${envKeys.length} environment(s)`,
	);

	if (refs.length === 0) {
		return { savedFilterLookup, segmentConstantLookup, stats };
	}

	const segmentsByKey = await fetchReferencedSegments(
		ldApiKey,
		projectKey,
		refs,
		stats,
	);

	const planningSpinner = createSpinner(
		'Planning saved filters for segments…',
	).start();
	let placeholderIndex = 0;
	for (const ref of refs) {
		const segment = segmentsByKey.get(ref.envKey)?.get(ref.segmentKey);
		if (!segment) continue; // fetch failed; already counted as skipped

		if (segment.deleted) {
			stats.skipped++;
			continue;
		}

		const lookupKey = segmentLookupKey(ref);
		if (isMatchNoneSegment(segment)) {
			segmentConstantLookup.set(lookupKey, ref.negated);
			stats.skipped++;
			continue;
		}

		const targetingRules = ref.negated
			? buildNegatedRules(segment)
			: buildNonNegatedRules(segment);
		if (targetingRules === null) {
			stats.skipped++;
			continue;
		}

		savedFilterLookup.set(lookupKey, `dry-run-placeholder-${placeholderIndex}`);
		placeholderIndex++;
		stats.created++;
		if (ref.negated) stats.negated++;
	}

	planningSpinner.succeed(
		`Would create ${stats.created} saved filter(s) (${stats.negated} negated variants, ${stats.reused} reused, ${stats.skipped} skipped)`,
	);

	return { savedFilterLookup, segmentConstantLookup, stats };
}
