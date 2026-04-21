import { describe, expect, it } from '@jest/globals';
import {
	isReleaseInProgress,
	type LDRelease,
} from '../../src/launchdarkly/api.js';
import {
	buildAllocations,
	buildFlagTags,
	buildTargetingRules,
	buildTeamTags,
	buildVariants,
	collectLDTeamKeys,
	getEnvsToEnable,
	mapFlagType,
	mapOperator,
	shouldSkipFlag,
} from '../../src/launchdarkly/migration.js';
import type { LDClause, LDFlag } from '../../src/launchdarkly/types.js';
import type { DatadogEnvironment } from '../../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ddDev: DatadogEnvironment = {
	id: 'dd-dev',
	name: 'Development',
	is_production: false,
	queries: ['dev'],
};

const ddProd: DatadogEnvironment = {
	id: 'dd-prod',
	name: 'Production',
	is_production: true,
	queries: ['prod'],
};

function makeFlag(overrides: Partial<LDFlag> & { key: string }): LDFlag {
	return {
		name: overrides.key,
		kind: 'boolean',
		description: '',
		variations: [
			{ _id: 'v0', value: true, name: 'true' },
			{ _id: 'v1', value: false, name: 'false' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
		...overrides,
	};
}

function makeClause(overrides: Partial<LDClause> = {}): LDClause {
	return {
		_id: 'clause-1',
		attribute: 'key',
		op: 'in',
		values: ['test'],
		contextKind: 'user',
		negate: false,
		...overrides,
	};
}

// ─── mapFlagType ──────────────────────────────────────────────────────────────

describe('mapFlagType', () => {
	it('maps boolean flags to BOOLEAN', () => {
		const flag = makeFlag({ key: 'test', kind: 'boolean' });
		expect(mapFlagType(flag)).toBe('BOOLEAN');
	});

	it('maps multivariate with number values to NUMERIC', () => {
		const flag = makeFlag({
			key: 'test',
			kind: 'multivariate',
			variations: [
				{ _id: 'v0', value: 42, name: 'forty-two' },
				{ _id: 'v1', value: 100, name: 'hundred' },
			],
		});
		expect(mapFlagType(flag)).toBe('NUMERIC');
	});

	it('maps multivariate with object values to JSON', () => {
		const flag = makeFlag({
			key: 'test',
			kind: 'multivariate',
			variations: [
				{ _id: 'v0', value: { url: 'https://example.com' }, name: 'config' },
				{ _id: 'v1', value: 'fallback', name: 'default' },
			],
		});
		expect(mapFlagType(flag)).toBe('JSON');
	});

	it('maps multivariate with string values to STRING', () => {
		const flag = makeFlag({
			key: 'test',
			kind: 'multivariate',
			variations: [
				{ _id: 'v0', value: 'red', name: 'Red' },
				{ _id: 'v1', value: 'blue', name: 'Blue' },
			],
		});
		expect(mapFlagType(flag)).toBe('STRING');
	});
});

// ─── mapOperator ──────────────────────────────────────────────────────────────

describe('mapOperator', () => {
	it('maps "in" to ONE_OF', () => {
		const result = mapOperator('in', false, ['a', 'b']);
		expect(result).toEqual({ operator: 'ONE_OF', values: ['a', 'b'] });
	});

	it('maps "in" + negate to NOT_ONE_OF', () => {
		const result = mapOperator('in', true, ['a']);
		expect(result).toEqual({ operator: 'NOT_ONE_OF', values: ['a'] });
	});

	it('maps "contains" to MATCHES with regex', () => {
		const result = mapOperator('contains', false, ['test']);
		expect(result).toEqual({ operator: 'MATCHES', values: ['.*test.*'] });
	});

	it('maps "contains" + negate to NOT_MATCHES', () => {
		const result = mapOperator('contains', true, ['test']);
		expect(result).toEqual({ operator: 'NOT_MATCHES', values: ['.*test.*'] });
	});

	it('maps "startsWith" to MATCHES with ^ prefix', () => {
		const result = mapOperator('startsWith', false, ['pre']);
		expect(result).toEqual({ operator: 'MATCHES', values: ['^pre.*'] });
	});

	it('maps "endsWith" to MATCHES with $ suffix', () => {
		const result = mapOperator('endsWith', false, ['fix']);
		expect(result).toEqual({ operator: 'MATCHES', values: ['.*fix$'] });
	});

	it('maps "matches" to MATCHES (passthrough)', () => {
		const result = mapOperator('matches', false, ['^foo.*bar$']);
		expect(result).toEqual({
			operator: 'MATCHES',
			values: ['^foo.*bar$'],
		});
	});

	it('maps "lessThan" to LT', () => {
		const result = mapOperator('lessThan', false, ['10']);
		expect(result).toEqual({ operator: 'LT', values: ['10'] });
	});

	it('maps "greaterThanOrEqual" to GTE', () => {
		const result = mapOperator('greaterThanOrEqual', false, ['5']);
		expect(result).toEqual({ operator: 'GTE', values: ['5'] });
	});

	it('maps "semVerLessThan" to SEMVER_LT', () => {
		const result = mapOperator('semVerLessThan', false, ['2.0.0']);
		expect(result).toEqual({ operator: 'SEMVER_LT', values: ['2.0.0'] });
	});

	it('maps "semVerEqual" to SEMVER_EQ', () => {
		const result = mapOperator('semVerEqual', false, ['1.0.0']);
		expect(result).toEqual({ operator: 'SEMVER_EQ', values: ['1.0.0'] });
	});

	it('maps "semVerGreaterThanOrEqual" to SEMVER_GTE', () => {
		const result = mapOperator('semVerGreaterThanOrEqual', false, ['3.0.0']);
		expect(result).toEqual({ operator: 'SEMVER_GTE', values: ['3.0.0'] });
	});

	it('returns skip for segmentMatch', () => {
		const result = mapOperator('segmentMatch', false, ['seg-1']);
		expect(result).toEqual({
			skip: 'Segment targeting is not supported in Datadog',
		});
	});

	it('returns skip for before', () => {
		const result = mapOperator('before', false, ['2024-01-01']);
		expect(result).toEqual({
			skip: 'Date-based targeting (before/after) is not supported in Datadog',
		});
	});

	it('returns skip for after', () => {
		const result = mapOperator('after', false, ['2024-01-01']);
		expect(result).toEqual({
			skip: 'Date-based targeting (before/after) is not supported in Datadog',
		});
	});

	it('escapes regex special characters in contains', () => {
		const result = mapOperator('contains', false, ['foo.bar']);
		expect(result).toEqual({
			operator: 'MATCHES',
			values: ['.*foo\\.bar.*'],
		});
	});

	it('combines multiple "contains" values into a single regex', () => {
		const result = mapOperator('contains', false, ['Core', 'CorePHR']);
		expect(result).toEqual({
			operator: 'MATCHES',
			values: ['(.*Core.*)|(.*CorePHR.*)'],
		});
	});

	it('combines multiple negated "contains" values into a single NOT_MATCHES regex', () => {
		const result = mapOperator('contains', true, ['Core', 'CorePHR']);
		expect(result).toEqual({
			operator: 'NOT_MATCHES',
			values: ['(.*Core.*)|(.*CorePHR.*)'],
		});
	});

	it('combines multiple "startsWith" values into a single regex', () => {
		const result = mapOperator('startsWith', false, ['pre', 'post']);
		expect(result).toEqual({
			operator: 'MATCHES',
			values: ['(^pre.*)|(^post.*)'],
		});
	});

	it('combines multiple "endsWith" values into a single regex', () => {
		const result = mapOperator('endsWith', false, ['ing', 'ed']);
		expect(result).toEqual({
			operator: 'MATCHES',
			values: ['(.*ing$)|(.*ed$)'],
		});
	});

	it('combines multiple "matches" values into a single regex', () => {
		const result = mapOperator('matches', false, ['^foo.*', '^bar.*']);
		expect(result).toEqual({
			operator: 'MATCHES',
			values: ['(^foo.*)|(^bar.*)'],
		});
	});

	it('passes through unknown operators uppercased', () => {
		const result = mapOperator('customOp', false, ['val']);
		expect(result).toEqual({ operator: 'CUSTOMOP', values: ['val'] });
	});
});

// ─── shouldSkipFlag ───────────────────────────────────────────────────────────

describe('shouldSkipFlag', () => {
	it('returns skip=false for a simple flag', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});
		expect(shouldSkipFlag(flag, ['production'])).toEqual({ skip: false });
	});

	it('skips flags with segmentMatch', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 0,
							clauses: [makeClause({ op: 'segmentMatch' })],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});
		const result = shouldSkipFlag(flag, ['production']);
		expect(result.skip).toBe(true);
		expect(result.reason).toContain('Segment targeting');
	});

	it('skips flags with before/after operators', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 0,
							clauses: [makeClause({ op: 'before' })],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});
		const result = shouldSkipFlag(flag, ['production']);
		expect(result.skip).toBe(true);
		expect(result.reason).toContain('Date-based');
	});

	it('warns but does not skip for prerequisites', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [{ key: 'other-flag', variation: 0 }],
					_environmentName: 'Production',
				},
			},
		});
		const result = shouldSkipFlag(flag, ['production']);
		expect(result.skip).toBe(false);
		expect(result.warn).toContain('prerequisites');
	});

	it('only checks selected environments', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				dev: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Dev',
				},
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 0,
							clauses: [makeClause({ op: 'segmentMatch' })],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});
		// Only checking dev — should not skip
		expect(shouldSkipFlag(flag, ['dev'])).toEqual({ skip: false });
		// Checking production — should skip
		expect(shouldSkipFlag(flag, ['production']).skip).toBe(true);
	});

	it('flags progressive rollout on fallthrough for release status check', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: {
						progressiveRolloutConfig: {
							controlVariation: 1,
							endVariation: 0,
							steps: [
								{
									rolloutWeight: 10000,
									duration: { quantity: 1, unit: 'hour' },
								},
								{
									rolloutWeight: 50000,
									duration: { quantity: 1, unit: 'hour' },
								},
							],
						},
					},
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});
		const result = shouldSkipFlag(flag, ['production']);
		expect(result.skip).toBe(false);
		expect(result.hasProgressiveRollout).toBe(true);
	});

	it('flags progressive rollout on a rule for release status check', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							progressiveRolloutConfig: {
								controlVariation: 1,
								endVariation: 0,
								steps: [
									{
										rolloutWeight: 50000,
										duration: { quantity: 2, unit: 'hour' },
									},
								],
							},
							clauses: [makeClause({ op: 'in' })],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});
		const result = shouldSkipFlag(flag, ['production']);
		expect(result.skip).toBe(false);
		expect(result.hasProgressiveRollout).toBe(true);
	});
});

