import axios, { type AxiosInstance } from 'axios';
import {
	eppoSourceIdLookupKey,
	FEATURE_FLAG_PAGE_LIMIT,
	nextFeatureFlagOffset,
	planVariantSync,
} from './helpers.js';
import type {
	CreateSavedFilterRequest,
	DatadogAllocationSyncRequest,
	DatadogCreatedFlag,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogTeam,
	DatadogVariantDetail,
	DDRestrictionBinding,
	MigrationMetadata,
	PendingVariantDelete,
	SavedFilterMigrationMetadata,
	SavedFilterSummary,
	SourceVariant,
	VariantMigrationMetadata,
	VariantSyncCounts,
} from './types.js';

// ─── Rate Limiting ──────────────────────────────────────────────────────────

const DD_MAX_RETRIES = 3;
const DD_RETRY_BASE_DELAY_MS = 1_000;
const DD_RETRY_FACTOR = 2;
// Pause proactively when this many requests remain in the current window.
const DD_PROACTIVE_THRESHOLD = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function ddBackoffDelayMs(attempt: number): number {
	return Math.min(30_000, DD_RETRY_BASE_DELAY_MS * DD_RETRY_FACTOR ** attempt);
}

export function createDDClient(): AxiosInstance {
	// Earliest epoch-ms at which the next request may be sent. Scoped per client
	// so tests (and any callers that build their own client) get isolated state.
	let pauseUntil = 0;

	const client = axios.create();

	client.interceptors.request.use(async (config) => {
		const wait = pauseUntil - Date.now();
		if (wait > 0) await sleep(wait);
		return config;
	});

	client.interceptors.response.use(
		(response) => {
			const headers = response.headers as Record<string, string | undefined>;
			const remaining = headers['x-ratelimit-remaining'];
			const reset = headers['x-ratelimit-reset'];
			if (remaining !== undefined && reset !== undefined) {
				const rem = Number(remaining);
				const resetSec = Number(reset);
				if (
					Number.isFinite(rem) &&
					Number.isFinite(resetSec) &&
					rem <= DD_PROACTIVE_THRESHOLD &&
					resetSec > 0
				) {
					const wasPaused = pauseUntil > Date.now();
					pauseUntil = Math.max(pauseUntil, Date.now() + resetSec * 1_000);
					// Warn only on transition into a paused window so concurrent
					// in-flight requests don't each emit their own warning.
					if (!wasPaused) {
						console.warn(
							`Datadog rate limit nearly exhausted (${rem} remaining); pausing ${resetSec}s before next request.`,
						);
					}
				}
			}
			return response;
		},
		async (error) => {
			if (!axios.isAxiosError(error) || error.response?.status !== 429) {
				throw error;
			}

			const config = error.config;
			if (!config) throw error;

			const configAny = config as unknown as Record<string, unknown>;
			const retryCount: number = (configAny.__retryCount as number) ?? 0;
			if (retryCount >= DD_MAX_RETRIES) {
				throw new Error(
					`Datadog API rate-limited after ${DD_MAX_RETRIES} retries; try again later`,
				);
			}

			const hdrs = error.response?.headers as
				| Record<string, string | undefined>
				| undefined;
			const resetHeader = hdrs?.['x-ratelimit-reset'];
			const delayMs =
				resetHeader !== undefined && Number(resetHeader) > 0
					? (Number(resetHeader) + 1) * 1_000
					: ddBackoffDelayMs(retryCount);

			console.warn(
				`Datadog API returned 429; retrying after ${Math.ceil(delayMs / 1_000)}s (attempt ${retryCount + 1} of ${DD_MAX_RETRIES}).`,
			);
			configAny.__retryCount = retryCount + 1;
			pauseUntil = Math.max(pauseUntil, Date.now() + delayMs);
			await sleep(delayMs);
			return client.request(config);
		},
	);

	return client;
}

// Module-level client used by all DD API functions.
// Exported for testing so AxiosMockAdapter can be attached to this instance.
export const ddClient = createDDClient();

