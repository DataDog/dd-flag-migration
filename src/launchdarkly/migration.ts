import type {
	DatadogAllocationForFlagCreation,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogTargetingRule,
} from '../types.js';
import { NEGATION_TABLE } from './negation.js';
import type {
	LDClause,
	LDCustomRole,
	LDFlag,
	LDPolicyStatement,
	LDRollout,
	LDTeamWithRoles,
} from './types.js';

// ─── Flag Type Mapping ───────────────────────────────────────────────────────

/** Infer Datadog value_type from LD flag kind + variation values */
export function mapFlagType(
	flag: LDFlag,
): DatadogCreateFlagRequest['value_type'] {
	if (flag.kind === 'boolean') return 'BOOLEAN';

	// Multivariate: infer from variation values
	const values = flag.variations.map((v) => v.value);

	if (values.every((v) => typeof v === 'number')) return 'NUMERIC';
	if (values.some((v) => typeof v === 'object' && v !== null)) return 'JSON';
	return 'STRING';
}

// ─── Context-Key Attribute Mapping ───────────────────────────────────────────

/**
 * Datadog's UFC evaluator only treats `"id"` as an alias for the subject's
 * targeting_key. LD's `key` attribute on the user context plays the same role,
 * so any condition referencing the context key must be emitted as `"id"` for
 * user-kind contexts (and as `${ck}.key` for non-user kinds, which DD looks up
 * from the attribute bag as-is).
 */
function targetKeyAttribute(contextKind: string | undefined): string {
	const ck = contextKind ?? 'user';
	return ck === 'user' ? 'id' : `${ck}.key`;
}

// ─── Operator Mapping ────────────────────────────────────────────────────────

type OperatorResult =
	| { operator: string; values: string[]; skip?: undefined }
	| { skip: string; operator?: undefined; values?: undefined };

const UNSUPPORTED_OPS = new Set(['before', 'after']);

