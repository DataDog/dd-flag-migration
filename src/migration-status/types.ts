import type {
	DatadogEnvironment,
	DatadogStatusFlagDetail,
	EnvironmentMapping,
} from '../datadog/types.js';
import type { LDEnvironment, LDFlag } from '../launchdarkly/types.js';

export type FlagMigrationStatus =
	| 'not-yet-migrated'
	| 'partially-migrated'
	| 'out-of-sync'
	| 'in-sync'
	| 'needs-review';

export type EnvironmentMigrationStatus =
	| 'not-migrated'
	| 'out-of-sync'
	| 'in-sync'
	| 'could-not-verify';

export type ChangeKind =
	| 'enablement'
	| 'default'
	| 'targeting'
	| 'variants'
	| 'name'
	| 'identity'
	| 'collection';

export interface EnvironmentStatusResult {
	sourceEnvironmentKey: string;
	sourceEnvironmentName: string;
	datadogEnvironmentId: string;
	datadogEnvironmentName: string;
	status: EnvironmentMigrationStatus;
	changes: ChangeKind[];
	details: string;
}

export interface FlagStatusResult {
	flagKey: string;
	flagName: string;
	datadogFlagKey?: string;
	status: FlagMigrationStatus;
	flagWideChanges: ChangeKind[];
	flagWideDetails: string[];
	environments: EnvironmentStatusResult[];
	details?: string;
}

export interface MigrationStatusMapping {
	sourceEnvironmentKey: string;
	sourceEnvironmentName: string;
	datadogEnvironmentId: string;
	datadogEnvironmentName: string;
}

export interface MigrationStatusResult {
	projectKey: string;
	projectName: string;
	generatedAt: Date;
	mappings: MigrationStatusMapping[];
	flags: FlagStatusResult[];
	limitations: string[];
}

export interface MigrationStatusComparisonInput {
	projectKey: string;
	projectName: string;
	sourceFlags: LDFlag[];
	sourceDetailErrors: ReadonlyMap<string, string>;
	datadogFlags: Array<{
		id: string;
		key: string;
		migration_metadata?: {
			project_key?: string;
			flag_key?: string;
		};
	}>;
	datadogDetails: ReadonlyMap<string, DatadogStatusFlagDetail>;
	datadogDetailErrors: ReadonlyMap<string, string>;
	selectedSourceEnvironments: LDEnvironment[];
	environmentMapping: EnvironmentMapping<string>;
	savedFilterLookup?: ReadonlyMap<string, string>;
}

export interface LinkedFlag {
	source: LDFlag;
	datadog?: MigrationStatusComparisonInput['datadogFlags'][number];
	identityProblem?: string;
}

export interface DetailCollectionInput {
	flags: LinkedFlag[];
	datadogEnvironments: DatadogEnvironment[];
}