// ────────────────────────────────────────────────────────────────────────────

function ddHeaders(apiKey: string, appKey: string) {
	return {
		'dd-api-key': apiKey,
		'dd-application-key': appKey,
	};
}

type JsonApiEnvironment = {
	id: string;
	type: string;
	attributes: {
		name: string;
		is_production: boolean;
		queries: string[];
		require_feature_flag_approval: boolean;
	};
};

export async function fetchDatadogEnvironments(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<DatadogEnvironment[]> {
	const baseUrl = `https://api.${site}`;
	const response = await ddClient.get<{ data: JsonApiEnvironment[] }>(
		`${baseUrl}/api/v2/feature-flags/environments`,
		{ headers: ddHeaders(apiKey, appKey) },
	);
	return response.data.data.map((item) => ({
		id: item.id,
		name: item.attributes.name,
		is_production: item.attributes.is_production,
		queries: item.attributes.queries ?? [],
	}));
}

// Local type for JSON:API flag list response
type JsonApiFlag = {
	id: string;
	type: string;
	attributes: {
		key: string;
		name: string;
		migration_metadata?: MigrationMetadata;
	};
};

type JsonApiFlagListResponse = {
	data: JsonApiFlag[];
	meta?: {
		page?: {
			total?: number;
			total_count?: number;
			total_filtered_count?: number;
			next_offset?: number | null;
		};
	};
};

export async function fetchDatadogFlagKeys(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<Map<string, string>> {
	const baseUrl = `https://api.${site}`;
	const keys = new Map<string, string>();
	let offset = 0;
	while (true) {
		const response = await ddClient.get<JsonApiFlagListResponse>(
			`${baseUrl}/api/v2/feature-flags`,
			{
				headers: ddHeaders(apiKey, appKey),
				params: {
					limit: FEATURE_FLAG_PAGE_LIMIT,
					offset,
					is_archived: false,
				},
			},
		);
		const flags = response.data.data ?? [];
		for (const f of flags) {
			keys.set(f.attributes.key, f.id);
			const metadata = f.attributes.migration_metadata;
			if (metadata?.provider === 'eppo') {
				if (metadata.source_key) keys.set(metadata.source_key, f.id);
				if (metadata.source_id) {
					keys.set(eppoSourceIdLookupKey(metadata.source_id), f.id);
				}
			}
		}
		const nextOffset = nextFeatureFlagOffset(
			response.data,
			offset,
			flags.length,
		);
		if (nextOffset === undefined) break;
		offset = nextOffset;
	}
	return keys;
}

export async function fetchDatadogFlags(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<DatadogFlagEntry[]> {
	const baseUrl = `https://api.${site}`;
	const allFlags: DatadogFlagEntry[] = [];
	let offset = 0;
	while (true) {
		const response = await ddClient.get<JsonApiFlagListResponse>(
			`${baseUrl}/api/v2/feature-flags`,
			{
				headers: ddHeaders(apiKey, appKey),
				params: {
					limit: FEATURE_FLAG_PAGE_LIMIT,
					offset,
					is_archived: false,
				},
			},
		);
		const data = response.data.data ?? [];
		for (const f of data) {
			allFlags.push({
				id: f.id,
				key: f.attributes.key,
				migration_metadata: f.attributes.migration_metadata,
			});
		}
		const nextOffset = nextFeatureFlagOffset(
			response.data,
			offset,
			data.length,
		);
		if (nextOffset === undefined) break;
		offset = nextOffset;
	}
	return allFlags;
}

export async function createFeatureFlag(
	apiKey: string,
	appKey: string,
	request: DatadogCreateFlagRequest,
	site = 'datadoghq.com',
): Promise<DatadogCreatedFlag> {
	const baseUrl = `https://api.${site}`;
	const body = { data: { type: 'feature-flags', attributes: request } };
	const response = await ddClient.post<{
		data: { id: string; attributes: { key: string } };
	}>(`${baseUrl}/api/v2/feature-flags`, body, {
		headers: {
			...ddHeaders(apiKey, appKey),
			'Content-Type': 'application/json',
		},
	});
	return { id: response.data.data.id, key: response.data.data.attributes.key };
}

export async function fetchFlagTags(
	apiKey: string,
	appKey: string,
	flagId: string,
	site = 'datadoghq.com',
): Promise<string[]> {
	const baseUrl = `https://api.${site}`;
	const response = await ddClient.get<{
		data: { attributes: { tags?: string[] } };
	}>(`${baseUrl}/api/v2/feature-flags/${flagId}`, {
		headers: ddHeaders(apiKey, appKey),
	});
	return response.data.data.attributes.tags ?? [];
}

export async function updateFlagTags(
	apiKey: string,
	appKey: string,
	flagId: string,
	tags: string[],
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	const body = {
		data: { type: 'feature-flags', attributes: { tags } },
	};
	await ddClient.put(`${baseUrl}/api/v2/feature-flags/${flagId}`, body, {
		headers: {
			...ddHeaders(apiKey, appKey),
			'Content-Type': 'application/json',
		},
	});
}

export async function updateFlagDistributionChannel(
	apiKey: string,
	appKey: string,
	flagId: string,
	distributionChannel: 'CLIENT' | 'SERVER' | 'BOTH',
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	const body = {
		data: {
			type: 'feature-flags',
			attributes: { distribution_channel: distributionChannel },
		},
	};
	await ddClient.put(`${baseUrl}/api/v2/feature-flags/${flagId}`, body, {
		headers: {
			...ddHeaders(apiKey, appKey),
			'Content-Type': 'application/json',
		},
	});
}

export async function fetchDatadogTeams(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<DatadogTeam[]> {
	const baseUrl = `https://api.${site}`;
	const teams: DatadogTeam[] = [];
	let pageNumber = 0;
	const pageSize = 100;
	while (true) {
		const response = await ddClient.get<{
			data: Array<{
				id: string;
				attributes: { handle: string; name: string };
			}>;
		}>(`${baseUrl}/api/v2/team`, {
			headers: ddHeaders(apiKey, appKey),
			params: {
				'page[size]': pageSize,
				'page[number]': pageNumber,
			},
		});
		const data = response.data.data ?? [];
		for (const t of data) {
			teams.push({
				id: t.id,
				handle: t.attributes.handle,
				name: t.attributes.name,
			});
		}
		if (data.length < pageSize) break;
		pageNumber++;
	}
	return teams;
}

export async function enableFeatureFlagEnvironment(
	apiKey: string,
	appKey: string,
	flagId: string,
	environmentId: string,
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	await ddClient.post(
		`${baseUrl}/api/v2/feature-flags/${flagId}/environments/${environmentId}/enable`,
		{},
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/json',
			},
		},
	);
}

type JsonApiFlagDetail = {
	id: string;
	type: string;
	attributes: {
		variants: Array<{
			id: string;
			key: string;
			name: string;
			value: string;
			// The backend variant DTO carries arbitrary migration_metadata; we
			// treat it loosely and read `provider` / `source_id` when present.
			migration_metadata?: Record<string, unknown>;
		}>;
		feature_flag_environments: Array<{
			environment_id: string;
			allocations: Array<{ id: string; key: string }> | null;
		}>;
	};
};

export async function fetchFlagDetail(
	apiKey: string,
	appKey: string,
	flagId: string,
	site = 'datadoghq.com',
): Promise<{
	variantKeyToId: Map<string, string>;
	variants: DatadogVariantDetail[];
	allocationKeyToIdByEnv: Map<string, Map<string, string>>;
}> {
	const baseUrl = `https://api.${site}`;
	const response = await ddClient.get<{ data: JsonApiFlagDetail }>(
		`${baseUrl}/api/v2/feature-flags/${flagId}`,
		{ headers: ddHeaders(apiKey, appKey) },
	);
	const { variants, feature_flag_environments } = response.data.data.attributes;

	const variantKeyToId = new Map<string, string>();
	const variantDetails: DatadogVariantDetail[] = [];
	for (const v of variants ?? []) {
		variantKeyToId.set(v.key, v.id);
		variantDetails.push({
			id: v.id,
			key: v.key,
			name: v.name,
			value: v.value,
			migration_metadata: v.migration_metadata,
		});
	}

	const allocationKeyToIdByEnv = new Map<string, Map<string, string>>();
	for (const env of feature_flag_environments ?? []) {
		const allocKeyToId = new Map<string, string>();
		for (const alloc of env.allocations ?? []) {
			allocKeyToId.set(alloc.key, alloc.id);
		}
		allocationKeyToIdByEnv.set(env.environment_id, allocKeyToId);
	}

	return {
		variantKeyToId,
		variants: variantDetails,
		allocationKeyToIdByEnv,
	};
}

// ─── Variants ────────────────────────────────────────────────────────────────

export async function createVariant(
	apiKey: string,
	appKey: string,
	flagId: string,
	variant: {
		key: string;
		name: string;
		value: string;
		migrationMetadata?: VariantMigrationMetadata;
	},
	site = 'datadoghq.com',
): Promise<DatadogVariantDetail> {
	const baseUrl = `https://api.${site}`;
	const body = {
		data: {
			type: 'variants',
			attributes: {
				key: variant.key,
				name: variant.name,
				value: variant.value,
				...(variant.migrationMetadata !== undefined
					? { migration_metadata: variant.migrationMetadata }
					: {}),
			},
		},
	};
	const response = await ddClient.post<{
		data: {
			id: string;
			attributes: { key: string; name: string; value: string };
		};
	}>(`${baseUrl}/api/v2/feature-flags/${flagId}/variants`, body, {
		headers: {
			...ddHeaders(apiKey, appKey),
			'Content-Type': 'application/vnd.api+json',
		},
	});
	return {
		id: response.data.data.id,
		key: response.data.data.attributes.key,
		name: response.data.data.attributes.name,
		value: response.data.data.attributes.value,
	};
}

export async function updateVariant(
	apiKey: string,
	appKey: string,
	flagId: string,
	variantId: string,
	variant: {
		name: string;
		value: string;
		migrationMetadata?: VariantMigrationMetadata;
	},
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	const body = {
		data: {
			type: 'variants',
			id: variantId,
			attributes: {
				name: variant.name,
				value: variant.value,
				...(variant.migrationMetadata !== undefined
					? { migration_metadata: variant.migrationMetadata }
					: {}),
			},
		},
	};
	await ddClient.put(
		`${baseUrl}/api/v2/feature-flags/${flagId}/variants/${variantId}`,
		body,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/vnd.api+json',
			},
		},
	);
}

