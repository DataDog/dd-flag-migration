import {
	createVariant,
	fetchFlagDetail,
	updateVariant,
} from '../datadog/api.js';
import type { DatadogOrgConnection } from '../datadog/orgs.js';
import type {
	DatadogVariantDetail,
	PendingVariantDelete,
	SourceVariant,
	VariantSyncCounts,
} from '../datadog/types.js';
import {
	type DatadogVariantSyncPlan,
	planDatadogVariantSync,
} from './helpers/migration.js';

export async function fetchTargetVariants(
	target: DatadogOrgConnection,
	flagId: string,
): Promise<DatadogVariantDetail[]> {
	const { variants } = await fetchFlagDetail(
		target.apiKey,
		target.appKey,
		flagId,
		target.site,
	);
	return variants;
}

/**
 * Apply variant creates and updates in the target org. Deletes are returned,
 * not applied: callers must rewrite targeting first and then call
 * `applyVariantDeletes`, because targeting references variants by UUID.
 */
export async function syncDatadogVariantsCreatesAndUpdates(
	target: DatadogOrgConnection,
	flagId: string,
	sourceVariants: SourceVariant[],
	valueType?: string,
): Promise<{
	counts: VariantSyncCounts;
	pendingDeletes: PendingVariantDelete[];
	plan: DatadogVariantSyncPlan;
}> {
	const existing = await fetchTargetVariants(target, flagId);
	const plan = planDatadogVariantSync(sourceVariants, existing, valueType);
	for (const variant of plan.toUpdate) {
		await updateVariant(
			target.apiKey,
			target.appKey,
			flagId,
			variant.id,
			{ name: variant.name, value: variant.value },
			target.site,
		);
	}
	for (const variant of plan.toCreate) {
		await createVariant(
			target.apiKey,
			target.appKey,
			flagId,
			{
				key: variant.key,
				name: variant.name,
				value: variant.value,
				migrationMetadata: {
					provider: 'datadog',
					source_id: variant.sourceId,
					source_key: variant.sourceKey ?? variant.key,
				},
			},
			target.site,
		);
	}
	return {
		counts: {
			added: plan.toCreate.length,
			updated: plan.toUpdate.length,
			deleted: plan.toDelete.length,
		},
		pendingDeletes: plan.toDelete,
		plan,
	};
}
