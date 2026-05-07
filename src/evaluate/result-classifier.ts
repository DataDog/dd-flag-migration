import type { DDStatus, MigrationMetadata } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RowColor =
	| 'match'
	| 'diff'
	| 'drift'
	| 'error'
	| 'notInDD'
	| 'notInProvider'
	| 'notMigrated';

export interface ClassifiedRow {
	color: RowColor;
	notes: string;
}

// ─── classifyRow ──────────────────────────────────────────────────────────────

/**
 * Classifies an evaluation result row into a color and notes message.
 *
 * Classification logic (applied in order):
 * 1. providerStatus === 'not-evaluated' → assert ddStatus === 'not-in-dd', return notInDD
 * 2. providerStatus === 'error' → error
 * 3. providerStatus === 'not-found' → notInProvider
 * 4. ddStatus === 'not-in-dd' → notInDD (archived flags look like this — indistinguishable via API)
 * 5. ddStatus === 'not-assigned' → notInDD
 * 6. Determine provenance (created by earlier migration vs. manually created)
 *    - inMigrationFile && match → match
 *    - inMigrationFile && !match → diff
 *    - !inMigrationFile && match → notMigrated
 *    - !inMigrationFile && !match → drift
 */
export function classifyRow(input: {
	flagKey: string;
	inMigrationFile: boolean;
	ddStatus: DDStatus;
	providerStatus: 'found' | 'not-found' | 'error' | 'not-evaluated';
	providerError?: string;
	match: boolean;
	ddMigrationMetadata?: MigrationMetadata;
	provider: 'launchdarkly' | 'eppo';
}): ClassifiedRow {
	// Step 1: Provider was not called — only valid when the flag is absent from DD
	if (input.providerStatus === 'not-evaluated') {
		if (input.ddStatus !== 'not-in-dd') {
			throw new Error(
				`classifyRow: 'not-evaluated' providerStatus requires ddStatus 'not-in-dd', got '${input.ddStatus}'`,
			);
		}
		return { color: 'notInDD', notes: 'Flag not found in Datadog' };
	}

	// Step 2: Check provider error (highest priority)
	if (input.providerStatus === 'error') {
		const providerName =
			input.provider === 'launchdarkly' ? 'LaunchDarkly' : 'Eppo';
		const errorMsg = input.providerError || 'unknown error';
		return {
			color: 'error',
			notes: `${providerName} SDK error: ${errorMsg}`,
		};
	}

	// Step 3: Check if flag not found in provider
	if (input.providerStatus === 'not-found') {
		const notes =
			input.provider === 'launchdarkly'
				? 'Flag not found in LaunchDarkly'
				: 'Flag not found or disabled in Eppo';
		return {
			color: 'notInProvider',
			notes,
		};
	}

	// Step 4: Check if flag not in Datadog
	if (input.ddStatus === 'not-in-dd') {
		return {
			color: 'notInDD',
			notes: 'Flag not found in Datadog',
		};
	}

	// Step 5: Check if flag exists but not assigned in Datadog
	if (input.ddStatus === 'not-assigned') {
		return {
			color: 'notInDD',
			notes: 'Flag exists in Datadog but no assignment for this context',
		};
	}

	// Step 6: Provider found, DD assigned
	// Determine provenance and classify by migration/match status
	const provenance = input.ddMigrationMetadata
		? 'Created by an earlier migration'
		: 'Manually created in Datadog';

	if (input.inMigrationFile && input.match) {
		return {
			color: 'match',
			notes: '',
		};
	}

	if (input.inMigrationFile && !input.match) {
		return {
			color: 'diff',
			notes: '',
		};
	}

	if (!input.inMigrationFile && input.match) {
		return {
			color: 'notMigrated',
			notes: `Flag not in selected migration file — ${provenance}`,
		};
	}

	// !inMigrationFile && !match
	return {
		color: 'drift',
		notes: `Flag not in selected migration file — possible targeting rule drift — ${provenance}`,
	};
}
