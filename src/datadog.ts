import axios, { type AxiosInstance } from 'axios';
import type {
	CreateSavedFilterRequest,
	DatadogAllocationSyncRequest,
	DatadogCreatedFlag,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogFlagEntry,
	MigrationMetadata,
	SavedFilterMigrationMetadata,
	SavedFilterSummary,
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
	meta?: { page?: { total_count?: number } };
};

export async function fetchDatadogFlagKeys(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<Map<string, string>> {
	const baseUrl = `https://api.${site}`;
	const keys = new Map<string, string>();
	let offset = 0;
	const limit = 200;
	while (true) {
		const response = await ddClient.get<JsonApiFlagListResponse>(
			`${baseUrl}/api/v2/feature-flags`,
			{
				headers: ddHeaders(apiKey, appKey),
				params: {
					'page[limit]': limit,
					'page[offset]': offset,
					is_archived: false,
				},
			},
		);
		const flags = response.data.data ?? [];
		const total = response.data.meta?.page?.total_count;
		for (const f of flags) keys.set(f.attributes.key, f.id);
		offset += flags.length;
		if (flags.length < limit || (total !== undefined && offset >= total)) break;
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
	const limit = 200;
	while (true) {
		const response = await ddClient.get<JsonApiFlagListResponse>(
			`${baseUrl}/api/v2/feature-flags`,
			{
				headers: ddHeaders(apiKey, appKey),
				params: {
					'page[limit]': limit,
					'page[offset]': offset,
					is_archived: false,
				},
			},
		);
		const data = response.data.data ?? [];
		const total = response.data.meta?.page?.total_count;
		for (const f of data) {
			allFlags.push({
				id: f.id,
				key: f.attributes.key,
				migration_metadata: f.attributes.migration_metadata,
			});
		}
		offset += data.length;
		if (data.length < limit || (total !== undefined && offset >= total)) break;
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

export interface DatadogTeam {
	id: string;
	handle: string;
	name: string;
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
		variants: Array<{ id: string; key: string }>;
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
	allocationKeyToIdByEnv: Map<string, Map<string, string>>;
}> {
	const baseUrl = `https://api.${site}`;
	const response = await ddClient.get<{ data: JsonApiFlagDetail }>(
		`${baseUrl}/api/v2/feature-flags/${flagId}`,
		{ headers: ddHeaders(apiKey, appKey) },
	);
	const { variants, feature_flag_environments } = response.data.data.attributes;

	const variantKeyToId = new Map<string, string>();
	for (const v of variants ?? []) {
		variantKeyToId.set(v.key, v.id);
	}

	const allocationKeyToIdByEnv = new Map<string, Map<string, string>>();
	for (const env of feature_flag_environments ?? []) {
		const allocKeyToId = new Map<string, string>();
		for (const alloc of env.allocations ?? []) {
			allocKeyToId.set(alloc.key, alloc.id);
		}
		allocationKeyToIdByEnv.set(env.environment_id, allocKeyToId);
	}

	return { variantKeyToId, allocationKeyToIdByEnv };
}

export async function syncAllocationsForEnvironment(
	apiKey: string,
	appKey: string,
	flagId: string,
	environmentId: string,
	allocations: DatadogAllocationSyncRequest[],
	site = 'datadoghq.com',
	defaultVariantKey?: string,
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
	const existingKeyToId =
		allocationKeyToIdByEnv.get(environmentId) ?? new Map<string, string>();

	const body = {
		data: allocations.map((alloc) => ({
			type: 'allocations',
			id: existingKeyToId.get(alloc.key) ?? undefined,
			attributes: {
				...alloc,
				variant_weights: alloc.variant_weights.map((vw) => ({
					variant_id: variantKeyToId.get(vw.variant_key) ?? vw.variant_key,
					value: vw.value,
				})),
			},
		})),
	};
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

export type DDRestrictionBinding = {
	principals: string[];
	relation: string;
};

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

type JsonApiCurrentUserResponse = {
	data: {
		relationships: {
			roles: {
				data: Array<{ id: string }>;
			};
		};
	};
};

type JsonApiRolePermissionsResponse = {
	data: Array<{
		attributes: { name: string };
	}>;
};

export async function fetchCurrentUserPermissions(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<string[]> {
	const baseUrl = `https://api.${site}`;
	const userRes = await ddClient.get<JsonApiCurrentUserResponse>(
		`${baseUrl}/api/v2/current_user`,
		{ headers: ddHeaders(apiKey, appKey) },
	);
	const roles = userRes.data.data.relationships?.roles?.data ?? [];
	const permissionResponses = await Promise.all(
		roles.map((role) =>
			ddClient.get<JsonApiRolePermissionsResponse>(
				`${baseUrl}/api/v2/roles/${role.id}/permissions`,
				{ headers: ddHeaders(apiKey, appKey) },
			),
		),
	);
	const names = permissionResponses.flatMap(
		(r) => r.data.data?.map((p) => p.attributes.name) ?? [],
	);
	return [...new Set(names)];
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