export async function deleteVariant(
	apiKey: string,
	appKey: string,
	flagId: string,
	variantId: string,
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	await ddClient.delete(
		`${baseUrl}/api/v2/feature-flags/${flagId}/variants/${variantId}`,
		{ headers: ddHeaders(apiKey, appKey) },
	);
}

/**
 * Apply variant creates + updates only. Returns the resulting variantKey→UUID
 * map (for callers that need to resolve allocation variant references) and the
 * list of variants flagged for deletion but **not yet deleted**.
 *
 * The caller is expected to perform any allocation rewrites BEFORE invoking
 * `applyVariantDeletes` — variants must outlive references to them.
 */
export async function syncVariantsCreatesAndUpdates(
	apiKey: string,
	appKey: string,
	flagId: string,
	sourceVariants: SourceVariant[],
	provider: 'launchdarkly' | 'eppo',
	site = 'datadoghq.com',
): Promise<{
	variantKeyToId: Map<string, string>;
	sourceKeyToDatadogKey: Map<string, string>;
	counts: VariantSyncCounts;
	pendingDeletes: PendingVariantDelete[];
}> {
	const { variants: existingVariants } = await fetchFlagDetail(
		apiKey,
		appKey,
		flagId,
		site,
	);
	const plan = planVariantSync(sourceVariants, existingVariants);

	const variantKeyToId = new Map<string, string>();
	for (const v of existingVariants) variantKeyToId.set(v.key, v.id);
	const sourceKeyToDatadogKey = new Map<string, string>();

	for (const v of plan.toUpdate) {
		await updateVariant(
			apiKey,
			appKey,
			flagId,
			v.id,
			{
				name: v.name,
				value: v.value,
				migrationMetadata: {
					provider,
					source_id: v.sourceId,
					source_key: v.sourceKey,
				},
			},
			site,
		);
		variantKeyToId.set(v.sourceKey, v.id);
		sourceKeyToDatadogKey.set(v.sourceKey, v.key);
	}
	for (const v of plan.toCreate) {
		const sourceKey = v.sourceKey ?? v.key;
		const created = await createVariant(
			apiKey,
			appKey,
			flagId,
			{
				key: v.key,
				name: v.name,
				value: v.value,
				migrationMetadata: {
					provider,
					source_id: v.sourceId,
					source_key: sourceKey,
				},
			},
			site,
		);
		variantKeyToId.set(created.key, created.id);
		variantKeyToId.set(sourceKey, created.id);
		sourceKeyToDatadogKey.set(sourceKey, created.key);
	}

	return {
		variantKeyToId,
		sourceKeyToDatadogKey,
		counts: {
			added: plan.toCreate.length,
			updated: plan.toUpdate.length,
			deleted: plan.toDelete.length,
		},
		pendingDeletes: plan.toDelete,
	};
}

