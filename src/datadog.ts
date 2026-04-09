import axios from 'axios';
import type {
	DatadogAllocationSyncRequest,
	DatadogCreatedFlag,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
} from './types.js';

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
	const response = await axios.get<{ data: JsonApiEnvironment[] }>(
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

export async function validateDatadogKeys(
	apiKey: string,
	appKey: string,
	site = 'datadoghq.com',
): Promise<boolean> {
	try {
		await fetchDatadogEnvironments(apiKey, appKey, site);
		return true;
	} catch {
		return false;
	}
}

// Local type for JSON:API flag list response
type JsonApiFlag = {
	id: string;
	type: string;
	attributes: { key: string; name: string };
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
		const response = await axios.get<{ data: JsonApiFlag[] }>(
			`${baseUrl}/api/v2/feature-flags`,
			{
				headers: ddHeaders(apiKey, appKey),
				params: { limit, offset, is_archived: false },
			},
		);
		const flags = response.data.data ?? [];
		for (const f of flags) keys.set(f.attributes.key, f.id);
		if (flags.length < limit) break;
		offset += limit;
	}
	return keys;
}

export async function createFeatureFlag(
	apiKey: string,
	appKey: string,
	request: DatadogCreateFlagRequest,
	site = 'datadoghq.com',
): Promise<DatadogCreatedFlag> {
	const baseUrl = `https://api.${site}`;
	const body = { data: { type: 'feature-flags', attributes: request } };
	const response = await axios.post<{
		data: { id: string; attributes: { key: string } };
	}>(`${baseUrl}/api/v2/feature-flags`, body, {
		headers: {
			...ddHeaders(apiKey, appKey),
			'Content-Type': 'application/json',
		},
	});
	return { id: response.data.data.id, key: response.data.data.attributes.key };
}

export async function enableFeatureFlagEnvironment(
	apiKey: string,
	appKey: string,
	flagId: string,
	environmentId: string,
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	await axios.post(
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
	const response = await axios.get<{ data: JsonApiFlagDetail }>(
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
	await axios.put(
		`${baseUrl}/api/v2/feature-flags/${flagId}/environments/${environmentId}/allocations`,
		body,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/vnd.api+json',
			},
		},
	);
}
