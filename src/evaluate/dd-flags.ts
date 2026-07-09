import axios from 'axios';
import { ddClient } from '../datadog/api.js';
import {
	FEATURE_FLAG_PAGE_LIMIT,
	nextFeatureFlagOffset,
} from '../datadog/helpers.js';
import type { MigrationMetadata } from '../datadog/types.js';

type DDFlagListItem = {
	attributes: {
		key: string;
		value_type?: string;
		migration_metadata?: MigrationMetadata;
		feature_flag_environments?: Array<{
			environment_id: string;
			status: 'ENABLED' | 'DISABLED';
		}>;
	};
};

type DDFlagListResponse = {
	data: DDFlagListItem[];
	meta?: {
		page?: {
			total?: number;
			total_count?: number;
			total_filtered_count?: number;
			next_offset?: number | null;
		};
	};
};

export async function fetchDDFlagData(
	apiKey: string,
	appKey: string,
	site: string,
	envId: string,
): Promise<{
	keys: Set<string>;
	enabledByKey: Map<string, boolean>;
	valueTypeByKey: Map<string, string>;
	migrationMetadataByKey: Map<string, MigrationMetadata>;
}> {
	const baseUrl = `https://api.${site}`;
	const keys = new Set<string>();
	const enabledByKey = new Map<string, boolean>();
	const valueTypeByKey = new Map<string, string>();
	const migrationMetadataByKey = new Map<string, MigrationMetadata>();
	let offset = 0;
	try {
		while (true) {
			const resp = await ddClient.get<DDFlagListResponse>(
				`${baseUrl}/api/v2/feature-flags`,
				{
					headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
					params: {
						limit: FEATURE_FLAG_PAGE_LIMIT,
						offset,
						is_archived: false,
					},
				},
			);
			const flags = resp.data.data ?? [];
			for (const f of flags) {
				keys.add(f.attributes.key);
				const envEntry = (f.attributes.feature_flag_environments ?? []).find(
					(e) => e.environment_id === envId,
				);
				if (envEntry !== undefined)
					enabledByKey.set(f.attributes.key, envEntry.status === 'ENABLED');
				if (f.attributes.value_type)
					valueTypeByKey.set(f.attributes.key, f.attributes.value_type);
				if (f.attributes.migration_metadata)
					migrationMetadataByKey.set(
						f.attributes.key,
						f.attributes.migration_metadata,
					);
			}
			const nextOffset = nextFeatureFlagOffset(resp.data, offset, flags.length);
			if (nextOffset === undefined) break;
			offset = nextOffset;
		}
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			throw new Error(
				'Datadog API returned 403 Forbidden when fetching feature flags.\n' +
					'  Please check that:\n' +
					'  • Your Datadog API key and Application key are valid\n' +
					'  • Your Application key has permission to read feature flags',
			);
		}
		if (axios.isAxiosError(err) && err.response?.status === 401) {
			throw new Error(
				'Datadog API returned 401 Unauthorized.\n' +
					'  Your API key or Application key is invalid.',
			);
		}
		throw err;
	}
	return { keys, enabledByKey, valueTypeByKey, migrationMetadataByKey };
}
