import type {
	DatadogAllocationForFlagCreation,
	DatadogAllocationSyncRequest,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogTargetingRule,
	EppoAllocation,
	EppoFlag,
} from './types.js';

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

// Map Eppo condition operator → Datadog condition operator
export function mapOperator(eppoOp: string): string {
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
	return mapping[eppoOp.toUpperCase()] ?? eppoOp.toUpperCase();
}

// Convert Eppo targeting rules → Datadog targeting rules
export function buildTargetingRules(
	eppoAlloc: EppoAllocation,
): DatadogTargetingRule[] {
	return (eppoAlloc.targeting_rules ?? [])
		.map((rule) => ({
			conditions: (rule.conditions ?? []).map((cond) => ({
				operator: mapOperator(cond.operator),
				attribute: cond.attribute,
				value: cond.values ?? [],
			})),
		}))
		.filter((rule) => rule.conditions.length > 0);
}

// Build allocations from Eppo's actual allocation data for each mapped DD environment
export function buildAllocations(
	flag: EppoFlag,
	mapping: Map<number, DatadogEnvironment>,
): DatadogAllocationForFlagCreation[] {
	const variations = flag.variations ?? [];
	if (variations.length === 0) return [];

	// Build variation_id → variant_key lookup
	const variationIdToKey = new Map<number, string>();
	for (const v of variations) variationIdToKey.set(v.id, v.variant_key);

	const eppoAllocations = flag.allocations ?? [];
	const activeEnvIds = new Set(
		(flag.environments ?? []).filter((e) => e.active).map((e) => e.id),
	);
	const allocations: DatadogAllocationForFlagCreation[] = [];

	for (const [eppoEnvId, ddEnv] of mapping) {
		const envAllocs = eppoAllocations.filter(
			(a) => a.environment_id === eppoEnvId,
		);

		if (envAllocs.length === 0) {
			// No Eppo allocations for this env — create a simple equal-weight fallback
			// only if the flag is active in this environment
			if (!activeEnvIds.has(eppoEnvId)) continue;
			const equalWeight = 100.0 / variations.length;
			const allocationKey = `${flag.key}-${ddEnv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
			allocations.push({
				environment_id: ddEnv.id,
				name: ddEnv.name,
				key: allocationKey,
				type: 'FEATURE_GATE',
				variant_weights: variations.map((v) => ({
					variant_key: v.variant_key,
					value: equalWeight,
				})),
			});
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
			const targetingRules = buildTargetingRules(eppoAlloc);

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

// Convert allocations built for flag creation into the sync request format
// (strips environment_id which is passed as a path parameter instead)
export function toSyncRequests(
	allocations: DatadogAllocationForFlagCreation[],
	envId: string,
): DatadogAllocationSyncRequest[] {
	return allocations
		.filter((a) => a.environment_id === envId)
		.map(({ name, key, type, variant_weights, targeting_rules }) => ({
			name,
			key,
			type,
			variant_weights,
			...(targeting_rules && targeting_rules.length > 0
				? { targeting_rules }
				: {}),
		}));
}
