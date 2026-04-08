// ─── Re-export Eppo types for backward compatibility ─────────────────────────

export type {
	DryRunFile,
	EppoAllocation,
	EppoCondition,
	EppoFlag,
	EppoFlagEnvironment,
	EppoFlagVariation,
	EppoTargetingRule,
	EppoVariationWeight,
	MigrationEnvFailure,
	MigrationFile,
	MigrationFlagFailure,
} from './eppo/types.js';

// ─── Datadog Types ───────────────────────────────────────────────────────────

export interface DatadogEnvironment {
	id: string;
	name: string;
	is_production: boolean;
	queries: string[];
}

export interface Config {
	eppoApiKey?: string;
	eppoSdkKeys?: Record<string, string>;
	launchdarklyApiKey?: string;
	datadogApiKey?: string;
	datadogAppKey?: string;
	datadogClientToken?: string;
	datadogSite?: string;
}

export interface MigrationEnvironmentMapping {
	sourceEnvId: number | string;
	sourceEnvName: string;
	datadogEnvId: string;
	datadogEnvName: string;
	datadogDdEnvNames?: string[];
}

export interface DatadogCondition {
	operator: string;
	attribute: string;
	value: string[];
}

export interface DatadogTargetingRule {
	conditions: DatadogCondition[];
}

export interface DatadogAllocationForFlagCreation {
	environment_id: string;
	name: string;
	key: string;
	type: 'FEATURE_GATE';
	variant_weights: Array<{ variant_key: string; value: number }>;
	targeting_rules?: DatadogTargetingRule[];
}

export type DatadogAllocationSyncRequest = Omit<
	DatadogAllocationForFlagCreation,
	'environment_id'
>;

export interface DatadogCreateFlagRequest {
	key: string;
	name: string;
	value_type: 'BOOLEAN' | 'INTEGER' | 'NUMERIC' | 'STRING' | 'JSON';
	variants: Array<{ key: string; name: string; value: string }>;
	allocations?: DatadogAllocationForFlagCreation[];
}

export interface DatadogCreatedFlag {
	id: string;
	key: string;
}

// ─── Evaluation Export Types ─────────────────────────────────────────────────

export interface EvaluationExportRow {
	flagKey: string;
	flagName: string;
	team: string;
	testCaseLabel: string;
	eppoResult: string;
	ddResult: string;
	match: boolean;
	ddStatus: 'assigned' | 'not-assigned' | 'not-in-dd';
	migrationStatus: 'created' | 'partial' | 'failed' | 'skipped' | 'unknown';
	ddEnabled: boolean | null;
	error?: string;
}
