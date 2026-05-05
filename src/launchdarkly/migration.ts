import type {
	DatadogAllocationForFlagCreation,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogTargetingRule,
} from '../types.js';
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

// ─── Operator Mapping ────────────────────────────────────────────────────────

type OperatorResult =
	| { operator: string; values: string[]; skip?: undefined }
	| { skip: string; operator?: undefined; values?: undefined };

const UNSUPPORTED_OPS = new Set(['segmentMatch', 'before', 'after']);

/** Map a single LD operator + negate + values → DD operator + transformed values */
export function mapOperator(
	op: string,
	negate: boolean,
	values: unknown[],
): OperatorResult {
	if (UNSUPPORTED_OPS.has(op)) {
		const reasons: Record<string, string> = {
			segmentMatch: 'Segment targeting is not supported in Datadog',
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
			// Negate by mapping to the inverse comparison operator
			const negateMap: Record<string, string> = {
				LT: 'GTE',
				LTE: 'GT',
				GT: 'LTE',
				GTE: 'LT',
				SEMVER_LT: 'SEMVER_GTE',
				SEMVER_GT: 'SEMVER_LTE',
				SEMVER_LTE: 'SEMVER_GT',
				SEMVER_GTE: 'SEMVER_LT',
			};
			const mapped = directMap[op];
			const negated = negateMap[mapped];
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
): Array<{ key: string; name: string; value: string }> {
	return flag.variations.map((v, i) => {
		const key = slugify(v.name ?? `variation-${i}`);
		const name = v.name ?? `Variation ${i}`;
		const value =
			typeof v.value === 'object' && v.value !== null
				? JSON.stringify(v.value)
				: String(v.value);
		return { key, name, value };
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

/** Convert LD clauses → DD targeting rules. Returns null if any clause is unsupported. */
export function buildTargetingRules(
	clauses: LDClause[],
): DatadogTargetingRule[] | null {
	if (clauses.length === 0) return [];

	const conditions: DatadogTargetingRule['conditions'] = [];

	for (const clause of clauses) {
		const result = mapOperator(clause.op, clause.negate, clause.values);
		if ('skip' in result) return null;

		conditions.push({
			operator: result.operator,
			attribute: clause.attribute,
			value: result.values,
		});
	}

	return [{ conditions }];
}

// ─── Allocation Building ─────────────────────────────────────────────────────

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

/** Build DD allocations for a single LD flag across selected environments */
export function buildAllocations(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
): DatadogAllocationForFlagCreation[] {
	const allocations: DatadogAllocationForFlagCreation[] = [];

	for (const [ldEnvKey, ddEnv] of envMapping) {
		const envConfig = flag.environments?.[ldEnvKey];
		if (!envConfig) continue;

		const envSlug = ddEnv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

		// 1. Individual targets → allocations with ONE_OF targeting
		for (let ti = 0; ti < envConfig.targets.length; ti++) {
			const target = envConfig.targets[ti];
			if (target.values.length === 0) continue;

			const variantWeights = buildVariantWeights(flag, target.variation);
			const targetingRules: DatadogTargetingRule[] = [
				{
					conditions: [
						{
							operator: 'ONE_OF',
							attribute: 'key',
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

		// 2. Rules → one allocation per rule
		for (let ri = 0; ri < envConfig.rules.length; ri++) {
			const rule = envConfig.rules[ri];
			if (rule.disabled) continue;

			const targetingRules = buildTargetingRules(rule.clauses);
			if (targetingRules === null) continue; // unsupported operator in clause

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
		action === 'copyFlagConfigTo'
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
