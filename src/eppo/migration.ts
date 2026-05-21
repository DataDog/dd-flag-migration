import type {
	DatadogAllocationForFlagCreation,
	DatadogCondition,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogTargetingRule,
} from '../types.js';
import type { EppoAllocation, EppoFlag } from './types.js';

// MAJOR.MINOR.PATCH with optional pre-release and build metadata; no leading zeros
const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;

function isValidSemver(value: string): boolean {
	return SEMVER_RE.test(value);
}

// Map Eppo variation_type → Datadog value_type
export function mapVariationType(
	eppoType: string,
): DatadogCreateFlagRequest['value_type'] {
	switch (eppoType.toUpperCase()) {
		case 'BOOLEAN':
			return 'BOOLEAN';
		case 'INTEGER':
			return 'INTEGER';
		case 'NUMERIC':
			return 'NUMERIC';
		case 'JSON':
			return 'JSON';
		default:
			return 'STRING';
	}
}

// Map Eppo condition operator → Datadog condition operator.
// For LT/LTE/GT/GTE, emits SEMVER_* when every value is a valid semver string;
// otherwise falls back to the plain numeric operator.
export function mapOperator(eppoOp: string, values?: string[]): string {
	const op = eppoOp.toUpperCase();
	const semverMap: Record<string, string> = {
		LT: 'SEMVER_LT',
		LTE: 'SEMVER_LTE',
		GT: 'SEMVER_GT',
		GTE: 'SEMVER_GTE',
	};
	if (
		op in semverMap &&
		values &&
		values.length > 0 &&
		values.every(isValidSemver)
	) {
		return semverMap[op];
	}
	const mapping: Record<string, string> = {
		LT: 'LT',
		LTE: 'LTE',
		GT: 'GT',
		GTE: 'GTE',
		MATCHES: 'MATCHES',
		ONE_OF: 'ONE_OF',
		NOT_ONE_OF: 'NOT_ONE_OF',
		IS_NULL: 'IS_NULL',
	};
	return mapping[op] ?? op;
}

// ─── Audience Fingerprinting ─────────────────────────────────────────────────

/**
 * Create a stable fingerprint from a set of conditions.
 * Used to detect allocation targeting rules that came from an Eppo audience,
 * since the API expands audience conditions inline without exposing audience_id.
 */
export function fingerprintConditions(
	conditions: Array<{ operator: string; attribute: string; values?: string[] }>,
): string {
	const normalized = conditions
		.map((c) => ({
			op: c.operator.toUpperCase(),
			attr: c.attribute,
			vals: [...(c.values ?? [])].sort(),
		}))
		.sort((a, b) => {
			const attrCmp = a.attr.localeCompare(b.attr);
			if (attrCmp !== 0) return attrCmp;
			return a.op.localeCompare(b.op);
		});
	return JSON.stringify(normalized);
}

// Returns true if any allocation contains at least one SEMVER_* condition.
// Datadog requires distribution_channel = 'CLIENT' when SEMVER operators are present.
export function hasSemverConditions(
	allocations: DatadogAllocationForFlagCreation[],
): boolean {
	return allocations.some(
		(alloc) =>
			alloc.targeting_rules?.some((rule) =>
				rule.conditions.some((cond) => cond.operator?.startsWith('SEMVER_')),
			) ?? false,
	);
}

/**
 * Convert Eppo targeting rules → Datadog targeting rules.
 *
 * When fingerprintLookup is provided, rules whose conditions match an Eppo
 * audience are replaced with a saved_filter_id reference. Duplicate saved
 * filter IDs within the same allocation are deduplicated (same semantics, OR).
 */
export function buildTargetingRules(
	eppoAlloc: EppoAllocation,
	fingerprintLookup?: Map<string, string>,
): DatadogTargetingRule[] {
	const rules: DatadogTargetingRule[] = [];
	const usedSavedFilterIds = new Set<string>();

	for (const rule of eppoAlloc.targeting_rules ?? []) {
		const conditions = rule.conditions ?? [];
		if (conditions.length === 0) continue;

		if (fingerprintLookup) {
			const fp = fingerprintConditions(conditions);
			const savedFilterId = fingerprintLookup.get(fp);
			if (savedFilterId !== undefined) {
				if (!usedSavedFilterIds.has(savedFilterId)) {
					usedSavedFilterIds.add(savedFilterId);
					rules.push({ conditions: [{ saved_filter_id: savedFilterId }] });
				}
				continue;
			}
		}

		const inlineConditions: DatadogCondition[] = conditions.map((cond) => ({
			operator: mapOperator(cond.operator, cond.values),
			attribute: cond.attribute,
			value: cond.values ?? [],
		}));
		rules.push({ conditions: inlineConditions });
	}

	return rules;
}

// Build allocations from Eppo's actual allocation data for each mapped DD environment
export function buildAllocations(
	flag: EppoFlag,
	mapping: Map<number, DatadogEnvironment>,
	fingerprintLookup?: Map<string, string>,
): DatadogAllocationForFlagCreation[] {
	const variations = flag.variations ?? [];
	if (variations.length === 0) return [];

	// Build variation_id → variant_key lookup
	const variationIdToKey = new Map<number, string>();
	for (const v of variations) variationIdToKey.set(v.id, v.variant_key);

	const eppoAllocations = flag.allocations ?? [];
	const _activeEnvIds = new Set(
		(flag.environments ?? []).filter((e) => e.active).map((e) => e.id),
	);
	const allocations: DatadogAllocationForFlagCreation[] = [];

	for (const [eppoEnvId, ddEnv] of mapping) {
		const envAllocs = eppoAllocations.filter(
			(a) => a.environment_id === eppoEnvId,
		);

		if (envAllocs.length === 0) {
			// No Eppo allocations — the flag will serve its default value
			continue;
		}

		for (const eppoAlloc of envAllocs) {
			// Map variant weights: Eppo variation_id → DD variant_key
			const rawWeights = eppoAlloc.variation_weight ?? [];
			const totalWeight = rawWeights.reduce((sum, w) => sum + w.weight, 0);

			const variantWeights = rawWeights
				.filter((w) => variationIdToKey.has(w.variation_id))
				.map((w) => ({
					variant_key: variationIdToKey.get(w.variation_id) ?? '',
					value: totalWeight > 0 ? (w.weight / totalWeight) * 100 : 0,
				}));

			if (variantWeights.length === 0) continue;

			// Map targeting rules
			const targetingRules = buildTargetingRules(eppoAlloc, fingerprintLookup);

			const allocationKey =
				eppoAlloc.key ||
				`${flag.key}-${ddEnv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${eppoAlloc.id}`;

			allocations.push({
				environment_id: ddEnv.id,
				name: eppoAlloc.name || ddEnv.name,
				key: allocationKey,
				type: 'FEATURE_GATE',
				variant_weights: variantWeights,
				...(targetingRules.length > 0
					? { targeting_rules: targetingRules }
					: {}),
			});
		}
	}

	return allocations;
}

// Determine which DD environments should be enabled for a flag
export function getEnvsToEnable(
	flag: EppoFlag,
	mapping: Map<number, DatadogEnvironment>,
): DatadogEnvironment[] {
	const activeEnvIds = new Set(
		(flag.environments ?? []).filter((e) => e.active).map((e) => e.id),
	);
	const envsToEnable: DatadogEnvironment[] = [];
	for (const [eppoEnvId, ddEnv] of mapping) {
		if (activeEnvIds.has(eppoEnvId)) envsToEnable.push(ddEnv);
	}
	return envsToEnable;
}
