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
	// survives source-side renames) and by key (fallback for legacy variants
	// migrated before source_id metadata existed).
	const existingBySourceId = new Map<string, DatadogVariantDetail>();
	const existingByKey = new Map<string, DatadogVariantDetail>();
	for (const ev of existingVariants) {
		existingByKey.set(ev.key, ev);
		const sid = readSourceIdFromMetadata(ev.migration_metadata);
		if (sid !== undefined) existingBySourceId.set(sid, ev);
	}

	const toCreate: SourceVariant[] = [];
	const toUpdate: VariantSyncPlan['toUpdate'] = [];
	const matchedExistingIds = new Set<string>();

	for (const sv of sourceVariants) {
		// 1. Prefer match on stable source_id (survives rename).
		// 2. Fall back to key match (for legacy variants with no source_id meta).
		const existing =
			existingBySourceId.get(sv.sourceId) ?? existingByKey.get(sv.key);
		if (!existing) {
			toCreate.push(sv);
			continue;
		}
		matchedExistingIds.add(existing.id);

		// Rename detection: if we matched by source_id but the slugified key
		// drifted, treat it as an update (name almost certainly changed too).
		// Otherwise update only on actual name/value drift.
		const renamed = existing.key !== sv.key;

		if (existing.name !== sv.name || existing.value !== sv.value || renamed) {
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
} {
	const plan = planVariantSync(sourceVariants, existingVariants);
	const createUpdateRequests: Array<{
		method: 'POST' | 'PUT';
		path: string;
		body: unknown;
	}> = [];
	for (const v of plan.toUpdate) {
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
							source_key: v.key,
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
	return { createUpdateRequests, deleteRequests };
}