// ─── isReleaseInProgress ──────────────────────────────────────────────────────

describe('isReleaseInProgress', () => {
	it('returns true when a phase is still in progress', () => {
		const release: LDRelease = {
			phases: [
				{ _id: 'p1', _name: 'Phase 1', status: 'Complete', complete: true },
				{ _id: 'p2', _name: 'Phase 2', status: 'Started', complete: false },
			],
		};
		expect(isReleaseInProgress(release)).toBe(true);
	});

	it('returns false when all phases are complete', () => {
		const release: LDRelease = {
			phases: [
				{ _id: 'p1', _name: 'Phase 1', status: 'Complete', complete: true },
				{ _id: 'p2', _name: 'Phase 2', status: 'Complete', complete: true },
			],
		};
		expect(isReleaseInProgress(release)).toBe(false);
	});

	it('returns true when a phase is paused', () => {
		const release: LDRelease = {
			phases: [
				{ _id: 'p1', _name: 'Phase 1', status: 'Paused', complete: false },
			],
		};
		expect(isReleaseInProgress(release)).toBe(true);
	});

	it('returns true when a phase is not started', () => {
		const release: LDRelease = {
			phases: [
				{ _id: 'p1', _name: 'Phase 1', status: 'NotStarted', complete: false },
			],
		};
		expect(isReleaseInProgress(release)).toBe(true);
	});
});

