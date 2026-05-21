// ─── Eppo Audience Types ─────────────────────────────────────────────────────

export interface EppoAudienceCondition {
	operator: string;
	attribute: string;
	values: string[];
}

export interface EppoAudienceTargetingRule {
	id: number;
	conditions: EppoAudienceCondition[];
}

export interface EppoAudience {
	id: number;
	name: string;
	description: string;
	targeting_rules: EppoAudienceTargetingRule[];
	is_archived: boolean;
}

// ─── Eppo Types ──────────────────────────────────────────────────────────────

export interface EppoFlagVariation {
	id: number;
	name: string;
	variant_key: string;
}

export interface EppoFlagEnvironment {
	id: number;
	name: string;
	active: boolean;
	is_production: boolean;
}

export interface EppoCondition {
	operator: string; // LT | LTE | GT | GTE | MATCHES | ONE_OF | NOT_ONE_OF | IS_NULL
	attribute: string;
	values: string[];
}

export interface EppoTargetingRule {
	conditions: EppoCondition[];
}

export interface EppoVariationWeight {
	variation_id: number;
	weight: number;
}

export interface EppoAllocation {
	id: number;
	key: string;
	name: string;
	environment_id?: number;
	type: string; // FEATURE_GATE | EXPERIMENT | SWITCHBACK
	percent_exposure: number;
	is_default: boolean;
	variation_weight: EppoVariationWeight[];
	targeting_rules: EppoTargetingRule[];
}

export interface EppoFlag {
	id: number;
	name: string;
	key: string;
	variation_type: string;
	owner?: { id: number; name?: string };
	tag_names: string[];
	updated_at: string;
	created_at: string;
	type?: 'FEATURE_FLAG' | 'LAYER' | 'BANDIT';
	variations?: EppoFlagVariation[];
	environments?: EppoFlagEnvironment[];
	allocations?: EppoAllocation[];
}

// ─── Eppo Migration File Types ──────────────────────────────────────────────

export interface MigrationFlagFailure {
	key: string;
	error: string;
}

export interface MigrationEnvFailure {
	key: string;
	env: string;
	error: string;
}

export interface MigrationFile {
	provider: string;
	migratedAt: string;
	success: boolean;
	summary: {
		created: number;
		synced: number;
		skipped: number;
		errored: number;
		enabled: number;
	};
	failures: MigrationFlagFailure[];
	enableFailures: MigrationEnvFailure[];
	skippedAllocations?: Array<{
		flagKey: string;
		allocationName: string;
		allocationKey: string;
	}>;
	skippedFlags?: Array<{ key: string; reason: string }>;
	flags: EppoFlag[];
	environmentMapping: import('../types.js').MigrationEnvironmentMapping[];
}

export interface DryRunFile extends MigrationFile {
	requests: Array<{ method: string; path: string; body: unknown }>;
}
