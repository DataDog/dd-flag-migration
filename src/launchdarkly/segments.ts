import { input, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { createSavedFilter, listSavedFilters } from '../datadog.js';
import type {
	DatadogCondition,
	DatadogEnvironment,
	DatadogTargetingRule,
	SavedFilterMigrationMetadata,
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
	stats: SegmentMigrationStats;
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
	const stats: SegmentMigrationStats = {
		discovered: 0,
		created: 0,
		negated: 0,
		skipped: 0,
		reused: 0,
		failures: [],
	};

	const envKeys = [...envMapping.keys()];

	// ── Step 1: Discover needed segments ──────────────────────────────────────
	const discoverSpinner = ora(
		'Discovering segments referenced by flags…',
	).start();
	const refs = discoverSegmentRefs(selectedFlags, envKeys);
	stats.discovered = new Set(
		refs.map((r) => `${r.segmentKey}:${r.envKey}`),
	).size;
	discoverSpinner.succeed(
		`Found ${stats.discovered} segment(s) across ${envKeys.length} environment(s)`,
	);

	if (refs.length === 0) {
		return { savedFilterLookup, stats };
	}

	// Group needed segment keys by envKey
	const neededByEnv = new Map<string, Set<string>>();
	for (const ref of refs) {
		if (!neededByEnv.has(ref.envKey)) neededByEnv.set(ref.envKey, new Set());
		neededByEnv.get(ref.envKey)?.add(ref.segmentKey);
	}

	// ── Step 2: Fetch segments from LD ────────────────────────────────────────
	const fetchSpinner = ora('Fetching segments from LaunchDarkly…').start();
	const segmentsByKey = new Map<string, Map<string, LDSegment>>();

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

	// ── Step 3: List existing DD saved filters for idempotency ────────────────
	const idempotencySpinner = ora(
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
		if (sf.migration_metadata) {
			const m = sf.migration_metadata;
			const tupleKey = `${m.provider}:${m.project_key}:${m.segment_key}:${m.environment_key}:${m.negated}`;
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

		const tupleKey = `launchdarkly:${projectKey}:${ref.segmentKey}:${ref.envKey}:${ref.negated}`;
		if (existingByTuple.has(tupleKey)) {
			const existingId = existingByTuple.get(tupleKey) ?? '';
			const existingSf = existingFilters.find((sf) => sf.id === existingId);
			savedFilterLookup.set(
				`${ref.segmentKey}:${ref.envKey}:${ref.negated}`,
				existingId,
			);
			stats.reused++;
			pendingFilters.push({
				ref,
				segment,
				namePrefix: existingSf?.migration_metadata?.name_prefix,
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
			const sameProject =
				existing.migration_metadata?.provider === 'launchdarkly' &&
				existing.migration_metadata.project_key === projectKey &&
				existing.migration_metadata.segment_key === pending.ref.segmentKey &&
				existing.migration_metadata.environment_key === pending.ref.envKey;
			if (!sameProject) {
				collisionSet.add(pending);
				continue;
			}
		}

		// Check intra-run collisions
		if (thisRunNames.has(name)) {
			collisionSet.add(pending);
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
			return sf?.migration_metadata?.name_prefix !== undefined;
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
				// eslint-disable-next-line no-constant-condition
				while (true) {
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
					break;
				}
			} else {
				conflictResolution = { action: 'skip' };
			}
		}
	}

	// ── Step 4: Create saved filters ──────────────────────────────────────────
	const createSpinner = ora('Creating saved filters…').start();
	const createdNamesSoFar = new Set<string>(existingByName.keys());

	for (const pending of newPendingFilters) {
		const { ref, segment } = pending;
		const lookupKey = `${ref.segmentKey}:${ref.envKey}:${ref.negated}`;

		// Determine name prefix
		let namePrefix = pending.namePrefix;
		if (collisionSet.has(pending)) {
			if (conflictResolution?.action === 'skip') {
				createSpinner.warn(
					`Skipped saved filter for "${ref.segmentKey}" — name conflict`,
				);
				stats.skipped++;
				continue;
			}
			if (conflictResolution?.action === 'prefix') {
				namePrefix = conflictResolution.prefix;
			}
		}

		// Guard: deleted segment
		if (segment.deleted) {
			stats.skipped++;
			continue;
		}

		// Guard: empty-match segment (no rules AND no included)
		if (segment.rules.length === 0 && segment.included.length === 0) {
			createSpinner.warn(
				`Skipped "${ref.segmentKey}" — empty segment (no rules or included users)`,
			);
			stats.skipped++;
			continue;
		}

		// Render name
		const name = renderSavedFilterName(
			segment.name,
			ref.envKey,
			ref.negated,
			namePrefix,
		);
		if (name === null) {
			createSpinner.warn(
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
			createSpinner.warn(
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
			createSpinner.warn(
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

		const metadata: SavedFilterMigrationMetadata = {
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
			createSpinner.warn(
				`Failed to create saved filter for "${ref.segmentKey}": ${error}`,
			);
			stats.failures.push({
				segmentKey: ref.segmentKey,
				envKey: ref.envKey,
				error,
			});
		}
	}

	createSpinner.succeed(
		`Created ${stats.created} saved filter(s) (${stats.negated} negated variants, ${stats.reused} reused, ${stats.skipped} skipped)`,
	);

	return { savedFilterLookup, stats };
}