/**
 * Perform variant deletes. MUST run after any allocation rewrites that may
 * have referenced these variants — variants are write-after-references.
 *
 * Failures are intentionally silent — a variant that cannot be deleted (e.g.
 * due to a foreign key constraint) must not mark the flag migration as failed.
 */
export async function applyVariantDeletes(
	apiKey: string,
	appKey: string,
	flagId: string,
	pendingDeletes: PendingVariantDelete[],
	site = 'datadoghq.com',
): Promise<void> {
	for (const v of pendingDeletes) {
		try {
			await deleteVariant(apiKey, appKey, flagId, v.id, site);
		} catch {
			// Variant deletes are best-effort; failure does not affect flag status.
		}
	}
}

/**
 * Convenience wrapper for callers that have no allocation rewrites to
 * interleave: creates+updates first, then deletes.
 */
export async function syncVariants(
	apiKey: string,
	appKey: string,
	flagId: string,
	sourceVariants: SourceVariant[],
	provider: 'launchdarkly' | 'eppo',
	site = 'datadoghq.com',
): Promise<{
	variantKeyToId: Map<string, string>;
	counts: VariantSyncCounts;
}> {
	const { variantKeyToId, counts, pendingDeletes } =
		await syncVariantsCreatesAndUpdates(
			apiKey,
			appKey,
			flagId,
			sourceVariants,
			provider,
			site,
		);
	await applyVariantDeletes(apiKey, appKey, flagId, pendingDeletes, site);
	for (const v of pendingDeletes) variantKeyToId.delete(v.key);
	return { variantKeyToId, counts };
}

