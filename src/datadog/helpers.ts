import type {
	DatadogVariantDetail,
	FeatureFlagPageMeta,
	SourceVariant,
	VariantSyncPlan,
} from './types.js';

// ─── Pagination ───────────────────────────────────────────────────────────────

export const FEATURE_FLAG_PAGE_LIMIT = 50;

export function eppoSourceIdLookupKey(sourceId: string): string {
	return `eppo:${sourceId}`;
}

export function featureFlagPageTotal(
	response: FeatureFlagPageMeta,
): number | undefined {
	return (
		response.meta?.page?.total_filtered_count ??
		response.meta?.page?.total_count ??
		response.meta?.page?.total
	);
}

export function nextFeatureFlagOffset(
	response: FeatureFlagPageMeta,
	currentOffset: number,
	loadedCount: number,
): number | undefined {
	const nextOffset = response.meta?.page?.next_offset;
	if (typeof nextOffset === 'number') return nextOffset;
	if (loadedCount === 0) return undefined;

	const fallbackOffset = currentOffset + loadedCount;
	const total = featureFlagPageTotal(response);
	if (total !== undefined && fallbackOffset >= total) return undefined;
	if (loadedCount < FEATURE_FLAG_PAGE_LIMIT) return undefined;
	return fallbackOffset;
}

// ─── Variant Sync ─────────────────────────────────────────────────────────────

function readSourceIdFromMetadata(
	meta: Record<string, unknown> | undefined,
): string | undefined {
	if (!meta) return undefined;
	const sid = meta.source_id;
	return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
}

export function planVariantSync(
	sourceVariants: SourceVariant[],
	existingVariants: DatadogVariantDetail[],
): VariantSyncPlan {
	// Index existing variants by their migration_metadata.source_id (preferred,
	// survives source-side renames). Key/name/value fallbacks are only for
	// legacy variants that predate source_id metadata, with name/value limited
	// to unique matches across all existing variants.
	const existingBySourceId = new Map<string, DatadogVariantDetail>();
	const existingByKey = new Map<string, DatadogVariantDetail>();
	const existingByName = new Map<string, DatadogVariantDetail>();
	const nameCounts = new Map<string, number>();
	const valueCounts = new Map<string, number>();
	for (const ev of existingVariants) {
		nameCounts.set(ev.name, (nameCounts.get(ev.name) ?? 0) + 1);
		valueCounts.set(ev.value, (valueCounts.get(ev.value) ?? 0) + 1);
		const sid = readSourceIdFromMetadata(ev.migration_metadata);
		if (sid !== undefined) {
			existingBySourceId.set(sid, ev);
		} else {
			existingByKey.set(ev.key, ev);
		}
	}
	// Only index non-JSON values: JSON serialisation is key-order-sensitive so
	// the same object can stringify differently across LD API calls, making it
	// an unreliable match key.  Non-JSON variants (booleans, numbers, strings)
	// never start with '{' or '['.
	const existingByValue = new Map<string, DatadogVariantDetail>();
	for (const ev of existingVariants) {
		if (readSourceIdFromMetadata(ev.migration_metadata) !== undefined) continue;
		if (nameCounts.get(ev.name) === 1) {
			existingByName.set(ev.name, ev);
		}
		if (
			valueCounts.get(ev.value) === 1 &&
			!ev.value.startsWith('{') &&
			!ev.value.startsWith('[')
		) {
			existingByValue.set(ev.value, ev);
		}
	}

	const toCreate: VariantSyncPlan['toCreate'] = [];
	const toUpdate: VariantSyncPlan['toUpdate'] = [];
	const matchedExistingIds = new Set<string>();
	const reservedVariantKeys = new Set(existingVariants.map((ev) => ev.key));

	for (const sv of sourceVariants) {
		// 1. Prefer match on stable source_id (survives rename).
		// 2. Fall back to key match (for legacy variants with no source_id meta).
		// 3. Name match: catches key drift when the display name is stable.
		// 4. Value match: catches key+name drift (e.g. "Variation 0" → "true")
		//    when the value uniquely identifies the variant.
		const existingBySid = existingBySourceId.get(sv.sourceId);
		const fallbackCandidates = [
			existingByKey.get(sv.key),
			existingByName.get(sv.name),
			existingByValue.get(sv.value),
		];
		const fallbackMatch = fallbackCandidates.find(
			(candidate): candidate is DatadogVariantDetail =>
				candidate !== undefined && !matchedExistingIds.has(candidate.id),
		);
		const existing = existingBySid ?? fallbackMatch;
		if (!existing) {
			const key = reserveCreateVariantKey(sv.key, reservedVariantKeys);
			toCreate.push(key === sv.key ? sv : { ...sv, key, sourceKey: sv.key });
			continue;
		}
		matchedExistingIds.add(existing.id);

		// Rename detection: if the slugified source key drifted, treat it as an
		// update. Legacy fallback matches also update even when name/value/key are
		// identical so they get stamped with source_id for future runs.
		const renamed = existing.key !== sv.key;
		const legacyFallback = existingBySid === undefined;

		if (
			existing.name !== sv.name ||
			existing.value !== sv.value ||
			renamed ||
			legacyFallback
		) {
			toUpdate.push({
				id: existing.id,
				// Keep the DD-side key: variant key is immutable on the backend.
				// After a source rename the DD key may drift from sv.key — that's
				// expected. UUID stability is the contract that matters.
				key: existing.key,
				name: sv.name,
				value: sv.value,
				sourceId: sv.sourceId,
				sourceKey: sv.key,
			});
		}
	}

	const toDelete: Array<{ id: string; key: string }> = [];
	for (const ev of existingVariants) {
		if (!matchedExistingIds.has(ev.id)) {
			toDelete.push({ id: ev.id, key: ev.key });
		}
	}
	return { toCreate, toUpdate, toDelete };
}

