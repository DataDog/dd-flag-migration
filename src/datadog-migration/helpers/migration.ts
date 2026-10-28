import { copyMigratableExposureSchedule } from '../../datadog/exposure-schedules.js';
import type {
	DatadogAllocationForFlagCreation,
	DatadogCondition,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogExposureScheduleRequest,
	DatadogFlagEntry,
	DatadogStatusAllocation,
	DatadogStatusFlagDetail,
	DatadogTargetingRule,
	DatadogVariantDetail,
	EnvironmentMappingInput,
	SourceVariant,
	VariantSyncPlan,
} from '../../datadog/types.js';
import { mappedDatadogEnvironments } from '../../datadog/types.js';

type SourceEnvironment = DatadogStatusFlagDetail['environments'][number];

export type DatadogValueType = DatadogCreateFlagRequest['value_type'];
export type DatadogFlagDistributionChannel = 'CLIENT' | 'SERVER' | 'ALL';

const VALUE_TYPES = new Set<DatadogValueType>([
	'BOOLEAN',
	'INTEGER',
	'NUMERIC',
	'STRING',
	'JSON',
]);

const DISTRIBUTION_CHANNELS = new Set<DatadogFlagDistributionChannel>([
	'CLIENT',
	'SERVER',
	'ALL',
]);

// ─── Flag Matching ────────────────────────────────────────────────────────────

/**
 * Find the target-org flag for a source-org flag. Migration metadata recorded
 * by a previous Datadog-to-Datadog run wins; otherwise the flag key is the
 * shared identifier (keys are immutable in Datadog, so a same-key flag is the
 * same flag even when it was created independently in each org).
 */
export function findTargetFlag(
	targetFlags: DatadogFlagEntry[],
	source: { id: string; key: string },
): DatadogFlagEntry | undefined {
	return (
		targetFlags.find(
			(flag) =>
				flag.migration_metadata?.provider === 'datadog' &&
				flag.migration_metadata.source_id === source.id,
		) ?? targetFlags.find((flag) => flag.key === source.key)
	);
}

// ─── Flag Attributes ──────────────────────────────────────────────────────────

export function datadogValueType(
	detail: DatadogStatusFlagDetail,
): DatadogValueType | undefined {
	const valueType = detail.valueType as DatadogValueType | undefined;
	return valueType !== undefined && VALUE_TYPES.has(valueType)
		? valueType
		: undefined;
}

export function datadogDistributionChannel(
	detail: DatadogStatusFlagDetail,
): DatadogFlagDistributionChannel | undefined {
	const channel = detail.distributionChannel as
		| DatadogFlagDistributionChannel
		| undefined;
	return channel !== undefined && DISTRIBUTION_CHANNELS.has(channel)
		? channel
		: undefined;
}

// ─── Variants ─────────────────────────────────────────────────────────────────

/** Source variants carry their source-org UUID as the stable source ID. */
export function buildDatadogSourceVariants(
	detail: DatadogStatusFlagDetail,
): SourceVariant[] {
	return detail.variants.map((variant) => ({
		key: variant.key,
		name: variant.name,
		value: variant.value,
		sourceId: variant.id,
	}));
}

function uniqueIndex<T>(
	items: T[],
	identity: (item: T) => string | undefined,
): Map<string, T> {
	const index = new Map<string, T>();
	const duplicates = new Set<string>();
	for (const item of items) {
		const id = identity(item);
		if (id === undefined) continue;
		if (index.has(id)) duplicates.add(id);
		else index.set(id, item);
	}
	for (const id of duplicates) index.delete(id);
	return index;
}

/** JSON values are excluded: their serialisation is key-order-sensitive. */
function matchableValue(value: string): string | undefined {
	return value.startsWith('{') || value.startsWith('[') ? undefined : value;
}

/**
 * Pair source variants with target variants, keyed by source variant key.
 * Passes run strongest first so a weaker match never claims a variant that a
 * stronger one wants: a target variant this sync created (Datadog
 * `migration_metadata.source_id`), then key, then a name, then a non-JSON
 * value. Each identity must be unique in both orgs. Name and value catch
 * flags whose variants were created separately in each org under different
 * keys, such as "true"/"false" versus "variation-0"/"variation-1".
 */