// ─── buildVariants ────────────────────────────────────────────────────────────

describe('buildVariants', () => {
	it('builds variants from boolean flag', () => {
		const flag = makeFlag({ key: 'test' });
		const variants = buildVariants(flag);
		expect(variants).toEqual([
			{ key: 'true', name: 'true', value: 'true' },
			{ key: 'false', name: 'false', value: 'false' },
		]);
	});

	it('builds variants from multivariate flag with objects', () => {
		const flag = makeFlag({
			key: 'test',
			kind: 'multivariate',
			variations: [
				{ _id: 'v0', value: { url: 'https://a.com' }, name: 'Config A' },
				{ _id: 'v1', value: { url: 'https://b.com' }, name: 'Config B' },
			],
		});
		const variants = buildVariants(flag);
		expect(variants[0].key).toBe('config-a');
		expect(variants[0].value).toBe('{"url":"https://a.com"}');
		expect(variants[1].key).toBe('config-b');
	});

	it('uses index-based keys when name is missing', () => {
		const flag = makeFlag({
			key: 'test',
			kind: 'multivariate',
			variations: [
				{ _id: 'v0', value: 'red' },
				{ _id: 'v1', value: 'blue' },
			],
		});
		const variants = buildVariants(flag);
		expect(variants[0].key).toBe('variation-0');
		expect(variants[1].key).toBe('variation-1');
	});
});