/** Map a single LD operator + negate + values → DD operator + transformed values */
export function mapOperator(
	op: string,
	negate: boolean,
	values: unknown[],
): OperatorResult {
	if (UNSUPPORTED_OPS.has(op)) {
		const reasons: Record<string, string> = {
			before: 'Date-based targeting (before/after) is not supported in Datadog',
			after: 'Date-based targeting (before/after) is not supported in Datadog',
		};
		return { skip: reasons[op] ?? `Unsupported operator: ${op}` };
	}

	const strValues = values.map((v) => String(v));

	// Direct mapping operators
	const directMap: Record<string, string> = {
		in: 'ONE_OF',
		lessThan: 'LT',
		lessThanOrEqual: 'LTE',
		greaterThan: 'GT',
		greaterThanOrEqual: 'GTE',
		semVerEqual: 'SEMVER_EQ',
		semVerLessThan: 'SEMVER_LT',
		semVerGreaterThan: 'SEMVER_GT',
		semVerLessThanOrEqual: 'SEMVER_LTE',
		semVerGreaterThanOrEqual: 'SEMVER_GTE',
	};

	if (op === 'in') {
		return {
			operator: negate ? 'NOT_ONE_OF' : 'ONE_OF',
			values: strValues,
		};
	}

	if (op === 'contains') {
		const regexValues = strValues.map((v) => `.*${escapeRegex(v)}.*`);
		return {
			operator: negate ? 'NOT_MATCHES' : 'MATCHES',
			values: [combineRegex(regexValues)],
		};
	}

	if (op === 'startsWith') {
		const regexValues = strValues.map((v) => `^${escapeRegex(v)}.*`);
		return {
			operator: negate ? 'NOT_MATCHES' : 'MATCHES',
			values: [combineRegex(regexValues)],
		};
	}

	if (op === 'endsWith') {
		const regexValues = strValues.map((v) => `.*${escapeRegex(v)}$`);
		return {
			operator: negate ? 'NOT_MATCHES' : 'MATCHES',
			values: [combineRegex(regexValues)],
		};
	}

	if (op === 'matches') {
		return {
			operator: negate ? 'NOT_MATCHES' : 'MATCHES',
			values: [combineRegex(strValues)],
		};
	}

	if (directMap[op]) {
		if (negate) {
			const mapped = directMap[op];
			const negated = NEGATION_TABLE[mapped];
			if (!negated) {
				return {
					skip: `Negated "${op}" cannot be mapped to a Datadog operator`,
				};
			}
			return { operator: negated, values: strValues };
		}
		return { operator: directMap[op], values: strValues };
	}

	// Unknown operator — pass through uppercased
	return { operator: op.toUpperCase(), values: strValues };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Combine multiple regex patterns into one using alternation. Returns the pattern unchanged if there is only one. */
function combineRegex(patterns: string[]): string {
	if (patterns.length === 1) return patterns[0];
	return patterns.map((p) => `(${p})`).join('|');
}

// ─── Segment Match Resolution ────────────────────────────────────────────────

export type SegmentMatchResolution =
	| { combine: 'AND'; savedFilterIds: string[] }
	| { combine: 'OR'; savedFilterIds: string[] }
	| { match: boolean }
	| { skip: string };

/**
 * Resolve a segmentMatch clause to saved filter IDs.
 * negate:false → OR semantics → combine:"OR" (one targeting rule per id)
 * negate:true  → AND semantics → combine:"AND" (all ids in one targeting rule)
 * Constant segment results are folded so empty segments do not require
 * synthetic saved filters.
 */
export function resolveSegmentMatch(
	clause: LDClause,
	envKey: string,
	savedFilterLookup: Map<string, string>,
	segmentConstantLookup: Map<string, boolean> = new Map(),
): SegmentMatchResolution {
	if ((clause.values as unknown[]).length === 0) {
		return { skip: 'segment not migrated' };
	}

	const savedFilterIds: string[] = [];
	let hasMissingSegment = false;
	for (const segKey of clause.values as string[]) {
		const mapKey = `${segKey}:${envKey}:${clause.negate}`;
		if (segmentConstantLookup.has(mapKey)) continue;
		const id = savedFilterLookup.get(mapKey);
		if (id) {
			savedFilterIds.push(id);
		} else {
			hasMissingSegment = true;
		}
	}

	if (clause.negate) {
		if (hasMissingSegment) return { skip: 'segment not migrated' };
		if (savedFilterIds.length === 0) return { match: true };
		return { combine: 'AND', savedFilterIds };
	}

	if (hasMissingSegment) return { skip: 'segment not migrated' };
	if (savedFilterIds.length === 0) return { match: false };

	return { combine: 'OR', savedFilterIds };
}

// ─── Skip Detection ──────────────────────────────────────────────────────────

export interface SkipResult {
	skip: boolean;
	reason?: string;
	warn?: string;
	hasProgressiveRollout?: boolean;
}

/** Check if a flag should be skipped, checking only the selected environments */
export function shouldSkipFlag(flag: LDFlag, envNames: string[]): SkipResult {
	for (const envName of envNames) {
		const envConfig = flag.environments?.[envName];
		if (!envConfig) continue;

		// Check for progressive rollouts — need async release status check
		if (envConfig.fallthrough.progressiveRolloutConfig) {
			return { skip: false, hasProgressiveRollout: true };
		}

		for (const rule of envConfig.rules) {
			if (rule.progressiveRolloutConfig) {
				return { skip: false, hasProgressiveRollout: true };
			}

			for (const clause of rule.clauses) {
				if (UNSUPPORTED_OPS.has(clause.op)) {
					const result = mapOperator(clause.op, clause.negate, clause.values);
					if ('skip' in result && result.skip) {
						return { skip: true, reason: result.skip };
					}
				}
			}
		}

		// Check for prerequisites — migrate but warn
		if (envConfig.prerequisites.length > 0) {
			return {
				skip: false,
				warn: 'Flag has prerequisites which are not enforced in Datadog',
			};
		}
	}

	return { skip: false };
}

// ─── Variant Building ────────────────────────────────────────────────────────

/** Convert LD variations → DD variant list */
export function buildVariants(
	flag: LDFlag,
): Array<{ key: string; name: string; value: string; sourceId: string }> {
	return flag.variations.map((v, i) => {
		const key = slugify(v.name ?? `variation-${i}`);
		const name = v.name ?? `Variation ${i}`;
		const rawValue =
			typeof v.value === 'object' && v.value !== null
				? v.value
				: String(v.value);
		const value = Array.isArray(rawValue)
			? JSON.stringify({ value: rawValue })
			: typeof rawValue === 'object'
				? JSON.stringify(rawValue)
				: rawValue;
		// LDVariation._id is the stable identifier — survives renames.
		return { key, name, value, sourceId: v._id };
	});
}

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'default'
	);
}

// ─── Targeting Rule Building ─────────────────────────────────────────────────

export type BuildTargetingRulesResult =
	| DatadogTargetingRule[]
	| null
	| { flagSkip: string };

const FAN_OUT_LIMIT = 100;

/**
 * Convert LD clauses → DD targeting rules.
 * Returns null to skip this rule (unsupported non-segment operator — safety net).
 * Returns { flagSkip } to skip the entire flag (missing segment, fan-out cap).
 * Returns DatadogTargetingRule[] (may be multiple rules due to OR fan-out).
 */
