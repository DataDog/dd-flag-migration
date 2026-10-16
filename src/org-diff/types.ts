import type {
	DatadogFlagEntry,
	DatadogStatusFlagDetail,
} from '../datadog/types.js';

export type OrgDiffFlagStatus =
	| 'only-in-source'
	| 'only-in-target'
	| 'differs'
	| 'in-sync'
	| 'needs-review';

export type OrgDiffEnvironmentStatus =
	| 'differs'
	| 'in-sync'
	| 'could-not-verify';

export type OrgDiffChangeKind =
	| 'name'
	| 'description'
	| 'value-type'
	| 'json-schema'
	| 'distribution-channel'
	| 'tags'
	| 'variants'
	| 'enablement'
	| 'default'
	| 'override'
	| 'targeting'
	| 'collection';

export interface OrgDiffEnvironmentPair {
	sourceEnvironmentId: string;
	sourceEnvironmentName: string;
	targetEnvironmentId: string;
	targetEnvironmentName: string;
}

export interface OrgDiffEnvironmentResult extends OrgDiffEnvironmentPair {
	status: OrgDiffEnvironmentStatus;
	changes: OrgDiffChangeKind[];
	details: string;
}

export interface OrgDiffFlagResult {
	flagKey: string;
	flagName: string;
	sourceFlagId?: string;
	targetFlagId?: string;
	status: OrgDiffFlagStatus;
	flagWideChanges: OrgDiffChangeKind[];
	flagWideDetails: string[];
	environments: OrgDiffEnvironmentResult[];
	details?: string;
}

export interface OrgDiffResult {
	sourceSite: string;
	targetSite: string;
	generatedAt: Date;
	environmentPairs: OrgDiffEnvironmentPair[];
	flags: OrgDiffFlagResult[];
	limitations: string[];
}

export interface OrgFlagLink {
	key: string;
	source?: DatadogFlagEntry;
	target?: DatadogFlagEntry;
}

export interface OrgDiffInput {
	sourceSite: string;
	targetSite: string;
	sourceFlags: DatadogFlagEntry[];
	targetFlags: DatadogFlagEntry[];
	sourceDetails: ReadonlyMap<string, DatadogStatusFlagDetail>;
	targetDetails: ReadonlyMap<string, DatadogStatusFlagDetail>;
	sourceDetailErrors: ReadonlyMap<string, string>;
	targetDetailErrors: ReadonlyMap<string, string>;
	environmentPairs: OrgDiffEnvironmentPair[];
	/** Source saved filter UUID → linked target saved filter UUID. */
	savedFilterLinks?: ReadonlyMap<string, string>;
}