// ─── buildTargetingRules ──────────────────────────────────────────────────────

describe('buildTargetingRules', () => {
	it('returns empty array for no clauses', () => {
		expect(buildTargetingRules([])).toEqual([]);
	});

	it('converts LD clauses to DD targeting rules', () => {
		const clauses = [
			makeClause({ attribute: 'country', op: 'in', values: ['US', 'CA'] }),
		];
		const result = buildTargetingRules(clauses);
		expect(result).toEqual([
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', value: ['US', 'CA'] },
				],
			},
		]);
	});

	it('returns null for unsupported operator', () => {
		const clauses = [makeClause({ op: 'segmentMatch' })];
		expect(buildTargetingRules(clauses)).toBeNull();
	});

	it('combines multiple clauses into one rule', () => {
		const clauses = [
			makeClause({ attribute: 'country', op: 'in', values: ['US'] }),
			makeClause({
				_id: 'c2',
				attribute: 'version',
				op: 'semVerLessThan',
				values: ['2.0.0'],
			}),
		];
		const result = buildTargetingRules(clauses);
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions).toHaveLength(2);
	});
});

// ─── buildAllocations ─────────────────────────────────────────────────────────

describe('buildAllocations', () => {
	it('builds allocations from targets, rules, and fallthrough', () => {
		const flag = makeFlag({
			key: 'my-flag',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [
						{ values: ['user-1', 'user-2'], variation: 0, contextKind: 'user' },
					],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 0,
							clauses: [
								makeClause({
									attribute: 'country',
									op: 'in',
									values: ['US'],
								}),
							],
							trackEvents: false,
							description: 'US users',
						},
					],
					fallthrough: { variation: 1 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map([['production', ddProd]]);
		const allocations = buildAllocations(flag, envMapping);

		// Should have: 1 target + 1 rule + 1 fallthrough = 3 allocations
		expect(allocations).toHaveLength(3);

		// Target allocation
		expect(allocations[0].key).toBe('my-flag-production-target-0');
		expect(allocations[0].targeting_rules).toHaveLength(1);
		expect(allocations[0].targeting_rules?.[0].conditions[0].operator).toBe(
			'ONE_OF',
		);
		expect(allocations[0].targeting_rules?.[0].conditions[0].value).toEqual([
			'user-1',
			'user-2',
		]);

		// Rule allocation
		expect(allocations[1].key).toBe('my-flag-production-rule-0');
		expect(allocations[1].name).toBe('US users');
		expect(allocations[1].targeting_rules).toHaveLength(1);

		// Fallthrough allocation
		expect(allocations[2].key).toBe('my-flag-production-fallthrough');
		expect(allocations[2].targeting_rules).toBeUndefined();
		// 100% on variation index 1 (false)
		expect(allocations[2].variant_weights).toEqual([
			{ variant_key: 'true', value: 0 },
			{ variant_key: 'false', value: 100 },
		]);
	});

	it('handles rollout in fallthrough', () => {
		const flag = makeFlag({
			key: 'rollout-flag',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: {
						rollout: {
							variations: [
								{ variation: 0, weight: 75000 },
								{ variation: 1, weight: 25000 },
							],
						},
					},
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map([['production', ddProd]]);
		const allocations = buildAllocations(flag, envMapping);

		expect(allocations).toHaveLength(1);
		expect(allocations[0].variant_weights).toEqual([
			{ variant_key: 'true', value: 75 },
			{ variant_key: 'false', value: 25 },
		]);
	});

	it('skips rules with unsupported operators', () => {
		const flag = makeFlag({
			key: 'segment-flag',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 0,
							clauses: [makeClause({ op: 'segmentMatch' })],
							trackEvents: false,
						},
						{
							_id: 'r2',
							variation: 1,
							clauses: [
								makeClause({ op: 'in', attribute: 'key', values: ['test'] }),
							],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 1 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map([['production', ddProd]]);
		const allocations = buildAllocations(flag, envMapping);

		// segmentMatch rule skipped, but "in" rule + fallthrough remain
		expect(allocations).toHaveLength(2);
		expect(allocations[0].key).toBe('segment-flag-production-rule-1');
	});

	it('skips disabled rules', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 0,
							clauses: [makeClause()],
							trackEvents: false,
							disabled: true,
						},
					],
					fallthrough: { variation: 1 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map([['production', ddProd]]);
		const allocations = buildAllocations(flag, envMapping);

		// Only fallthrough, disabled rule skipped
		expect(allocations).toHaveLength(1);
		expect(allocations[0].key).toBe('test-production-fallthrough');
	});

	it('builds allocations for multiple environments', () => {
		const flag = makeFlag({
			key: 'multi-env',
			environments: {
				dev: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Dev',
				},
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 1 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map<string, DatadogEnvironment>([
			['dev', ddDev],
			['production', ddProd],
		]);
		const allocations = buildAllocations(flag, envMapping);

		expect(allocations).toHaveLength(2);
		expect(allocations[0].environment_id).toBe('dd-dev');
		expect(allocations[1].environment_id).toBe('dd-prod');
	});
});

// ─── getEnvsToEnable ──────────────────────────────────────────────────────────

describe('getEnvsToEnable', () => {
	it('returns environments where flag is on', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				dev: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Dev',
				},
				production: {
					on: false,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map<string, DatadogEnvironment>([
			['dev', ddDev],
			['production', ddProd],
		]);
		const result = getEnvsToEnable(flag, envMapping);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('dd-dev');
	});

	it('returns empty when flag is off everywhere', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				production: {
					on: false,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		});

		const envMapping = new Map([['production', ddProd]]);
		expect(getEnvsToEnable(flag, envMapping)).toEqual([]);
	});

	it('only returns mapped environments', () => {
		const flag = makeFlag({
			key: 'test',
			environments: {
				dev: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Dev',
				},
				staging: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
					_environmentName: 'Staging',
				},
			},
		});

		// Only dev is mapped
		const envMapping = new Map<string, DatadogEnvironment>([['dev', ddDev]]);
		const result = getEnvsToEnable(flag, envMapping);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('dd-dev');
	});
});

