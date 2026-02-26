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
  type?: 'FEATURE_FLAG' | 'LAYER';
  variations?: EppoFlagVariation[];
  environments?: EppoFlagEnvironment[];
  allocations?: EppoAllocation[];
}

// ─── Datadog Types ───────────────────────────────────────────────────────────

export interface DatadogEnvironment {
  id: string;
  name: string;
  is_production: boolean;
}

export interface Config {
  eppoApiKey?: string;
  eppoSdkKey?: string;
  datadogApiKey?: string;
  datadogAppKey?: string;
}

export interface MigrationEnvironmentMapping {
  sourceEnvId: number;
  sourceEnvName: string;
  datadogEnvId: string;
  datadogEnvName: string;
}

export interface MigrationFile {
  provider: string;
  migratedAt: string;
  flags: EppoFlag[];
  environmentMapping: MigrationEnvironmentMapping[];
}

export interface DryRunFile extends MigrationFile {
  requests: Array<{ method: string; path: string; body: unknown }>;
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

export interface DatadogCreateFlagRequest {
  key: string;
  name: string;
  value_type: 'BOOLEAN' | 'INTEGER' | 'FLOAT' | 'STRING' | 'JSON';
  variants: Array<{ key: string; name: string; value: string }>;
  allocations?: DatadogAllocationForFlagCreation[];
}

export interface DatadogCreatedFlag {
  id: string;
  key: string;
}
