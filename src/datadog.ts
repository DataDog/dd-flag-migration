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

export async function syncAllocationsForEnvironment(
	apiKey: string,
	appKey: string,
	flagId: string,
	environmentId: string,
	allocations: DatadogAllocationSyncRequest[],
	site = 'datadoghq.com',
): Promise<void> {
	const baseUrl = `https://api.${site}`;
	await axios.put(
		`${baseUrl}/api/v2/feature-flags/${flagId}/environments/${environmentId}/allocations`,
		allocations,
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				'Content-Type': 'application/json',
			},
		},
	);
}