export async function syncAllocationsForEnvironment(
	apiKey: string,
	appKey: string,
	flagId: string,
	environmentId: string,
	allocations: DatadogAllocationSyncRequest[],
	site = 'datadoghq.com',
	defaultVariantKey?: string,
	variantKeyToIdAliases?: ReadonlyMap<string, string>,
): Promise<void> {
	const baseUrl = `https://api.${site}`;

	// Fetch flag detail to get existing allocation IDs (so the sync endpoint
	// treats them as updates) and variant key→UUID mapping
	const { variantKeyToId, allocationKeyToIdByEnv } = await fetchFlagDetail(
		apiKey,
		appKey,
		flagId,
		site,
	);
	for (const [key, id] of variantKeyToIdAliases ?? []) {
		variantKeyToId.set(key, id);
	}
	const existingKeyToId =
		allocationKeyToIdByEnv.get(environmentId) ?? new Map<string, string>();

	const unresolvedVariantKeys = new Set<string>();
	const resolveVariantId = (variantKey: string): string => {
		const variantId = variantKeyToId.get(variantKey);
		if (variantId !== undefined) return variantId;
		unresolvedVariantKeys.add(variantKey);
		return variantKey;
	};
	const body = {
		data: allocations.map((alloc) => ({
			type: 'allocations',
			id: existingKeyToId.get(alloc.key) ?? undefined,
			attributes: {
				...alloc,
				variant_weights: alloc.variant_weights.map((vw) => ({
					variant_id: resolveVariantId(vw.variant_key),
					value: vw.value,
				})),
			},
		})),
	};
	if (unresolvedVariantKeys.size > 0) {
		throw new Error(
			`Unable to resolve variant key(s) to Datadog variant UUIDs for flag ${flagId} in environment ${environmentId}: ${[
				...unresolvedVariantKeys,
			].join(', ')}`,
		);
	}
	await ddClient.put(
		`${baseUrl}/api/v2/feature-flags/${flagId}/environments/${environmentId}/allocations`,
		body,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/vnd.api+json',
			},
			...(defaultVariantKey !== undefined
				? { params: { default_variant_key: defaultVariantKey } }
				: {}),
		},
	);
}

