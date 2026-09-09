import { updateFlagDistributionChannel } from '../datadog/api.js';
import type { DatadogDistributionChannel } from '../datadog/types.js';
import { formatAxiosError } from './format-axios-error.js';

export interface DistributionChannelSyncItem {
	sourceKey: string;
	datadogKey: string;
	datadogFlagId: string;
	currentChannel?: DatadogDistributionChannel;
}

export type DistributionChannelSyncStatus = 'updated' | 'unchanged' | 'failed';

export interface DistributionChannelSyncOutcome
	extends DistributionChannelSyncItem {
	targetChannel: DatadogDistributionChannel;
	status: DistributionChannelSyncStatus;
	error?: string;
}

export interface DistributionChannelSyncSummary {
	targetChannel: DatadogDistributionChannel;
	dryRun: boolean;
	updated: number;
	unchanged: number;
	failed: number;
	results: DistributionChannelSyncOutcome[];
}

interface ExecuteDistributionChannelSyncOptions {
	onProgress?: (
		index: number,
		total: number,
		item: DistributionChannelSyncItem,
	) => void;
	update?: typeof updateFlagDistributionChannel;
}

export async function executeDistributionChannelSync(
	items: DistributionChannelSyncItem[],
	targetChannel: DatadogDistributionChannel,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
	options: ExecuteDistributionChannelSyncOptions = {},
): Promise<DistributionChannelSyncSummary> {
	const { onProgress, update = updateFlagDistributionChannel } = options;
	const results: DistributionChannelSyncOutcome[] = [];
	let updated = 0;
	let unchanged = 0;
	let failed = 0;

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		onProgress?.(index + 1, items.length, item);

		if (item.currentChannel === targetChannel) {
			results.push({ ...item, targetChannel, status: 'unchanged' });
			unchanged++;
			continue;
		}

		if (dryRun) {
			results.push({ ...item, targetChannel, status: 'updated' });
			updated++;
			continue;
		}

		try {
			await update(
				ddApiKey,
				ddAppKey,
				item.datadogFlagId,
				targetChannel,
				ddSite,
			);
			results.push({ ...item, targetChannel, status: 'updated' });
			updated++;
		} catch (error) {
			results.push({
				...item,
				targetChannel,
				status: 'failed',
				error: formatAxiosError(error),
			});
			failed++;
		}
	}

	return {
		targetChannel,
		dryRun,
		updated,
		unchanged,
		failed,
		results,
	};
}