// ─── buildTeamTags ───────────────────────────────────────────────────────────

describe('buildTeamTags', () => {
	const emptyCache = new Map<string, string[]>();

	it('returns team tag from maintainerTeamKey', () => {
		const flag = makeFlag({ key: 'f1', maintainerTeamKey: 'platform' });
		expect(buildTeamTags(flag, emptyCache)).toEqual(['team:platform']);
	});

	it('returns team tags from cache for individual maintainer', () => {
		const cache = new Map([['m1', ['eng', 'frontend']]]);
		const flag = makeFlag({ key: 'f1', maintainerId: 'm1' });
		expect(buildTeamTags(flag, cache)).toEqual(['team:eng', 'team:frontend']);
	});

	it('returns empty array when no maintainer is set', () => {
		const flag = makeFlag({ key: 'f1' });
		expect(buildTeamTags(flag, emptyCache)).toEqual([]);
	});

	it('returns empty array when maintainerId is not in cache', () => {
		const flag = makeFlag({ key: 'f1', maintainerId: 'm1' });
		expect(buildTeamTags(flag, emptyCache)).toEqual([]);
	});

	// Defensive: buildMemberTeamCache skips members for flags with maintainerTeamKey,
	// so this cache state won't occur at runtime — but buildTeamTags still deduplicates
	// correctly if both paths produce the same team key.
	it('deduplicates when both maintainerTeamKey and cache have same team', () => {
		const cache = new Map([['m1', ['platform', 'frontend']]]);
		const flag = makeFlag({
			key: 'f1',
			maintainerTeamKey: 'platform',
			maintainerId: 'm1',
		});
		expect(buildTeamTags(flag, cache)).toEqual([
			'team:platform',
			'team:frontend',
		]);
	});

	it('combines maintainerTeamKey and cache when both present with different teams', () => {
		const cache = new Map([['m1', ['eng']]]);
		const flag = makeFlag({
			key: 'f1',
			maintainerTeamKey: 'platform',
			maintainerId: 'm1',
		});
		expect(buildTeamTags(flag, cache)).toEqual(['team:platform', 'team:eng']);
	});
});

