import { describe, expect, it } from '@jest/globals';
import { resolveEppoEnvMap, resolveEppoFlags } from '../src/eppo/index.js';
import type { EppoFlag, EppoFlagEnvironment } from '../src/eppo/types.js';
import {
	classifyNonInteractiveConflict,
	parseLDFlagMigrationSpecs,
	resolveLDEnvMap,
} from '../src/launchdarkly/index.js';
import type { LDEnvironment } from '../src/launchdarkly/types.js';
import type { DatadogEnvironment, DatadogFlagEntry } from '../src/types.js';

const ddEnvs: DatadogEnvironment[] = [
	{ id: 'dd1', name: 'Production', is_production: true, queries: ['prod'] },
	{ id: 'dd2', name: 'QA', is_production: false, queries: ['qa'] },
];

describe('resolveLDEnvMap', () => {
	const ldEnvs: LDEnvironment[] = [
		{ key: 'production', name: 'Production', color: '', archived: false },
		{ key: 'staging', name: 'Staging', color: '', archived: false },
		{ key: 'legacy', name: 'Legacy', color: '', archived: true },
	];

	it('matches LD env by key', () => {
		const { envMapping, selectedEnvKeys } = resolveLDEnvMap(
			[['production', 'Production']],
			ldEnvs,
			ddEnvs,
		);
		expect(selectedEnvKeys).toEqual(['production']);
		expect(envMapping.get('production')?.id).toBe('dd1');
	});

	it('falls back to matching LD env by name', () => {
		const { envMapping, selectedEnvKeys } = resolveLDEnvMap(
			[['Staging', 'QA']],
			ldEnvs,
			ddEnvs,
		);
		expect(selectedEnvKeys).toEqual(['staging']);
		expect(envMapping.get('staging')?.id).toBe('dd2');
	});

	it('throws for unknown LD env', () => {
		expect(() =>
			resolveLDEnvMap([['nope', 'Production']], ldEnvs, ddEnvs),
		).toThrow(/LaunchDarkly environment not found/);
	});

	it('throws for unknown DD env', () => {
		expect(() =>
			resolveLDEnvMap([['production', 'NopeEnv']], ldEnvs, ddEnvs),
		).toThrow(/Datadog environment not found/);
	});

	it('throws for archived LD env', () => {
		expect(() =>
			resolveLDEnvMap([['legacy', 'Production']], ldEnvs, ddEnvs),
		).toThrow(/archived/);
	});

	it('excludes archived envs from the available list in not-found error', () => {
		expect(() =>
			resolveLDEnvMap([['nope', 'Production']], ldEnvs, ddEnvs),
		).toThrow(/LaunchDarkly environment not found.*(?!legacy)/s);
	});
});

describe('parseLDFlagMigrationSpecs', () => {
	it('uses the source key as the Datadog key when no rename is provided', () => {
		expect(parseLDFlagMigrationSpecs(['flag-a'])).toEqual([
			{ sourceKey: 'flag-a', datadogKey: 'flag-a' },
		]);
	});

	it('parses source and Datadog keys from comma-delimited specs', () => {
		expect(parseLDFlagMigrationSpecs(['flag-a,renamed-flag-a'])).toEqual([
			{ sourceKey: 'flag-a', datadogKey: 'renamed-flag-a' },
		]);
	});

	it('trims source and Datadog keys', () => {
		expect(parseLDFlagMigrationSpecs([' flag-a , renamed-flag-a '])).toEqual([
			{ sourceKey: 'flag-a', datadogKey: 'renamed-flag-a' },
		]);
	});

	it('rejects malformed rename specs', () => {
		expect(() => parseLDFlagMigrationSpecs(['flag-a,'])).toThrow(
			/--feature-flag/,
		);
		expect(() => parseLDFlagMigrationSpecs(['flag-a,b,c'])).toThrow(
			/--feature-flag/,
		);
	});

	it('rejects duplicate source keys', () => {
		expect(() =>
			parseLDFlagMigrationSpecs(['flag-a', 'flag-a,renamed-flag-a']),
		).toThrow(/Duplicate LaunchDarkly flag key/);
	});
});