// ─── Restriction Policy ───────────────────────────────────────────────────────

/**
 * Fetch the current restriction policy bindings for a feature flag.
 * Returns empty array when no policy exists (404).
 */
export async function fetchRestrictionPolicy(
	apiKey: string,
	appKey: string,
	flagId: string,
	site = 'datadoghq.com',
): Promise<DDRestrictionBinding[]> {
	const baseUrl = `https://api.${site}`;
	try {
		const response = await ddClient.get<{
			data: { attributes: { bindings: DDRestrictionBinding[] } };
		}>(`${baseUrl}/api/v2/restriction_policy/feature-flag:${flagId}`, {
			headers: ddHeaders(apiKey, appKey),
		});
		return response.data.data.attributes.bindings ?? [];
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 404) {
			return [];
		}
		throw err;
	}
}

/**
 * Grant editor access to additional teams on a feature flag's restriction policy.
 * Fetches the existing policy, merges new team IDs into the editor binding,
 * and POSTs the result. No-op if editorTeamIds is empty.
 *
 * Teams are specified as Datadog team UUIDs and converted to "team:<id>"
 * principals (the `type:id` format the restriction policy API expects).
 *
 * POST on a resource with no existing policy creates it (upsert semantics), so
 * the 404→[] path in fetchRestrictionPolicy + a subsequent POST is safe and
 * intentional.
 */
export async function applyRestrictionPolicy(
	apiKey: string,
	appKey: string,
	flagId: string,
	editorTeamIds: string[],
	site = 'datadoghq.com',
): Promise<void> {
	if (editorTeamIds.length === 0) return;

	const baseUrl = `https://api.${site}`;
	const resourceId = `feature-flag:${flagId}`;
	const newPrincipals = editorTeamIds.map((id) => `team:${id}`);

	// GET → merge → POST is not atomic; a concurrent writer between the GET and POST would
	// cause last-writer-wins. Safe for the expected single in-flight sequential migration.
	const existingBindings = await fetchRestrictionPolicy(
		apiKey,
		appKey,
		flagId,
		site,
	);

	// Find the existing editor binding (if any) and merge principals
	const editorBinding = existingBindings.find((b) => b.relation === 'editor');
	const existingPrincipals = editorBinding?.principals ?? [];
	const mergedPrincipals = [
		...new Set([...existingPrincipals, ...newPrincipals]),
	];

	// Keep all non-editor bindings intact; replace (or add) the editor binding
	const otherBindings = existingBindings.filter((b) => b.relation !== 'editor');
	const updatedBindings: DDRestrictionBinding[] = [
		...otherBindings,
		{ principals: mergedPrincipals, relation: 'editor' },
	];

	const body = {
		data: {
			id: resourceId,
			type: 'restriction_policy',
			attributes: { bindings: updatedBindings },
		},
	};

	await ddClient.post(
		`${baseUrl}/api/v2/restriction_policy/${resourceId}`,
		body,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/json',
			},
			params: { allow_self_lockout: true },
		},
	);
}

