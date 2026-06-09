import { describe, expect, it } from '@jest/globals';
import { resolveEppoEnvMap, resolveEppoFlags } from '../src/eppo/index.js';
import type { EppoFlag, EppoFlagEnvironment } from '../src/eppo/types.js';
import { resolveLDEnvMap, resolveLDFlags } from '../src/launchdarkly/index.js';
import type { LDEnvironment, LDFlag } from '../src/launchdarkly/types.js';
import type { DatadogEnvironment } from '../src/types.js';

const ddEnvs: DatadogEnvironment[] = [
	{ id: 'dd1', name: 'Production', is_production: true, queries: ['prod'] },
	{ id: 'dd2', name: 'QA', is_production: false, queries: ['qa'] },
];

describe('resolveLDEnvMap', () => {
	const ldEnvs: LDEnvironment[] = [
		{ key: 'production', name: 'Production', color: '', archived: false },
		{ key: 'staging', name: 'Staging', color: '', archived: false },
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
});

describe('resolveLDFlags', () => {
	const flags: LDFlag[] = [
		{ key: 'a', name: 'A' } as LDFlag,
		{ key: 'b', name: 'B' } as LDFlag,
	];

	it('returns flags in the requested order', () => {
		const result = resolveLDFlags(['b', 'a'], flags);
		expect(result.map((f) => f.key)).toEqual(['b', 'a']);
	});

	it('throws listing all missing keys', () => {
		expect(() =>
			resolveLDFlags(['a', 'missing-1', 'missing-2'], flags),
		).toThrow(/missing-1, missing-2/);
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
		{ key: 'a', name: 'A' } as EppoFlag,
		{ key: 'b', name: 'B' } as EppoFlag,
	];

	it('returns the matching flags', () => {
		expect(resolveEppoFlags(['a'], flags).map((f) => f.key)).toEqual(['a']);
	});

	it('throws listing missing keys', () => {
		expect(() => resolveEppoFlags(['b', 'missing'], flags)).toThrow(/missing/);
	});
});