describe('classifyNonInteractiveConflict', () => {
	const projectKey = 'mobile';
	const sourceKey = 'enable-dark-mode';
	const targetKey = 'renamed-dark-mode';

	it('returns none when no Datadog flag has the target key', () => {
		expect(
			classifyNonInteractiveConflict([], projectKey, sourceKey, targetKey),
		).toEqual({ type: 'none' });
	});

	it('returns same_project when the target key was migrated from the same source flag', () => {
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'dd-same',
				key: targetKey,
				migration_metadata: {
					project_key: projectKey,
					flag_key: sourceKey,
				},
			},
		];
		const result = classifyNonInteractiveConflict(
			datadogFlags,
			projectKey,
			sourceKey,
			targetKey,
		);
		expect(result.type).toBe('same_project');
		expect(result.existingFlag?.id).toBe('dd-same');
	});

	it('returns duplicate when the target key exists without migration metadata', () => {
		const result = classifyNonInteractiveConflict(
			[{ id: 'dd-manual', key: targetKey }],
			projectKey,
			sourceKey,
			targetKey,
		);
		expect(result.type).toBe('duplicate');
		expect(result.existingFlag?.id).toBe('dd-manual');
	});

	it('returns duplicate when the target key was migrated from another project', () => {
		const result = classifyNonInteractiveConflict(
			[
				{
					id: 'dd-web',
					key: targetKey,
					migration_metadata: {
						project_key: 'web',
						flag_key: sourceKey,
					},
				},
			],
			projectKey,
			sourceKey,
			targetKey,
		);
		expect(result.type).toBe('duplicate');
		expect(result.existingFlag?.id).toBe('dd-web');
	});

	it('returns duplicate when the target key belongs to a different source flag in the same project', () => {
		const result = classifyNonInteractiveConflict(
			[
				{
					id: 'dd-other-flag',
					key: targetKey,
					migration_metadata: {
						project_key: projectKey,
						flag_key: 'other-flag',
					},
				},
			],
			projectKey,
			sourceKey,
			targetKey,
		);
		expect(result.type).toBe('duplicate');
		expect(result.existingFlag?.id).toBe('dd-other-flag');
	});
});

describe('resolveEppoEnvMap', () => {
	const eppoEnvs: EppoFlagEnvironment[] = [
		{ id: 1, name: 'Production', active: true, is_production: true },
		{ id: 2, name: 'Staging', active: true, is_production: false },
	];

	it('matches Eppo env by name', () => {
		const { envMapping, selectedEnvs } = resolveEppoEnvMap(
			[['Staging', 'QA']],
			eppoEnvs,
			ddEnvs,
		);
		expect(selectedEnvs.map((e) => e.id)).toEqual([2]);
		expect(envMapping.get(2)?.id).toBe('dd2');
	});

	it('throws for unknown Eppo env', () => {
		expect(() =>
			resolveEppoEnvMap([['nope', 'Production']], eppoEnvs, ddEnvs),
		).toThrow(/Eppo environment not found/);
	});

	it('throws for unknown DD env', () => {
		expect(() =>
			resolveEppoEnvMap([['Production', 'Nope']], eppoEnvs, ddEnvs),
		).toThrow(/Datadog environment not found/);
	});
});

describe('resolveEppoFlags', () => {
	const flags: EppoFlag[] = [
		{
			key: 'a',
			name: 'A',
			environments: [
				{ id: 1, name: 'Production', active: true, is_production: true },
			],
		} as EppoFlag,
		{
			key: 'b',
			name: 'B',
			environments: [
				{ id: 2, name: 'Staging', active: true, is_production: false },
			],
		} as EppoFlag,
	];

	it('returns the matching flags', () => {
		expect(resolveEppoFlags(['a'], flags).map((f) => f.key)).toEqual(['a']);
	});

	it('throws listing missing keys', () => {
		expect(() => resolveEppoFlags(['b', 'missing'], flags)).toThrow(/missing/);
	});

	it('passes when all flags are present in a mapped env', () => {
		expect(
			resolveEppoFlags(['a', 'b'], flags, new Set([1, 2])).map((f) => f.key),
		).toEqual(['a', 'b']);
	});

	it('throws when a flag has no environment in the mapped set', () => {
		expect(() => resolveEppoFlags(['a', 'b'], flags, new Set([1]))).toThrow(
			/not present in any mapped Eppo environment.*b/,
		);
	});

	it('skips env check when selectedEnvIds is undefined', () => {
		const flagsNoEnv: EppoFlag[] = [{ key: 'x', name: 'X' } as EppoFlag];
		expect(resolveEppoFlags(['x'], flagsNoEnv).map((f) => f.key)).toEqual([
			'x',
		]);
	});
});
