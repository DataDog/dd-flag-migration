import type { MigrationEnvironmentMapping } from '../datadog/types.js';
import type { DatadogSavedFilterMigrationStats } from './saved-filters.js';

export interface DatadogMigrationFlagRecord {
	/** Flag UUID in the source org. */
	id: string;
	key: string;
	name: string;
}

export interface DatadogMigrationFile {
	provider: 'datadog';
	sourceSite: string;
	targetSite: string;
	migratedAt: string;
	success: boolean;
	summary: {
		created: number;
		synced: number;
		skipped: number;
		errored: number;
		enabled: number;
		disabled: number;
	};
	failures: Array<{ key: string; error: string }>;
	enableFailures: Array<{ key: string; env: string; error: string }>;
	disableFailures: Array<{ key: string; env: string; error: string }>;
	disableApprovalRequests: Array<{ key: string; env: string }>;
	skippedFlags?: Array<{ key: string; reason: string }>;
	/** Keys of flags that already existed in the target org and were synced. */
	syncedFlagKeys?: string[];
	savedFilterMigration?: DatadogSavedFilterMigrationStats;
	flags: DatadogMigrationFlagRecord[];
	environmentMapping: MigrationEnvironmentMapping[];
}

export interface DatadogDryRunFile extends DatadogMigrationFile {
	requests: Array<{ method: string; path: string; body: unknown }>;
}