// ─── buildFlagTags ───────────────────────────────────────────────────────────

describe('buildFlagTags', () => {
	const emptyCache = new Map<string, string[]>();

	it('returns only team tags when flag has no LD source tags', () => {
		const flag = makeFlag({ key: 'f1', maintainerTeamKey: 'platform' });
		expect(buildFlagTags(flag, emptyCache)).toEqual(['team:platform']);
	});

	it('returns only LD source tags when flag has no maintainer', () => {
		const flag = makeFlag({ key: 'f1', tags: ['ui', 'experiment'] });
		expect(buildFlagTags(flag, emptyCache)).toEqual(['ui', 'experiment']);
	});

	it('returns team tags first then LD source tags', () => {
		const flag = makeFlag({
			key: 'f1',
			maintainerTeamKey: 'platform',
			tags: ['ui', 'experiment'],
		});
		expect(buildFlagTags(flag, emptyCache)).toEqual([
			'team:platform',
			'ui',
			'experiment',
		]);
	});

	it('returns empty array when neither maintainer nor LD tags exist', () => {
		const flag = makeFlag({ key: 'f1' });
		expect(buildFlagTags(flag, emptyCache)).toEqual([]);
	});

	it('includes team tags from cache for individual maintainer', () => {
		const cache = new Map([['m1', ['eng']]]);
		const flag = makeFlag({
			key: 'f1',
			maintainerId: 'm1',
			tags: ['beta'],
		});
		expect(buildFlagTags(flag, cache)).toEqual(['team:eng', 'beta']);
	});

	it('applies teamKeyMapping to translate LD keys to DD handles', () => {
		const mapping = new Map([['ld-platform', 'dd-platform-eng']]);
		const flag = makeFlag({
			key: 'f1',
			maintainerTeamKey: 'ld-platform',
			tags: ['ui'],
		});
		expect(buildFlagTags(flag, emptyCache, mapping)).toEqual([
			'team:dd-platform-eng',
			'ui',
		]);
	});

	it('passes through unmapped team keys unchanged', () => {
		const mapping = new Map([['other-team', 'mapped-team']]);
		const flag = makeFlag({
			key: 'f1',
			maintainerTeamKey: 'platform',
			tags: ['ui'],
		});
		expect(buildFlagTags(flag, emptyCache, mapping)).toEqual([
			'team:platform',
			'ui',
		]);
	});
});

