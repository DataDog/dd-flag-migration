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

export interface MigrationMetadata {
	project_key: string;
	flag_key: string;
	key_prefix?: string;
}

export interface DatadogFlagEntry {
	id: string;
	key: string;
	migration_metadata?: MigrationMetadata;
}

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
	launchdarklySDKKeys?: Record<string, string>;
}

export interface MigrationEnvironmentMapping {
	sourceEnvId: number | string;
	sourceEnvName: string;
	datadogEnvId: string;
	datadogEnvName: string;
	datadogDdEnvNames?: string[];
}

export interface DatadogCondition {
	// Inline shape — all three present when saved_filter_id is absent
	operator?: string;
	attribute?: string;
	value?: string[];
	// SF-ref shape — present alone when this condition references a saved filter
	saved_filter_id?: string;
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
	migration_metadata?: MigrationMetadata;
	tags?: string[];
}

export interface DatadogCreatedFlag {
	id: string;
	key: string;
}

export interface SavedFilterMigrationMetadata {
	provider: 'launchdarkly';
	project_key: string;
	segment_key: string;
	environment_key: string;
	negated: boolean;
	name_prefix?: string;
}

export interface SavedFilterSummary {
	id: string;
	name: string;
	migration_metadata?: SavedFilterMigrationMetadata;
}

export interface CreateSavedFilterRequest {
	name: string;
	description?: string;
	creation_type: 'RULES' | 'LIST';
	targeting_rules: DatadogTargetingRule[];
	migration_metadata?: SavedFilterMigrationMetadata;
}

// ─── Evaluation Types ────────────────────────────────────────────────────────

export type SubjectAttributes = Record<
	string,
	string | number | boolean | null
>;

export interface TestCase {
	label: string;
	attributes: SubjectAttributes;
	subjectIdOverride?: string;
}

export type DDFlagValue = { variationValue: unknown; variationType: string };

export type DDStatus = 'assigned' | 'not-assigned' | 'not-in-dd';

export interface EvaluationResult {
	providerResult: string;
	ddResult: string;
	ddStatus: DDStatus;
	error?: string;
}

// ─── Evaluation Export Types ─────────────────────────────────────────────────

export interface EvaluationExportRow {
	flagKey: string;
	flagName: string;
	team: string;
	testCaseLabel: string;
	providerResult: string;
	ddResult: string;
	match: boolean;
	ddStatus: 'assigned' | 'not-assigned' | 'not-in-dd';
	migrationStatus:
		| 'created'
		| 'partial'
		| 'failed'
		| 'skipped'
		| 'unknown'
		| 'not-in-migration-file';
	ddEnabled: boolean | null;
	error?: string;
	// new fields for advanced evaluation
	inMigrationFile: boolean;
	providerStatus: 'found' | 'not-found' | 'error' | 'not-evaluated';
	ddMigrationMetadata?: MigrationMetadata;
}