export function buildTargetingRules(
	clauses: LDClause[],
	envKey = '',
	savedFilterLookup: Map<string, string> = new Map(),
	segmentConstantLookup: Map<string, boolean> = new Map(),
): BuildTargetingRulesResult {
	if (clauses.length === 0) return [];

	const inlineConditions: DatadogTargetingRule['conditions'] = [];
	const andCombineIds: string[] = [];
	const orCombineGroups: string[][] = [];
	let deferredFlagSkip: string | undefined;

	for (const clause of clauses) {
		if (clause.op === 'segmentMatch') {
			const res = resolveSegmentMatch(
				clause,
				envKey,
				savedFilterLookup,
				segmentConstantLookup,
			);
			if ('skip' in res) {
				deferredFlagSkip ??= res.skip;
				continue;
			}
			if ('match' in res) {
				if (!res.match) return null;
				continue;
			}
			if (res.combine === 'AND') {
				andCombineIds.push(...res.savedFilterIds);
			} else {
				orCombineGroups.push(res.savedFilterIds);
			}
		} else {
			const result = mapOperator(clause.op, clause.negate, clause.values);
			if ('skip' in result) return null; // unsupported non-segment op (safety net)
			const ck = clause.contextKind ?? 'user';
			const attribute =
				clause.attribute === 'key'
					? targetKeyAttribute(ck)
					: ck === 'user'
						? clause.attribute
						: `${ck}.${clause.attribute}`;
			inlineConditions.push({
				operator: result.operator,
				attribute,
				value: result.values,
			});
		}
	}

	if (deferredFlagSkip !== undefined) return { flagSkip: deferredFlagSkip };

	// Fan-out cap: product of all OR-combine group sizes
	const fanOutSize = orCombineGroups.reduce((prod, g) => prod * g.length, 1);
	if (fanOutSize > FAN_OUT_LIMIT) {
		return { flagSkip: 'segmentMatch fan-out exceeds 100 groups' };
	}

	// Cartesian product of OR-combine groups
	let fanOutCombinations: string[][] = [[]];
	for (const group of orCombineGroups) {
		const next: string[][] = [];
		for (const existing of fanOutCombinations) {
			for (const id of group) {
				next.push([...existing, id]);
			}
		}
		fanOutCombinations = next;
	}

	const targetingRules = fanOutCombinations.map((fanOutIds) => ({
		conditions: [
			...fanOutIds.map((id) => ({ saved_filter_id: id })),
			...andCombineIds.map((id) => ({ saved_filter_id: id })),
			...inlineConditions,
		],
	}));

	return targetingRules.length === 1 &&
		targetingRules[0].conditions.length === 0
		? []
		: targetingRules;
}

/** Build variant weights from a rollout or single variation index */
function buildVariantWeights(
	flag: LDFlag,
	variationIndex?: number,
	rollout?: LDRollout,
): Array<{ variant_key: string; value: number }> {
	const variants = buildVariants(flag);

	if (rollout) {
		// LD weights are out of 100,000 — normalize to 0-100
		return rollout.variations.map((rv) => ({
			variant_key: variants[rv.variation]?.key ?? `variation-${rv.variation}`,
			value: (rv.weight / 100000) * 100,
		}));
	}

	if (variationIndex !== undefined) {
		// 100% on the specified variation
		return variants.map((v, i) => ({
			variant_key: v.key,
			value: i === variationIndex ? 100 : 0,
		}));
	}

	// Fallback: equal weight
	const equalWeight = 100 / variants.length;
	return variants.map((v) => ({
		variant_key: v.key,
		value: equalWeight,
	}));
}

// ─── Allocation Building ─────────────────────────────────────────────────────

export type BuildAllocationsResult =
	| DatadogAllocationForFlagCreation[]
	| { flagSkip: string };