export function matchDatadogVariants(
	sourceVariants: SourceVariant[],
	targetVariants: DatadogVariantDetail[],
): Map<string, DatadogVariantDetail> {
	const passes: Array<{
		source: (variant: SourceVariant) => string | undefined;
		target: (variant: DatadogVariantDetail) => string | undefined;
	}> = [
		{
			source: (variant) => variant.sourceId,
			target: (variant) => {
				const meta = variant.migration_metadata;
				return meta?.provider === 'datadog' &&
					typeof meta.source_id === 'string'
					? meta.source_id
					: undefined;
			},
		},
		{ source: (variant) => variant.key, target: (variant) => variant.key },
		{ source: (variant) => variant.name, target: (variant) => variant.name },
		{
			source: (variant) => matchableValue(variant.value),
			target: (variant) => matchableValue(variant.value),
		},
	];
	const matches = new Map<string, DatadogVariantDetail>();
	const claimed = new Set<string>();
	for (const pass of passes) {
		const targetIndex = uniqueIndex(targetVariants, pass.target);
		for (const [id, variant] of uniqueIndex(sourceVariants, pass.source)) {
			if (matches.has(variant.key)) continue;
			const counterpart = targetIndex.get(id);
			if (!counterpart || claimed.has(counterpart.id)) continue;
			matches.set(variant.key, counterpart);
			claimed.add(counterpart.id);
		}
	}
	return matches;
}

export interface DatadogVariantSyncPlan extends VariantSyncPlan {
	/** Source variant key → its key in the target org once the plan runs. */
	targetKeys: Map<string, string>;
}

/**
 * Plan variant writes for a Datadog-to-Datadog sync. Matching follows
 * `matchDatadogVariants`; target variant keys are immutable, so targeting
 * and default variants must be translated through `targetKeys`. Existing
 * `migration_metadata` is never rewritten: a target variant may carry another
 * provider's source ID, and replacing it would break that provider's own
 * re-migration matching. Boolean flags cannot gain variants, so an unmatched
 * boolean variant is an error rather than a doomed create.
 */
export function planDatadogVariantSync(
	sourceVariants: SourceVariant[],
	existingVariants: DatadogVariantDetail[],
	valueType?: string,
): DatadogVariantSyncPlan {
	const matches = matchDatadogVariants(sourceVariants, existingVariants);
	const reservedKeys = new Set(existingVariants.map((variant) => variant.key));
	const targetKeys = new Map<string, string>();
	const toCreate: VariantSyncPlan['toCreate'] = [];
	const toUpdate: VariantSyncPlan['toUpdate'] = [];
	for (const variant of sourceVariants) {
		const existing = matches.get(variant.key);
		if (!existing) {
			let key = variant.key;
			for (let suffix = 1; reservedKeys.has(key); suffix++) {
				key = `${variant.key}-${suffix}`;
			}
			reservedKeys.add(key);
			targetKeys.set(variant.key, key);
			toCreate.push(
				key === variant.key
					? variant
					: { ...variant, key, sourceKey: variant.key },
			);
			continue;
		}
		targetKeys.set(variant.key, existing.key);
		if (existing.name !== variant.name || existing.value !== variant.value) {
			toUpdate.push({
				id: existing.id,
				key: existing.key,
				name: variant.name,
				value: variant.value,
				sourceId: variant.sourceId,
				sourceKey: variant.key,
			});
		}
	}
	if (valueType === 'BOOLEAN' && toCreate.length > 0) {
		const keys = toCreate.map((variant) => variant.sourceKey ?? variant.key);
		throw new Error(
			`Could not match source variant(s) ${keys.join(', ')} to the target flag's variants; boolean flags cannot gain variants`,
		);
	}
	const matchedIds = new Set(
		[...matches.values()].map((variant) => variant.id),
	);
	const toDelete = existingVariants
		.filter((variant) => !matchedIds.has(variant.id))
		.map((variant) => ({ id: variant.id, key: variant.key }));
	return { toCreate, toUpdate, toDelete, targetKeys };
}

/** Rewrite targeting variant references to the target org's variant keys. */
export function remapAllocationVariantKeys<
	T extends {
		variant_weights: Array<{ variant_key: string; value: number }>;
		exposure_schedule?: DatadogExposureScheduleRequest;
	},
>(allocations: T[], targetKeys: ReadonlyMap<string, string>): T[] {
	return allocations.map((allocation) => ({
		...allocation,
		...(allocation.exposure_schedule
			? {
					exposure_schedule: {
						...allocation.exposure_schedule,
						...(allocation.exposure_schedule.control_variant_key !== undefined
							? {
									control_variant_key:
										targetKeys.get(
											allocation.exposure_schedule.control_variant_key,
										) ?? allocation.exposure_schedule.control_variant_key,
								}
							: {}),
					},
				}
			: {}),
		variant_weights: allocation.variant_weights.map((weight) => ({
			...weight,
			variant_key: targetKeys.get(weight.variant_key) ?? weight.variant_key,
		})),
	}));
}

