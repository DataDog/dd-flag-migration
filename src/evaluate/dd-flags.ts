import axios from 'axios';
import { ddClient } from '../datadog/api.js';
import {
	FEATURE_FLAG_PAGE_LIMIT,
	nextFeatureFlagOffset,
} from '../datadog/helpers.js';
import type { BucketingMode, MigrationMetadata } from '../datadog/types.js';

type DDFlagListItem = {
	attributes: {
		key: string;
		name?: string;
		value_type?: string;
		migration_metadata?: MigrationMetadata;
		distribution_channel?: string;
		bucketing_mode?: BucketingMode;
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

export type DDFlagData = {
	keys: Set<string>;
	nameByKey: Map<string, string>;
	enabledByKey: Map<string, boolean>;
	valueTypeByKey: Map<string, string>;
	migrationMetadataByKey: Map<string, MigrationMetadata>;
	distributionChannelByKey: Map<string, string>;
	bucketingModeByKey: Map<string, BucketingMode>;
};

export async function fetchDDFlagData(
	apiKey: string,
	appKey: string,
	site: string,
	/** Omit to skip per-environment status. */
	envId?: string,
): Promise<DDFlagData> {
	const baseUrl = `https://api.${site}`;
	const keys = new Set<string>();
	const nameByKey = new Map<string, string>();
	const enabledByKey = new Map<string, boolean>();
	const valueTypeByKey = new Map<string, string>();
	const migrationMetadataByKey = new Map<string, MigrationMetadata>();
	const distributionChannelByKey = new Map<string, string>();
	const bucketingModeByKey = new Map<string, BucketingMode>();
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
				if (f.attributes.name)
					nameByKey.set(f.attributes.key, f.attributes.name);
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
				if (f.attributes.distribution_channel)
					distributionChannelByKey.set(
						f.attributes.key,
						f.attributes.distribution_channel,
					);
				if (f.attributes.bucketing_mode)
					bucketingModeByKey.set(f.attributes.key, f.attributes.bucketing_mode);
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
	return {
		keys,
		nameByKey,
		enabledByKey,
		valueTypeByKey,
		migrationMetadataByKey,
		distributionChannelByKey,
		bucketingModeByKey,
	};
}

export type MigratedFlag = {
	datadogKey: string;
	eppoKey: string;
	/** Eppo flag ID recorded by the migration, when present. */
	eppoId: string | undefined;
	name: string | undefined;
};

/** Datadog flags whose migration metadata says they came from Eppo. */
export function migratedEppoFlags(
	flagData: Pick<DDFlagData, 'keys' | 'migrationMetadataByKey' | 'nameByKey'>,
): MigratedFlag[] {
	const flags: MigratedFlag[] = [];
	for (const key of flagData.keys) {
		const metadata = flagData.migrationMetadataByKey.get(key);
		if (metadata?.provider !== 'eppo') continue;
		flags.push({
			datadogKey: key,
			eppoKey: metadata.source_key ?? key,
			eppoId: metadata.source_id,
			name: flagData.nameByKey.get(key),
		});
	}
	return flags.sort((a, b) => a.datadogKey.localeCompare(b.datadogKey));
}
