import { describe, expect, it } from '@jest/globals';
import { classifyRow } from '../src/evaluate/result-classifier.js';
import type { MigrationMetadata } from '../src/types.js';

const META: MigrationMetadata = { project_key: 'proj', flag_key: 'my-flag' };

describe('classifyRow', () => {
	// Case 1: in migration, provider found, dd assigned, match → color='match', notes=''
	it('Case 1: in migration, provider found, dd assigned, match → match', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'assigned',
			providerStatus: 'found',
			match: true,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('match');
		expect(result.notes).toBe('');
	});

	// Case 2: in migration, provider found, dd assigned, no match → color='diff', notes=''
	it('Case 2: in migration, provider found, dd assigned, no match → diff', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'assigned',
			providerStatus: 'found',
			match: false,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('diff');
		expect(result.notes).toBe('');
	});

	// Case 3a: NOT in migration, provider found, dd assigned, match, WITH migration_metadata → color='notMigrated', notes='Flag not in selected migration file — Created by an earlier migration'
	it('Case 3a: NOT in migration, match, WITH migration_metadata → notMigrated (earlier migration)', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: false,
			ddStatus: 'assigned',
			providerStatus: 'found',
			match: true,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('notMigrated');
		expect(result.notes).toBe(
			'Flag not in selected migration file — Created by an earlier migration',
		);
	});

	// Case 3b: NOT in migration, provider found, dd assigned, match, NO migration_metadata → color='notMigrated', notes='Flag not in selected migration file — Manually created in Datadog'
	it('Case 3b: NOT in migration, match, NO migration_metadata → notMigrated (manually created)', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: false,
			ddStatus: 'assigned',
			providerStatus: 'found',
			match: true,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('notMigrated');
		expect(result.notes).toBe(
			'Flag not in selected migration file — Manually created in Datadog',
		);
	});

	// Case 4: NOT in migration, provider found, dd assigned, no match, WITH migration_metadata → color='drift', notes contains 'Flag not in selected migration file — possible targeting rule drift' AND 'Created by an earlier migration'
	it('Case 4: NOT in migration, no match, WITH migration_metadata → drift (with earlier migration)', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: false,
			ddStatus: 'assigned',
			providerStatus: 'found',
			match: false,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('drift');
		expect(result.notes).toContain('Flag not in selected migration file');
		expect(result.notes).toContain('possible targeting rule drift');
		expect(result.notes).toContain('Created by an earlier migration');
	});

	// Case 5a: provider='not-found', provider='launchdarkly' → color='notInProvider', notes='Flag not found in LaunchDarkly'
	it('Case 5a: provider not-found, LaunchDarkly → notInProvider', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'assigned',
			providerStatus: 'not-found',
			match: false,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('notInProvider');
		expect(result.notes).toBe('Flag not found in LaunchDarkly');
	});

	// Case 5b: provider='not-found', provider='eppo' → color='notInProvider', notes='Flag not found or disabled in Eppo'
	it('Case 5b: provider not-found, Eppo → notInProvider', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'assigned',
			providerStatus: 'not-found',
			match: false,
			ddMigrationMetadata: META,
			provider: 'eppo',
		});

		expect(result.color).toBe('notInProvider');
		expect(result.notes).toBe('Flag not found or disabled in Eppo');
	});

	// Case 6: dd status='not-in-dd' → color='notInDD', notes='Flag not found in Datadog'
	it('Case 6: dd status not-in-dd → notInDD', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'not-in-dd',
			providerStatus: 'found',
			match: false,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('notInDD');
		expect(result.notes).toBe('Flag not found in Datadog');
	});

	// Case 7: dd status='not-assigned' → color='notInDD', notes='Flag exists in Datadog but no assignment for this context'
	it('Case 7: dd status not-assigned → notInDD', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'not-assigned',
			providerStatus: 'found',
			match: false,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('notInDD');
		expect(result.notes).toBe(
			'Flag exists in Datadog but no assignment for this context',
		);
	});

	// Case 8a: providerStatus='error', provider='launchdarkly', providerError='connection refused' → color='error', notes='LaunchDarkly SDK error: connection refused'
	it('Case 8a: provider error, LaunchDarkly → error', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'assigned',
			providerStatus: 'error',
			providerError: 'connection refused',
			match: false,
			ddMigrationMetadata: META,
			provider: 'launchdarkly',
		});

		expect(result.color).toBe('error');
		expect(result.notes).toBe('LaunchDarkly SDK error: connection refused');
	});

	// Case 8b: providerStatus='error', provider='eppo', providerError='timeout' → color='error', notes='Eppo SDK error: timeout'
	it('Case 8b: provider error, Eppo → error', () => {
		const result = classifyRow({
			flagKey: 'my-flag',
			inMigrationFile: true,
			ddStatus: 'assigned',
			providerStatus: 'error',
			providerError: 'timeout',
			match: false,
			ddMigrationMetadata: META,
			provider: 'eppo',
		});

		expect(result.color).toBe('error');
		expect(result.notes).toBe('Eppo SDK error: timeout');
	});
});
