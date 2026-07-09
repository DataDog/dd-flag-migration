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

import type { MigrationMetadata } from './datadog/types.js';

// ─── Evaluation Types ────────────────────────────────────────────────────────

export type SubjectAttributes = Record<
	string,
	string | number | boolean | null
>;

export interface TestCase {
	label: string;
	attributes: SubjectAttributes;
	subjectIdOverride?: string;
	contextAttributes?: Record<string, SubjectAttributes>;
	ldUserAttributes?: SubjectAttributes;
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
