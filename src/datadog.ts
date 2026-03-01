import axios from "axios";
import type {
	DatadogCreatedFlag,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
} from "./types.js";

const DD_BASE_URL = "https://api.datad0g.com";

function ddHeaders(apiKey: string, appKey: string) {
	return {
		"dd-api-key": apiKey,
		"dd-application-key": appKey,
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
): Promise<DatadogEnvironment[]> {
	const response = await axios.get<{ data: JsonApiEnvironment[] }>(
		`${DD_BASE_URL}/api/unstable/feature-flags/environments`,
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
): Promise<boolean> {
	try {
		await fetchDatadogEnvironments(apiKey, appKey);
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
): Promise<Set<string>> {
	const keys = new Set<string>();
	let offset = 0;
	const limit = 200;
	while (true) {
		const response = await axios.get<{ data: JsonApiFlag[] }>(
			`${DD_BASE_URL}/api/unstable/feature-flags`,
			{
				headers: ddHeaders(apiKey, appKey),
				params: { limit, offset, is_archived: false },
			},
		);
		const flags = response.data.data ?? [];
		for (const f of flags) keys.add(f.attributes.key);
		if (flags.length < limit) break;
		offset += limit;
	}
	return keys;
}

export async function createFeatureFlag(
	apiKey: string,
	appKey: string,
	request: DatadogCreateFlagRequest,
): Promise<DatadogCreatedFlag> {
	const body = { data: { type: "feature-flags", attributes: request } };
	const response = await axios.post<{
		data: { id: string; attributes: { key: string } };
	}>(`${DD_BASE_URL}/api/unstable/feature-flags`, body, {
		headers: {
			...ddHeaders(apiKey, appKey),
			"Content-Type": "application/json",
		},
	});
	return { id: response.data.data.id, key: response.data.data.attributes.key };
}

export async function enableFeatureFlagEnvironment(
	apiKey: string,
	appKey: string,
	flagId: string,
	environmentId: string,
): Promise<void> {
	await axios.post(
		`${DD_BASE_URL}/api/unstable/feature-flags/${flagId}/environments/${environmentId}/enable`,
		{},
		{
			headers: {
				...ddHeaders(apiKey, appKey),
				"Content-Type": "application/json",
			},
		},
	);
}