// ─── collectLDTeamKeys ───────────────────────────────────────────────────────

describe('collectLDTeamKeys', () => {
	const emptyCache = new Map<string, string[]>();

	it('collects team keys from maintainerTeamKey', () => {
		const flags = [
			makeFlag({ key: 'f1', maintainerTeamKey: 'platform' }),
			makeFlag({ key: 'f2', maintainerTeamKey: 'eng' }),
		];
		const keys = collectLDTeamKeys(flags, emptyCache);
		expect(keys).toEqual(new Set(['platform', 'eng']));
	});

	it('collects team keys from member cache', () => {
		const cache = new Map([['m1', ['eng', 'frontend']]]);
		const flags = [makeFlag({ key: 'f1', maintainerId: 'm1' })];
		const keys = collectLDTeamKeys(flags, cache);
		expect(keys).toEqual(new Set(['eng', 'frontend']));
	});

	it('deduplicates keys across flags', () => {
		const flags = [
			makeFlag({ key: 'f1', maintainerTeamKey: 'platform' }),
			makeFlag({ key: 'f2', maintainerTeamKey: 'platform' }),
		];
		const keys = collectLDTeamKeys(flags, emptyCache);
		expect(keys).toEqual(new Set(['platform']));
	});

	it('returns empty set when no flags have maintainers', () => {
		const flags = [makeFlag({ key: 'f1' })];
		const keys = collectLDTeamKeys(flags, emptyCache);
		expect(keys.size).toBe(0);
	});

	it('combines keys from both maintainerTeamKey and cache', () => {
		const cache = new Map([['m1', ['frontend']]]);
		const flags = [
			makeFlag({ key: 'f1', maintainerTeamKey: 'platform' }),
			makeFlag({ key: 'f2', maintainerId: 'm1' }),
		];
		const keys = collectLDTeamKeys(flags, cache);
		expect(keys).toEqual(new Set(['platform', 'frontend']));
	});
});

// ─── buildTeamTags with mapping ──────────────────────────────────────────────

describe('buildTeamTags with teamKeyMapping', () => {
	const emptyCache = new Map<string, string[]>();

	it('maps LD team key to DD handle', () => {
		const mapping = new Map([['ld-eng', 'dd-engineering']]);
		const flag = makeFlag({ key: 'f1', maintainerTeamKey: 'ld-eng' });
		expect(buildTeamTags(flag, emptyCache, mapping)).toEqual([
			'team:dd-engineering',
		]);
	});

	it('passes through keys not in mapping', () => {
		const mapping = new Map([['other', 'mapped']]);
		const flag = makeFlag({ key: 'f1', maintainerTeamKey: 'platform' });
		expect(buildTeamTags(flag, emptyCache, mapping)).toEqual(['team:platform']);
	});

	it('maps cache-derived team keys', () => {
		const cache = new Map([['m1', ['ld-eng']]]);
		const mapping = new Map([['ld-eng', 'dd-engineering']]);
		const flag = makeFlag({ key: 'f1', maintainerId: 'm1' });
		expect(buildTeamTags(flag, cache, mapping)).toEqual([
			'team:dd-engineering',
		]);
	});

	it('works without mapping (undefined)', () => {
		const flag = makeFlag({ key: 'f1', maintainerTeamKey: 'platform' });
		expect(buildTeamTags(flag, emptyCache, undefined)).toEqual([
			'team:platform',
		]);
	});
});
