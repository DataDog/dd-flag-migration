// ─── Core API Types ──────────────────────────────────────────────────────────

export interface MigrationMetadata {
	project_key?: string;
	flag_key?: string;
	key_prefix?: string;
	provider?: 'launchdarkly' | 'eppo' | 'datadog';
	source_id?: string;
	source_key?: string;
	/** Datadog site of the source org for Datadog-to-Datadog migrations. */
	source_site?: string;
}

export type DatadogEnvironmentStatus = 'ENABLED' | 'DISABLED';

/**
 * Subject bucketing scheme of a Datadog flag. `EPPO` reproduces Eppo's
 * bucketing so subjects keep their assignments; it is set only when the Eppo
 * migration creates a flag and can never change afterwards.
 */
export type BucketingMode = 'DATADOG' | 'EPPO';

export interface DatadogFlagEntry {
	id: string;
	key: string;
	name?: string;
	tags?: string[];
	archived_at?: string | null;
	migration_metadata?: MigrationMetadata;
	/** Absent when the Datadog API predates bucketing modes (treat as `DATADOG`). */
	bucketing_mode?: BucketingMode;
	environmentStatuses?: Map<string, DatadogEnvironmentStatus>;
}

/** Complete read model used by migration status comparisons. */
export interface DatadogStatusAllocation {
	id?: string;
	key: string;
	name?: string;
	type?: string;
	status?: string;
	order_position?: number;
	experiment_id?: string | null;
	exposure_schedule?: unknown;
	eppo_allocation_id?: number;
	targeting_rules?: Array<{
		conditions?: Array<{
			operator?: string;
			attribute?: string;
			value?: unknown;
			saved_filter_id?: string;
		}>;
	}>;
	variant_weights?: Array<{
		variant_id?: string;
		variant_key?: string;
		value: number;
		eppo_variant_weight_id?: number;
	}>;
}

export interface DatadogStatusFlagDetail {
	id: string;
	bucketingMode?: BucketingMode;
	key: string;
	name: string;
	description?: string;
	valueType?: string;
	distributionChannel?: string;
	jsonSchema?: string;
	tags?: string[];
	migrationMetadata?: MigrationMetadata;
	variants: DatadogVariantDetail[];
	environments: Array<{
		environmentId: string;
		status: DatadogEnvironmentStatus;
		defaultVariantKey?: string;
		/** Variant served to every subject regardless of targeting, when set. */
		overrideVariantKey?: string;
		allocations: DatadogStatusAllocation[] | null;
	}>;
}

export interface DatadogEnvironment {
	id: string;
	name: string;
	is_production: boolean;
	queries: string[];
}

export type EnvironmentMapping<SourceEnvironmentId extends string | number> =
	Map<SourceEnvironmentId, DatadogEnvironment[]>;

/** Accepts legacy single-target maps while callers move to one-to-many mappings. */
export type EnvironmentMappingInput<
	SourceEnvironmentId extends string | number,
> = ReadonlyMap<SourceEnvironmentId, DatadogEnvironment | DatadogEnvironment[]>;

export function mappedDatadogEnvironments(
	value: DatadogEnvironment | DatadogEnvironment[],
): DatadogEnvironment[] {
	return Array.isArray(value) ? value : [value];
}

