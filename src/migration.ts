import type {
	DatadogAllocationForFlagCreation,
	DatadogAllocationSyncRequest,
} from './types.js';

// Re-export Eppo-specific migration functions for backward compatibility
export {
	buildAllocations,
	buildTargetingRules,
	getEnvsToEnable,
	mapOperator,
	mapVariationType,
} from './eppo/migration.js';

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