/** Rewrite per-environment default variants to the target org's variant keys. */
export function remapDefaultVariantKeys(
	defaults: ReadonlyMap<string, string>,
	targetKeys: ReadonlyMap<string, string>,
): Map<string, string> {
	return new Map(
		[...defaults].map(([environmentId, key]) => [
			environmentId,
			targetKeys.get(key) ?? key,
		]),
	);
}

/**
 * Dry-run request descriptors for a variant plan, in the same order as the
 * live path: creates and updates before targeting writes, deletes last.
 */
export function buildDatadogVariantSyncRequests(
	flagId: string,
	plan: VariantSyncPlan,
): {
	createUpdateRequests: Array<{
		method: 'POST' | 'PUT';
		path: string;
		body: unknown;
	}>;
	deleteRequests: Array<{ method: 'DELETE'; path: string; body: unknown }>;
} {
	const createUpdateRequests: Array<{
		method: 'POST' | 'PUT';
		path: string;
		body: unknown;
	}> = [];
	for (const variant of plan.toUpdate) {
		createUpdateRequests.push({
			method: 'PUT',
			path: `/api/v2/feature-flags/${flagId}/variants/${variant.id}`,
			body: {
				data: {
					type: 'variants',
					id: variant.id,
					attributes: { name: variant.name, value: variant.value },
				},
			},
		});
	}
	for (const variant of plan.toCreate) {
		createUpdateRequests.push({
			method: 'POST',
			path: `/api/v2/feature-flags/${flagId}/variants`,
			body: {
				data: {
					type: 'variants',
					attributes: {
						key: variant.key,
						name: variant.name,
						value: variant.value,
						migration_metadata: {
							provider: 'datadog',
							source_id: variant.sourceId,
							source_key: variant.sourceKey ?? variant.key,
						},
					},
				},
			},
		});
	}
	const deleteRequests = plan.toDelete.map((variant) => ({
		method: 'DELETE' as const,
		path: `/api/v2/feature-flags/${flagId}/variants/${variant.id}`,
		body: {},
	}));
	return { createUpdateRequests, deleteRequests };
}

// ─── Targeting ────────────────────────────────────────────────────────────────

/**
 * Published targeting filters in evaluation order. Drafts are not served, so
 * they are neither migrated nor compared.
 */
export function liveAllocations(
	environment: Pick<SourceEnvironment, 'allocations'> | undefined,
): DatadogStatusAllocation[] {
	const allocations = (environment?.allocations ?? []).filter(
		(allocation) => allocation.status !== 'draft',
	);
	return allocations
		.map((allocation, index) => ({ allocation, index }))
		.sort(
			(a, b) =>
				(a.allocation.order_position ?? a.index) -
					(b.allocation.order_position ?? b.index) || a.index - b.index,
		)
		.map(({ allocation }) => allocation);
}

/**
 * Explain why a targeting filter cannot be reproduced in another org, or
 * return undefined when it can. Unstarted and completed standalone schedules can move
 * between orgs; experiments and guardrails have org-specific references.
 */
export function unsupportedAllocationReason(
	allocation: DatadogStatusAllocation,
): string | undefined {
	if (allocation.experiment_id) return 'is linked to an experiment';
	if (allocation.guardrail_metrics?.length)
		return 'uses org-specific guardrail metrics';
	if (
		allocation.type !== undefined &&
		allocation.type !== 'FEATURE_GATE' &&
		!(allocation.type === 'CANARY' && allocation.exposure_schedule)
	) {
		return `uses a ${allocation.type} progressive rollout`;
	}
	if (allocation.exposure_schedule != null) {
		// Control references are resolved separately when building/comparing.
		const raw = allocation.exposure_schedule;
		const controlId =
			typeof raw === 'object' && raw !== null && 'control_variant_id' in raw
				? String(raw.control_variant_id)
				: '';
		const copied = copyMigratableExposureSchedule(
			raw,
			new Map([[controlId, controlId]]),
		);
		if ('reason' in copied) return copied.reason;
	}
	return undefined;
}

/**
 * Return a skip reason when any mapped source environment uses targeting
 * that cannot be migrated. Environment overrides are only checked where the
 * source environment is enabled, since disabled environments are not served.
 */