export interface Config {
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

export interface DatadogVariantWeightRequest {
	variant_key: string;
	value: number;
	/** Source Eppo `variation_weights.id`; accepted only on `EPPO` flags. */
	eppo_variant_weight_id?: number;
}

/**
 * A single-step exposure schedule. The Eppo migration sends one that starts
 * immediately to carry over an allocation's partial exposure.
 */
export interface DatadogExposureScheduleRequest {
	rollout_options: {
		strategy: 'NO_ROLLOUT';
		scheduled_start: 'now';
	};
	rollout_steps: Array<{
		exposure_ratio: number;
		interval_ms: null;
		is_pause_record: false;
		grouped_step_index: number;
	}>;
}

export interface DatadogAllocationForFlagCreation {
	environment_id: string;
	name: string;
	key: string;
	type: 'FEATURE_GATE';
	variant_weights: DatadogVariantWeightRequest[];
	targeting_rules?: DatadogTargetingRule[];
	exposure_schedule?: DatadogExposureScheduleRequest;
	/** Source Eppo `allocations.id`; accepted only on `EPPO` flags. */
	eppo_allocation_id?: number;
}

export type DatadogAllocationSyncRequest = Omit<
	DatadogAllocationForFlagCreation,
	'environment_id'
>;

export interface DatadogCreateFlagRequest {
	key: string;
	name: string;
	description?: string;
	value_type: 'BOOLEAN' | 'INTEGER' | 'NUMERIC' | 'STRING' | 'JSON';
	json_schema?: string;
	variants: Array<{
		key: string;
		name: string;
		value: string;
		migration_metadata?: VariantMigrationMetadata;
	}>;
	allocations?: DatadogAllocationForFlagCreation[];
	migration_metadata?: MigrationMetadata;
	tags?: string[];
	distribution_channel?: 'CLIENT' | 'SERVER' | 'BOTH' | 'ALL';
	/** Defaults to `DATADOG`. `EPPO` flags may be created without `default_variant_key`. */
	bucketing_mode?: BucketingMode;
	/** Default variant applied to every environment when the flag is created. */
	default_variant_key?: string;
}

export interface DatadogCreatedFlag {
	id: string;
	key: string;
}

export interface LDSavedFilterMigrationMetadata {
	provider: 'launchdarkly';
	project_key: string;
	segment_key: string;
	environment_key: string;
	negated: boolean;
	name_prefix?: string;
}

export interface EppoSavedFilterMigrationMetadata {
	provider: 'eppo';
	audience_id: number;
}

export interface DatadogSavedFilterMigrationMetadata {
	provider: 'datadog';
	/** Saved filter UUID in the source org. */
	source_id: string;
	source_site: string;
	name_prefix?: string;
}

export type SavedFilterMigrationMetadata =
	| LDSavedFilterMigrationMetadata
	| EppoSavedFilterMigrationMetadata
	| DatadogSavedFilterMigrationMetadata;

export interface SavedFilterSummary {
	id: string;
	name: string;
	migration_metadata?: SavedFilterMigrationMetadata;
	/** Present only when listed with `include_rules` or fetched individually. */
	description?: string;
	creation_type?: 'RULES' | 'LIST';
	targeting_rules?: DatadogTargetingRule[];
}

export interface CreateSavedFilterRequest {
	name: string;
	description?: string;
	creation_type: 'RULES' | 'LIST';
	targeting_rules: DatadogTargetingRule[];
	migration_metadata?: SavedFilterMigrationMetadata;
}

// ─── Variant Types ────────────────────────────────────────────────────────────

export interface DatadogTeam {
	id: string;
	handle: string;
	name: string;
}

export interface DatadogVariantDetail {
	id: string;
	key: string;
	name: string;
	value: string;
	migration_metadata?: Record<string, unknown>;
}

export interface VariantMigrationMetadata {
	provider: 'launchdarkly' | 'eppo' | 'datadog';
	/** Stable identifier from the source variation — survives rename. */
	source_id: string;
	/** Slugified source key at migration time — useful for debugging drift. */
	source_key: string;
}

export interface SourceVariant {
	key: string;
	name: string;
	value: string;
	/** Stable identifier from the source platform's variation. Required so the
	 * diff can survive renames of the variation name (which feeds `key`). */
	sourceId: string;
}

export interface VariantSyncCounts {
	added: number;
	updated: number;
	deleted: number;
}

export interface VariantSyncPlan {
	toCreate: Array<SourceVariant & { sourceKey?: string }>;
	/**
	 * Updates carry the **existing DD key** (immutable on the backend — only
	 * name/value/migration_metadata are updatable per the variant DTO). When a
	 * rename is matched by `source_id`, `key` here is the DD-side key and may
	 * drift from `sourceKey` (the new slugified source key). UUID stability is
	 * what matters: allocations reference variants by UUID, not by key.
	 */
	toUpdate: Array<{
		id: string;
		/** Existing DD key — never changes (variant key is immutable). */
		key: string;
		name: string;
		value: string;
		/** Stable source identifier — propagated into migration_metadata. */
		sourceId: string;
		/** Current slugified source key — propagated into migration_metadata
		 * for traceability even though the DD key itself stays the same. */
		sourceKey: string;
	}>;
	toDelete: Array<{ id: string; key: string }>;
}

export interface PendingVariantDelete {
	id: string;
	key: string;
}

// ─── Restriction Policy Types ─────────────────────────────────────────────────

export type DDRestrictionBinding = {
	principals: string[];
	relation: string;
};

export type RestrictionPolicyTeamAction = 'add' | 'remove';

export type RestrictionPolicyTeamRelation = 'editor' | 'contributor';

export interface RestrictionPolicyTeamUpdateResult {
	changedTeamIds: string[];
	unchangedTeamIds: string[];
}

// ─── Pagination Types ─────────────────────────────────────────────────────────

export type FeatureFlagPageMeta = {
	meta?: {
		page?: {
			total?: number;
			total_count?: number;
			total_filtered_count?: number;
			next_offset?: number | null;
		};
	};
};
