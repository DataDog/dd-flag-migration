import type { FeatureFlagEnvironmentEnableOutcome } from '../datadog/api.js';
import type { DatadogEnvironment, DatadogFlagEntry } from '../datadog/types.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import type { BulkEnableResult } from './types.js';

export interface BulkEnablePairProgress {
	flag: DatadogFlagEntry;
	environment: DatadogEnvironment;
	index: number;
	total: number;
}

export interface BulkEnableOperations {
	fetchStatuses: (
		flag: DatadogFlagEntry,
	) => Promise<Map<string, 'ENABLED' | 'DISABLED'>>;
	enable: (
		flag: DatadogFlagEntry,
		environment: DatadogEnvironment,
	) => Promise<FeatureFlagEnvironmentEnableOutcome>;
	onProgress?: (progress: BulkEnablePairProgress) => void;
}

function resultForEnvironment(
	flag: DatadogFlagEntry,
	environment: DatadogEnvironment,
	status: BulkEnableResult['status'],
	statusLookupError?: string,
	error?: string,
): BulkEnableResult {
	return {
		flagId: flag.id,
		flagKey: flag.key,
		flagTags: flag.tags ?? [],
		environmentId: environment.id,
		environmentName: environment.name,
		isProduction: environment.is_production,
		status,
		...(statusLookupError ? { statusLookupError } : {}),
		...(error ? { error } : {}),
	};
}

export async function processBulkEnablePairs(
	flags: DatadogFlagEntry[],
	environments: DatadogEnvironment[],
	operations: BulkEnableOperations,
): Promise<BulkEnableResult[]> {
	const results: BulkEnableResult[] = [];
	const total = flags.length * environments.length;
	let index = 0;

	for (const flag of flags) {
		// The list endpoint normally includes these statuses, so reuse that
		// snapshot instead of issuing one detail request per selected flag.
		// Older or partial API responses fall back to the detail endpoint.
		let currentStatuses =
			flag.environmentStatuses ?? new Map<string, 'ENABLED' | 'DISABLED'>();
		let statusLookupError: string | undefined;
		if (flag.environmentStatuses === undefined) {
			try {
				currentStatuses = await operations.fetchStatuses(flag);
			} catch (error) {
				statusLookupError = formatAxiosError(error);
			}
		}

		for (const environment of environments) {
			index++;
			operations.onProgress?.({ flag, environment, index, total });

			if (currentStatuses.get(environment.id) === 'ENABLED') {
				results.push(
					resultForEnvironment(flag, environment, 'Already enabled'),
				);
				continue;
			}

			try {
				const outcome = await operations.enable(flag, environment);
				const status =
					outcome === 'approval_requested'
						? statusLookupError
							? 'Approval requested (prior status unknown)'
							: 'Approval requested'
						: statusLookupError
							? 'Enabled (prior status unknown)'
							: 'Enabled';
				results.push(
					resultForEnvironment(flag, environment, status, statusLookupError),
				);
			} catch (error) {
				results.push(
					resultForEnvironment(
						flag,
						environment,
						'Failed',
						statusLookupError,
						formatAxiosError(error),
					),
				);
			}
		}
	}

	return results;
}
