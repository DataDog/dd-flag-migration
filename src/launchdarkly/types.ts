// ─── LaunchDarkly Environment Type ──────────────────────────────────────────

export interface LDEnvironment {
	key: string;
	name: string;
	color: string;
}

// ─── LaunchDarkly Flag Types ─────────────────────────────────────────────────
// Matches the JSON structure of exported LD flag files in launchdarkly/projects/

export interface LDVariation {
	_id: string;
	value: unknown;
	name?: string;
	description?: string;
}

export interface LDClause {
	_id: string;
	attribute: string;
	op: string;
	values: unknown[];
	contextKind: string;
	negate: boolean;
}

export interface LDRollout {
	variations: Array<{ variation: number; weight: number }>;
	contextKind?: string;
}

export interface LDRule {
	_id: string;
	variation?: number;
	rollout?: LDRollout;
	clauses: LDClause[];
	trackEvents: boolean;
	description?: string;
	ref?: string;
	disabled?: boolean;
}

export interface LDTarget {
	values: string[];
	variation: number;
	contextKind: string;
}

export interface LDPrerequisite {
	key: string;
	variation: number;
}

export interface LDEnvironmentConfig {
	on: boolean;
	archived: boolean;
	targets: LDTarget[];
	contextTargets: unknown[];
	rules: LDRule[];
	fallthrough: { variation?: number; rollout?: LDRollout };
	offVariation: number;
	prerequisites: LDPrerequisite[];
	_environmentName: string;
}

export interface LDMemberSummary {
	_id: string;
	firstName?: string;
	lastName?: string;
	role: string;
	email: string;
}

export interface LDMaintainerTeam {
	key: string;
	name: string;
}

export interface LDFlag {
	name: string;
	kind: 'boolean' | 'multivariate';
	key: string;
	description?: string;
	variations: LDVariation[];
	defaults: { onVariation: number; offVariation: number };
	environments?: Record<string, LDEnvironmentConfig>;
	tags: string[];
	archived: boolean;
	deprecated: boolean;
	temporary: boolean;
	creationDate?: number;
	maintainerId?: string;
	_maintainer?: LDMemberSummary;
	maintainerTeamKey?: string;
	_maintainerTeam?: LDMaintainerTeam;
}

// ─── LaunchDarkly Migration File ────────────────────────────────────────────

export interface LDMigrationFile {
	provider: 'launchdarkly';
	migratedAt: string;
	success: boolean;
	summary: {
		created: number;
		synced: number;
		skipped: number;
		errored: number;
		enabled: number;
	};
	failures: Array<{ key: string; error: string }>;
	enableFailures: Array<{ key: string; env: string; error: string }>;
	skippedFlags?: Array<{ key: string; reason: string }>;
	flags: LDFlag[];
	unmigrated?: LDFlag[];
	environmentMapping: Array<{
		sourceEnvId: string;
		sourceEnvName: string;
		datadogEnvId: string;
		datadogEnvName: string;
		datadogDdEnvNames?: string[];
	}>;
}
