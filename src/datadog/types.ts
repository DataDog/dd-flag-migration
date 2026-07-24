// ─── Core API Types ──────────────────────────────────────────────────────────

export interface MigrationMetadata {
	project_key?: string;
	flag_key?: string;
	key_prefix?: string;
	provider?: 'launchdarkly' | 'eppo';
	source_id?: string;
	source_key?: string;
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
	distribution_channel?: 'CLIENT' | 'SERVER' | 'BOTH';
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

export type SavedFilterMigrationMetadata =
	| LDSavedFilterMigrationMetadata
	| EppoSavedFilterMigrationMetadata;

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
	provider: 'launchdarkly' | 'eppo';
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