// ─── Permissions ─────────────────────────────────────────────────────────────

// Read permissions we can verify upfront by hitting their actual API endpoint.
// Write permissions and approvals overrides can't be probed safely, so we let
// runtime errors surface naturally if they're missing.
const PROBABLE_PERMISSIONS: ReadonlyMap<string, string> = new Map([
	['feature_flag_config_read', '/api/v2/feature-flags'],
	[
		'feature_flag_environment_config_read',
		'/api/v2/feature-flags/environments',
	],
	['teams_read', '/api/v2/team'],
]);

async function probePermission(
	url: string,
	apiKey: string,
	appKey: string,
): Promise<boolean> {
	try {
		await ddClient.get(url, { headers: ddHeaders(apiKey, appKey) });
		return true;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 404) {
			// Endpoint reachable but resource absent → permission is present
			return true;
		}
		// 403 = explicitly forbidden; network errors and 5xx → don't assume permission
		return false;
	}
}

export async function fetchCurrentUserPermissions(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<string[]> {
	const baseUrl = `https://api.${site}`;
	const results = await Promise.all(
		[...PROBABLE_PERMISSIONS].map(async ([permission, path]) => {
			const accessible = await probePermission(
				`${baseUrl}${path}`,
				apiKey,
				appKey,
			);
			return { permission, accessible };
		}),
	);
	return results.filter((r) => r.accessible).map((r) => r.permission);
}

// ─── Saved Filters ───────────────────────────────────────────────────────────

export async function createSavedFilter(
	apiKey: string,
	appKey: string,
	request: CreateSavedFilterRequest,
	site = 'datadoghq.com',
): Promise<{ id: string }> {
	const baseUrl = `https://api.${site}`;
	const body = { data: { type: 'saved-filters', attributes: request } };
	const response = await ddClient.post<{ data: { id: string } }>(
		`${baseUrl}/api/v2/feature-flags/saved-filters`,
		body,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/json',
			},
		},
	);
	return { id: response.data.data.id };
}

/**
 * Replace the body of an existing saved filter. Used by re-migration to
 * propagate source-side edits (segment rule changes, audience renames) into
 * the previously-created saved filter without changing its UUID, so allocations
 * that reference it stay valid.
 */
export async function updateSavedFilter(
	apiKey: string,
	appKey: string,
	id: string,
	request: CreateSavedFilterRequest,
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	const body = { data: { type: 'saved-filters', id, attributes: request } };
	await ddClient.put(
		`${baseUrl}/api/v2/feature-flags/saved-filters/${id}`,
		body,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/json',
			},
		},
	);
}

/**
 * List saved filters (paginated). The v2 endpoint does not support filtering
 * by migration_metadata, so results are paged and matched client-side.
 */
export async function listSavedFilters(
	apiKey: string,
	appKey: string,
	opts: {
		search?: string;
		offset?: number;
		include_archived?: boolean;
	} = {},
	site = 'datadoghq.com',
): Promise<{ data: SavedFilterSummary[]; total: number }> {
	const baseUrl = `https://api.${site}`;
	const response = await ddClient.get<{
		data: Array<{
			id: string;
			attributes: {
				name: string;
				migration_metadata?: SavedFilterMigrationMetadata;
			};
		}>;
		meta?: { total?: number };
	}>(`${baseUrl}/api/v2/feature-flags/saved-filters`, {
		headers: ddHeaders(apiKey, appKey),
		params: {
			...(opts.search !== undefined ? { search: opts.search } : {}),
			...(opts.offset !== undefined ? { offset: opts.offset } : {}),
			...(opts.include_archived !== undefined
				? { include_archived: opts.include_archived }
				: {}),
		},
	});

	const data = response.data.data ?? [];
	return {
		data: data.map((item) => ({
			id: item.id,
			name: item.attributes.name,
			migration_metadata: item.attributes.migration_metadata,
		})),
		total: response.data.meta?.total ?? data.length,
	};
}
