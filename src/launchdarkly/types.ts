// ─── LaunchDarkly Environment Type ──────────────────────────────────────────

export interface LDEnvironment {
	key: string;
	name: string;
	color: string;
	archived: boolean;
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

export interface LDProgressiveRolloutConfig {
	contextKind?: string;
	controlVariation: number;
	endVariation: number;
	steps: Array<{
		rolloutWeight: number;
		duration: { quantity: number; unit: string };
	}>;
}

export interface LDRule {
	_id: string;
	variation?: number;
	rollout?: LDRollout;
	progressiveRolloutConfig?: LDProgressiveRolloutConfig;
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
	contextTargets: LDTarget[];
	rules: LDRule[];
	fallthrough: {
		variation?: number;
		rollout?: LDRollout;
		progressiveRolloutConfig?: LDProgressiveRolloutConfig;
	};
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

export interface LDTeamSummary {
	key: string;
	name: string;
}

export interface LDMember {
	_id: string;
	email: string;
	teams?: { items: LDTeamSummary[] };
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

// ─── LaunchDarkly RBAC Types ────────────────────────────────────────────────

export interface LDPolicyStatement {
	effect: 'allow' | 'deny';
	actions?: string[];
	notActions?: string[];
	resources?: string[];
	notResources?: string[];
}

export interface LDCustomRole {
	key: string;
	name: string;
	policy: LDPolicyStatement[];
}

export interface LDTeamWithRoles {
	key: string;
	name: string;
	roles: Array<{ key: string }>;
}

// ─── LaunchDarkly Segment Types ─────────────────────────────────────────────

export interface LDSegmentContext {
	contextKind: string;
	values: string[];
}

export interface LDSegment {
	key: string;
	name: string;
	description?: string;
	tags: string[];
	included: string[];
	excluded: string[];
	includedContexts: LDSegmentContext[];
	excludedContexts: LDSegmentContext[];
	rules: LDRule[];
	deleted: boolean;
	_flags: Array<{ key: string; name: string }>;
}

// ─── LaunchDarkly Migration File ────────────────────────────────────────────

export interface LDMigrationFile {
	provider: 'launchdarkly';
	projectKey: string;
	projectName: string;
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
	syncedFlagKeys?: string[];
	flagKeyMapping?: Array<{ sourceKey: string; datadogKey: string }>;
	segmentMigration?: {
		discovered: number;
		created: number;
		negated: number;
		reused: number;
		updated: number;
		skipped: number;
		failures: Array<{ segmentKey: string; envKey: string; error: string }>;
	};
	flags: LDFlag[];
	environmentMapping: Array<{
		sourceEnvId: string;
		sourceEnvName: string;
		datadogEnvId: string;
		datadogEnvName: string;
		datadogDdEnvNames?: string[];
	}>;
}