export function buildAllocations(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
	savedFilterLookup: Map<string, string> = new Map(),
	segmentConstantLookup: Map<string, boolean> = new Map(),
): BuildAllocationsResult {
	const allocations: DatadogAllocationForFlagCreation[] = [];

	for (const [ldEnvKey, ddEnv] of envMapping) {
		const envConfig = flag.environments?.[ldEnvKey];
		if (!envConfig) continue;

		const envSlug = ddEnv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

		// 1. Individual targets → allocations with ONE_OF targeting.
		// LD's `targets` are always user-kind; DD's evaluator recognises "id"
		// (not "key") as the targeting-key alias on the subject.
		for (let ti = 0; ti < envConfig.targets.length; ti++) {
			const target = envConfig.targets[ti];
			if (target.values.length === 0) continue;

			const variantWeights = buildVariantWeights(flag, target.variation);
			const targetAttribute = targetKeyAttribute(target.contextKind);
			const targetingRules: DatadogTargetingRule[] = [
				{
					conditions: [
						{
							operator: 'ONE_OF',
							attribute: targetAttribute,
							value: target.values,
						},
					],
				},
			];

			allocations.push({
				environment_id: ddEnv.id,
				name: `${flag.key} target ${ti + 1}`,
				key: `${flag.key}-${envSlug}-target-${ti}`,
				type: 'FEATURE_GATE',
				variant_weights: variantWeights,
				targeting_rules: targetingRules,
			});
		}

		// 1b. Non-user context targets (contextTargets)
		for (let ti = 0; ti < envConfig.contextTargets.length; ti++) {
			const target = envConfig.contextTargets[ti];
			if (target.values.length === 0) continue;

			const variantWeights = buildVariantWeights(flag, target.variation);
			const targetAttribute = targetKeyAttribute(target.contextKind);
			const targetingRules: DatadogTargetingRule[] = [
				{
					conditions: [
						{
							operator: 'ONE_OF',
							attribute: targetAttribute,
							value: target.values,
						},
					],
				},
			];

			allocations.push({
				environment_id: ddEnv.id,
				name: `${flag.key} ${target.contextKind} target ${ti + 1}`,
				key: `${flag.key}-${envSlug}-ctx-target-${ti}`,
				type: 'FEATURE_GATE',
				variant_weights: variantWeights,
				targeting_rules: targetingRules,
			});
		}

		// 2. Rules → one allocation per rule (targeting_rules may fan out)
		for (let ri = 0; ri < envConfig.rules.length; ri++) {
			const rule = envConfig.rules[ri];
			if (rule.disabled) continue;

			const targetingRulesResult = buildTargetingRules(
				rule.clauses,
				ldEnvKey,
				savedFilterLookup,
				segmentConstantLookup,
			);

			if (
				targetingRulesResult !== null &&
				!Array.isArray(targetingRulesResult)
			) {
				return {
					flagSkip: `${targetingRulesResult.flagSkip} (env: ${ldEnvKey})`,
				};
			}
			if (targetingRulesResult === null) continue; // skip this rule

			const targetingRules = targetingRulesResult;
			const variantWeights = buildVariantWeights(
				flag,
				rule.variation,
				rule.rollout,
			);

			const ruleName = rule.description || `${flag.key} rule ${ri + 1}`;

			allocations.push({
				environment_id: ddEnv.id,
				name: ruleName,
				key: `${flag.key}-${envSlug}-rule-${ri}`,
				type: 'FEATURE_GATE',
				variant_weights: variantWeights,
				...(targetingRules.length > 0
					? { targeting_rules: targetingRules }
					: {}),
			});
		}

		// 3. Fallthrough → default allocation (no targeting rules)
		const ft = envConfig.fallthrough;
		const fallthroughWeights = buildVariantWeights(
			flag,
			ft.variation,
			ft.rollout,
		);

		allocations.push({
			environment_id: ddEnv.id,
			name: `${flag.key} default`,
			key: `${flag.key}-${envSlug}-fallthrough`,
			type: 'FEATURE_GATE',
			variant_weights: fallthroughWeights,
		});
	}

	return allocations;
}

// ─── Distribution Channel Detection ─────────────────────────────────────────

const SEMVER_OPS = new Set([
	'SEMVER_EQ',
	'SEMVER_NEQ',
	'SEMVER_LT',
	'SEMVER_LTE',
	'SEMVER_GT',
	'SEMVER_GTE',
]);

/** Returns true if any allocation contains a SEMVER targeting rule condition. */
export function hasSemverConditions(
	allocations: DatadogAllocationForFlagCreation[],
): boolean {
	for (const alloc of allocations) {
		for (const rule of alloc.targeting_rules ?? []) {
			for (const cond of rule.conditions) {
				if (cond.operator && SEMVER_OPS.has(cond.operator)) return true;
			}
		}
	}
	return false;
}

// ─── Environment Enablement ──────────────────────────────────────────────────

/** Determine which DD environments should be enabled for a flag */
export function getEnvsToEnable(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
): DatadogEnvironment[] {
	const envsToEnable: DatadogEnvironment[] = [];

	for (const [ldEnvKey, ddEnv] of envMapping) {
		const envConfig = flag.environments?.[ldEnvKey];
		if (envConfig?.on) {
			envsToEnable.push(ddEnv);
		}
	}

	return envsToEnable;
}

