import type { DatadogFlagEntry } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

// Interactive conflict classification — distinguishes flags already migrated
// from the same LD project (`same_project`), manually-created DD flags with the
// same key but no migration_metadata (`manual`), and flags migrated from a
// different LD project (`cross_project`).
export type ConflictType = 'none' | 'same_project' | 'manual' | 'cross_project';

export interface ConflictClassification {
	type: ConflictType;
	existingFlag?: DatadogFlagEntry;
}

// Non-interactive variant — `manual` and `cross_project` collapse to
// `duplicate` because the resolution is forced (skip or rename via CLI args)
// rather than chosen by the user.
export type NonInteractiveConflictType = 'none' | 'same_project' | 'duplicate';

export interface NonInteractiveConflictClassification {
	type: NonInteractiveConflictType;
	existingFlag?: DatadogFlagEntry;
}

export interface LDFlagMigrationSpec {
	sourceKey: string;
	datadogKey: string;
}

export type ConflictResolution =
	| { action: 'skip' }
	| { action: 'prefix'; prefix: string };

// ─── Functions ───────────────────────────────────────────────────────────────

export function findMatchingDatadogFlag(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	flagKey: string,
): DatadogFlagEntry | undefined {
	return datadogFlags.find(
		(f) =>
			f.migration_metadata?.project_key === projectKey &&
			f.migration_metadata?.flag_key === flagKey,
	);
}

/** Classify the relationship between an LD flag and existing DD flags. */
export function classifyConflict(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	flagKey: string,
): ConflictClassification {
	const metadataMatch = findMatchingDatadogFlag(
		datadogFlags,
		projectKey,
		flagKey,
	);
	if (metadataMatch)
		return { type: 'same_project', existingFlag: metadataMatch };

	const keyMatch = datadogFlags.find((f) => f.key === flagKey);
	if (!keyMatch) return { type: 'none' };

	if (keyMatch.migration_metadata) {
		return { type: 'cross_project', existingFlag: keyMatch };
	}
	return { type: 'manual', existingFlag: keyMatch };
}

export function classifyNonInteractiveConflict(
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	sourceFlagKey: string,
	datadogFlagKey: string,
): NonInteractiveConflictClassification {
	const keyMatch = datadogFlags.find((f) => f.key === datadogFlagKey);
	if (!keyMatch) return { type: 'none' };

	const metadata = keyMatch.migration_metadata;
	if (
		metadata?.project_key === projectKey &&
		metadata.flag_key === sourceFlagKey
	) {
		return { type: 'same_project', existingFlag: keyMatch };
	}

	return { type: 'duplicate', existingFlag: keyMatch };
}

export function parseLDFlagMigrationSpecs(
	flagSpecs: string[],
): LDFlagMigrationSpec[] {
	const seenSourceKeys = new Set<string>();
	return flagSpecs.map((raw) => {
		const parts = raw.split(',').map((part) => part.trim());
		if (
			parts.length > 2 ||
			parts.length === 0 ||
			parts.some((part) => part.length === 0)
		) {
			throw new Error(
				`--feature-flag must be either '<source-key>' or '<source-key>,<datadog-key>', got: ${raw}`,
			);
		}
		const [sourceKey, datadogKey = sourceKey] = parts;
		if (seenSourceKeys.has(sourceKey)) {
			throw new Error(`Duplicate LaunchDarkly flag key: ${sourceKey}`);
		}
		seenSourceKeys.add(sourceKey);
		return { sourceKey, datadogKey };
	});
}