function reserveCreateVariantKey(
	sourceKey: string,
	reservedVariantKeys: Set<string>,
): string {
	if (!reservedVariantKeys.has(sourceKey)) {
		reservedVariantKeys.add(sourceKey);
		return sourceKey;
	}

	let suffix = 1;
	let key = `${sourceKey}-${suffix}`;
	while (reservedVariantKeys.has(key)) {
		suffix++;
		key = `${sourceKey}-${suffix}`;
	}
	reservedVariantKeys.add(key);
	return key;
}

/**
 * Build dry-run request descriptors for a variant sync. Order matches the live
 * code path: creates + updates first (before allocation sync) and deletes
 * last (after allocation sync) — variants must outlive references.
 */
export function buildVariantSyncDryRunRequests(
	flagId: string,
	sourceVariants: SourceVariant[],
	existingVariants: DatadogVariantDetail[],
	provider: 'launchdarkly' | 'eppo',
): {
	createUpdateRequests: Array<{
		method: 'POST' | 'PUT';
		path: string;
		body: unknown;
	}>;
	deleteRequests: Array<{ method: 'DELETE'; path: string; body: unknown }>;
	sourceKeyToDatadogKey: Map<string, string>;
} {
	const plan = planVariantSync(sourceVariants, existingVariants);
	const createUpdateRequests: Array<{
		method: 'POST' | 'PUT';
		path: string;
		body: unknown;
	}> = [];
	const sourceKeyToDatadogKey = new Map<string, string>();
	for (const v of plan.toUpdate) {
		sourceKeyToDatadogKey.set(v.sourceKey, v.key);
		createUpdateRequests.push({
			method: 'PUT',
			path: `/api/v2/feature-flags/${flagId}/variants/${v.id}`,
			body: {
				data: {
					type: 'variants',
					id: v.id,
					attributes: {
						name: v.name,
						value: v.value,
						migration_metadata: {
							provider,
							source_id: v.sourceId,
							source_key: v.sourceKey,
						},
					},
				},
			},
		});
	}
	for (const v of plan.toCreate) {
		const sourceKey = v.sourceKey ?? v.key;
		sourceKeyToDatadogKey.set(sourceKey, v.key);
		createUpdateRequests.push({
			method: 'POST',
			path: `/api/v2/feature-flags/${flagId}/variants`,
			body: {
				data: {
					type: 'variants',
					attributes: {
						key: v.key,
						name: v.name,
						value: v.value,
						migration_metadata: {
							provider,
							source_id: v.sourceId,
							source_key: sourceKey,
						},
					},
				},
			},
		});
	}
	const deleteRequests: Array<{
		method: 'DELETE';
		path: string;
		body: unknown;
	}> = [];
	for (const v of plan.toDelete) {
		deleteRequests.push({
			method: 'DELETE',
			path: `/api/v2/feature-flags/${flagId}/variants/${v.id}`,
			body: {},
		});
	}
	return { createUpdateRequests, deleteRequests, sourceKeyToDatadogKey };
}