// ─── RBAC Team Discovery ─────────────────────────────────────────────────────

// Any update* action, plus the non-update flag write actions, maps to DD write access.
function isEditAction(action: string): boolean {
	return (
		action === '*' ||
		action.startsWith('update') ||
		action === 'createFlag' ||
		action === 'deleteFlag' ||
		action === 'copyFlagConfigTo' ||
		action === 'maintainFlag'
	);
}

/** Check if a resource pattern matches the given project key. */
function resourceMatchesProject(resource: string, projectKey: string): boolean {
	const match = resource.match(/^proj\/([^:;]+)/);
	if (!match) return false;
	const projPattern = match[1];
	return projPattern === '*' || projPattern === projectKey;
}

/**
 * Whether a policy statement covers any flag-edit action.
 * `actions` (allow-list) and `notActions` (block-list) are mutually exclusive in LD.
 */
function statementCoversEditAction(statement: LDPolicyStatement): boolean {
	if (statement.actions !== undefined) {
		return statement.actions.some(isEditAction);
	}
	if (statement.notActions !== undefined) {
		// notActions '*' excludes everything — no edit action is covered.
		if (statement.notActions.includes('*')) return false;
		const excluded = new Set(statement.notActions);
		// Use representative actions since isEditAction matches patterns, not a finite set.
		const REPRESENTATIVE_EDIT_ACTIONS = [
			'createFlag',
			'deleteFlag',
			'copyFlagConfigTo',
			'maintainFlag',
			'updateOn',
			'updateRules',
			'updateTargets',
			'updateFallthrough',
			'updateFlagVariations',
			'updateMaintainer',
			'updateTags',
			'updateScheduledChanges',
		];
		return REPRESENTATIVE_EDIT_ACTIONS.some((a) => !excluded.has(a));
	}
	return false;
}

/** Whether a statement's resource scope includes the given project. */
function statementMatchesProject(
	statement: LDPolicyStatement,
	projectKey: string,
): boolean {
	if (statement.resources !== undefined) {
		return statement.resources.some((r) =>
			resourceMatchesProject(r, projectKey),
		);
	}
	if (statement.notResources !== undefined) {
		return !statement.notResources.some((r) =>
			resourceMatchesProject(r, projectKey),
		);
	}
	return false;
}

/**
 * Find custom role keys that grant edit access to flags in the given project.
 * A role qualifies when it has an allow statement covering an edit action on
 * the project AND no deny statement that revokes that access (LD's "deny wins"
 * evaluation). Deny matching is conservative — any deny on an edit action for
 * the project excludes the role, even if the deny only covers a subset of the
 * allowed actions. This avoids false-positive editor grants at the cost of
 * occasionally missing roles with narrow denies combined with broader allows.
 */
export function findProjectEditorRoleKeys(
	roles: LDCustomRole[],
	projectKey: string,
): Set<string> {
	const editorKeys = new Set<string>();

	for (const role of roles) {
		let hasAllow = false;
		let hasDeny = false;

		for (const statement of role.policy) {
			if (!statementCoversEditAction(statement)) continue;
			if (!statementMatchesProject(statement, projectKey)) continue;

			if (statement.effect === 'allow') hasAllow = true;
			else if (statement.effect === 'deny') hasDeny = true;
		}

		if (hasAllow && !hasDeny) {
			editorKeys.add(role.key);
		}
	}

	return editorKeys;
}

/**
 * Find team keys that have at least one of the given editor role keys assigned.
 */
export function findTeamsWithEditAccess(
	teams: LDTeamWithRoles[],
	editorRoleKeys: Set<string>,
): Set<string> {
	const teamKeys = new Set<string>();
	for (const team of teams) {
		if (team.roles.some((r) => editorRoleKeys.has(r.key))) {
			teamKeys.add(team.key);
		}
	}
	return teamKeys;
}

// ─── Tag Building ───────────────────────────────────────────────────────────

/**
 * Build the tag list for a migrated flag, combining the LD flag's own tags
 * with a tag identifying the source LaunchDarkly project. The project tag is
 * always added so that migrated flags can be traced back to their LD origin.
 * Duplicates are removed to keep the tag list clean on re-migrations.
 * Uses the project key (not the display name) for a stable, machine-friendly
 * identifier.
 */
export function buildFlagTags(
	flagTags: string[],
	projectKey: string,
): string[] {
	const projectTag = `launchdarkly-project:${projectKey}`;
	return [...new Set([...flagTags, projectTag])];
}