export function unsupportedTargetingReason(
	detail: DatadogStatusFlagDetail,
	envMapping: EnvironmentMappingInput<string>,
	sourceEnvironmentNames: ReadonlyMap<string, string> = new Map(),
): string | undefined {
	for (const sourceEnvironmentId of envMapping.keys()) {
		const environment = detail.environments.find(
			(candidate) => candidate.environmentId === sourceEnvironmentId,
		);
		if (!environment) continue;
		const environmentName =
			sourceEnvironmentNames.get(sourceEnvironmentId) ?? sourceEnvironmentId;
		if (
			environment.status === 'ENABLED' &&
			environment.overrideVariantKey !== undefined
		) {
			return `Environment override is set in ${environmentName}`;
		}
		for (const allocation of liveAllocations(environment)) {
			const reason = unsupportedAllocationReason(allocation);
			if (reason) {
				return `Targeting filter "${allocation.name ?? allocation.key}" in ${environmentName} ${reason}`;
			}
		}
	}
	return undefined;
}

/** Collect saved filter IDs referenced by the mapped source environments. */
export function discoverSavedFilterRefs(
	details: DatadogStatusFlagDetail[],
	sourceEnvironmentIds: Iterable<string>,
): string[] {
	const environmentIds = new Set(sourceEnvironmentIds);
	const refs = new Set<string>();
	for (const detail of details) {
		for (const environment of detail.environments) {
			if (!environmentIds.has(environment.environmentId)) continue;
			for (const allocation of liveAllocations(environment)) {
				for (const rule of allocation.targeting_rules ?? []) {
					for (const condition of rule.conditions ?? []) {
						if (condition.saved_filter_id) refs.add(condition.saved_filter_id);
					}
				}
			}
		}
	}
	return [...refs];
}

function environmentSlug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function conditionValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item));
	if (value === undefined || value === null) return [];
	return [String(value)];
}

export type DatadogAllocationBuildResult =
	| { allocations: DatadogAllocationForFlagCreation[] }
	| { flagSkip: string };

/**
 * Translate source-org targeting filters into target-org requests.
 *
 * - Variant UUIDs become variant keys (keys are identical in both orgs).
 * - Saved filter UUIDs are remapped through `savedFilterIdMap`; an unmapped
 *   reference skips the flag rather than silently widening targeting.
 * - Targeting filter keys are unique per org, so when one source environment
 *   fans out to several target environments each copy gets an environment
 *   suffix. One-to-one mappings keep the source key.
 */
export function buildDatadogAllocations(
	detail: DatadogStatusFlagDetail,
	envMapping: EnvironmentMappingInput<string>,
	savedFilterIdMap: ReadonlyMap<string, string> = new Map(),
): DatadogAllocationBuildResult {
	const variantKeysById = new Map(
		detail.variants.map((variant) => [variant.id, variant.key]),
	);
	const allocations: DatadogAllocationForFlagCreation[] = [];
	for (const [sourceEnvironmentId, mapped] of envMapping) {
		const environment = detail.environments.find(
			(candidate) => candidate.environmentId === sourceEnvironmentId,
		);
		if (!environment) continue;
		const targets = mappedDatadogEnvironments(mapped);
		for (const target of targets) {
			for (const allocation of liveAllocations(environment)) {
				const unsupported = unsupportedAllocationReason(allocation);
				if (unsupported)
					return {
						flagSkip: `Targeting filter "${allocation.name ?? allocation.key}" ${unsupported}`,
					};
				const copied =
					allocation.exposure_schedule == null
						? undefined
						: copyMigratableExposureSchedule(
								allocation.exposure_schedule,
								variantKeysById,
							);
				if (copied && 'reason' in copied) {
					return {
						flagSkip: `Targeting filter "${allocation.name ?? allocation.key}" ${copied.reason}`,
					};
				}
				// All finite steps have expired: this filter no longer serves
				// any subject, so preserve its fallthrough by omitting it.
				if (copied?.schedule === null) continue;
				const targetingRules: DatadogTargetingRule[] = [];
				for (const rule of allocation.targeting_rules ?? []) {
					const conditions: DatadogCondition[] = [];
					for (const condition of rule.conditions ?? []) {
						if (condition.saved_filter_id) {
							const targetId = savedFilterIdMap.get(condition.saved_filter_id);
							if (targetId === undefined) {
								return {
									flagSkip: `Saved filter ${condition.saved_filter_id} could not be migrated`,
								};
							}
							conditions.push({ saved_filter_id: targetId });
							continue;
						}
						conditions.push({
							operator: condition.operator,
							attribute: condition.attribute,
							value: conditionValues(condition.value),
						});
					}
					if (conditions.length > 0) targetingRules.push({ conditions });
				}

				const variantWeights: Array<{ variant_key: string; value: number }> =
					[];
				for (const weight of allocation.variant_weights ?? []) {
					const variantKey =
						weight.variant_key ??
						(weight.variant_id
							? variantKeysById.get(weight.variant_id)
							: undefined);
					if (variantKey === undefined) {
						return {
							flagSkip: `Targeting filter "${allocation.name ?? allocation.key}" references an unknown variant`,
						};
					}
					variantWeights.push({ variant_key: variantKey, value: weight.value });
				}

				allocations.push({
					environment_id: target.id,
					name: allocation.name ?? allocation.key,
					key:
						targets.length > 1
							? `${allocation.key}-${environmentSlug(target.name)}`
							: allocation.key,
					type: allocation.type === 'CANARY' ? 'CANARY' : 'FEATURE_GATE',
					...(copied && 'schedule' in copied
						? { exposure_schedule: copied.schedule }
						: {}),
					variant_weights: variantWeights,
					...(targetingRules.length > 0
						? { targeting_rules: targetingRules }
						: {}),
				});
			}
		}
	}
	return { allocations };
}

