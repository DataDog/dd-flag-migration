import { describe, expect, it } from '@jest/globals';
import { resolveEppoEnvMap, resolveEppoFlags } from '../src/eppo/index.js';
import type { EppoFlag, EppoFlagEnvironment } from '../src/eppo/types.js';
import { resolveLDEnvMap } from '../src/launchdarkly/index.js';
import type { LDEnvironment } from '../src/launchdarkly/types.js';
import type { DatadogEnvironment } from '../src/types.js';

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