// ─── Environment State ────────────────────────────────────────────────────────

/** Target environment ID → source default variant key. */
export function buildDatadogDefaultVariantKeyPerEnv(
	detail: DatadogStatusFlagDetail,
	envMapping: EnvironmentMappingInput<string>,
): Map<string, string> {
	const defaults = new Map<string, string>();
	for (const [sourceEnvironmentId, mapped] of envMapping) {
		const variantKey = detail.environments.find(
			(environment) => environment.environmentId === sourceEnvironmentId,
		)?.defaultVariantKey;
		if (variantKey === undefined) continue;
		for (const target of mappedDatadogEnvironments(mapped)) {
			defaults.set(target.id, variantKey);
		}
	}
	return defaults;
}

function isSourceEnvironmentEnabled(
	detail: DatadogStatusFlagDetail,
	sourceEnvironmentId: string,
): boolean {
	return (
		detail.environments.find(
			(environment) => environment.environmentId === sourceEnvironmentId,
		)?.status === 'ENABLED'
	);
}

export function getDatadogEnvsToEnable(
	detail: DatadogStatusFlagDetail,
	envMapping: EnvironmentMappingInput<string>,
): DatadogEnvironment[] {
	return [...envMapping].flatMap(([sourceEnvironmentId, mapped]) =>
		isSourceEnvironmentEnabled(detail, sourceEnvironmentId)
			? mappedDatadogEnvironments(mapped)
			: [],
	);
}

export function getDatadogEnvsToDisable(
	detail: DatadogStatusFlagDetail,
	envMapping: EnvironmentMappingInput<string>,
): DatadogEnvironment[] {
	return [...envMapping].flatMap(([sourceEnvironmentId, mapped]) =>
		isSourceEnvironmentEnabled(detail, sourceEnvironmentId)
			? []
			: mappedDatadogEnvironments(mapped),
	);
}

// ─── Flag Creation ────────────────────────────────────────────────────────────

export function buildDatadogCreateFlagRequest(
	detail: DatadogStatusFlagDetail,
	valueType: DatadogValueType,
	allocations: DatadogAllocationForFlagCreation[],
	sourceSite: string,
): DatadogCreateFlagRequest {
	const tags = detail.tags ?? [];
	const distributionChannel = datadogDistributionChannel(detail);
	return {
		key: detail.key,
		name: detail.name,
		...(detail.description ? { description: detail.description } : {}),
		value_type: valueType,
		...(detail.jsonSchema ? { json_schema: detail.jsonSchema } : {}),
		variants: detail.variants.map(({ key, name, value }) => ({
			key,
			name,
			value,
		})),
		allocations: allocations.length > 0 ? allocations : undefined,
		migration_metadata: {
			provider: 'datadog',
			source_id: detail.id,
			source_key: detail.key,
			source_site: sourceSite,
		},
		...(distributionChannel !== undefined
			? { distribution_channel: distributionChannel }
			: {}),
		...(tags.length > 0 ? { tags } : {}),
	};
}
