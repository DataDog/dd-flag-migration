import { describe, expect, it } from '@jest/globals';
import {
	isReleaseInProgress,
	type LDRelease,
} from '../../src/launchdarkly/api.js';
import {
	buildAllocations,
	buildTargetingRules,
	buildVariants,
	findProjectEditorRoleKeys,
	findTeamsWithEditAccess,
	getEnvsToEnable,
	mapFlagType,
	mapOperator,
	resolveSegmentMatch,
	shouldSkipFlag,
} from '../../src/launchdarkly/migration.js';
import type {
	LDClause,
	LDCustomRole,
	LDFlag,
	LDTeamWithRoles,
} from '../../src/launchdarkly/types.js';
import type {
	DatadogAllocationForFlagCreation,
	DatadogEnvironment,
	DatadogTargetingRule,
} from '../../src/types.js';

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

	it('passes through segmentMatch uppercased (handled before mapOperator in buildTargetingRules)', () => {
		const result = mapOperator('segmentMatch', false, ['seg-1']);
		expect(result).toEqual({ operator: 'SEGMENTMATCH', values: ['seg-1'] });
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

	it('does not skip a flag with segmentMatch (handled in buildAllocations now)', () => {
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
		expect(result.skip).toBe(false);
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

	it('returns null for unsupported operator (before/after)', () => {
		const clauses = [makeClause({ op: 'before' })];
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
		expect(Array.isArray(result)).toBe(true);
		expect((result as DatadogTargetingRule[])[0].conditions).toHaveLength(2);
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
		const result = buildAllocations(flag, envMapping);

		// Should have: 1 target + 1 rule + 1 fallthrough = 3 allocations
		expect(Array.isArray(result)).toBe(true);
		const allocations = result as DatadogAllocationForFlagCreation[];
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
		const result = buildAllocations(flag, envMapping);

		expect(Array.isArray(result)).toBe(true);
		const allocations = result as DatadogAllocationForFlagCreation[];
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
							clauses: [makeClause({ op: 'before' })],
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
		const result = buildAllocations(flag, envMapping);

		// before rule skipped, but "in" rule + fallthrough remain
		expect(Array.isArray(result)).toBe(true);
		const allocations = result as DatadogAllocationForFlagCreation[];
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
		const result = buildAllocations(flag, envMapping);

		// Only fallthrough, disabled rule skipped
		expect(Array.isArray(result)).toBe(true);
		const allocations = result as DatadogAllocationForFlagCreation[];
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
		const result = buildAllocations(flag, envMapping);

		expect(Array.isArray(result)).toBe(true);
		const allocations = result as DatadogAllocationForFlagCreation[];
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

// ─── findProjectEditorRoleKeys ────────────────────────────────────────────────

describe('findProjectEditorRoleKeys', () => {
	it('matches role with exact project resource pattern', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'editor',
				name: 'Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project')).toEqual(
			new Set(['editor']),
		);
	});

	it('matches role with wildcard project resource', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'super-editor',
				name: 'Super Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['createFlag'],
						resources: ['proj/*:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'any-project')).toEqual(
			new Set(['super-editor']),
		);
	});

	it('matches role with proj/key:* shorthand', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'proj-admin',
				name: 'Project Admin',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlag'],
						resources: ['proj/my-project:*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project')).toEqual(
			new Set(['proj-admin']),
		);
	});

	it('matches role with wildcard actions', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'admin',
				name: 'Admin',
				policy: [
					{
						effect: 'allow',
						actions: ['*'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project')).toEqual(
			new Set(['admin']),
		);
	});

	it('does not match role with non-edit actions only', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'viewer',
				name: 'Viewer',
				policy: [
					{
						effect: 'allow',
						actions: ['viewProject'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project').size).toBe(0);
	});

	it('does not match role targeting a different project', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'editor',
				name: 'Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/other-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project').size).toBe(0);
	});

	it('does not match deny-only statements', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'denied',
				name: 'Denied',
				policy: [
					{
						effect: 'deny',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project').size).toBe(0);
	});

	it('matches role using notResources that excludes other projects', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'broad-editor',
				name: 'Broad Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						notResources: ['proj/secret-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project')).toEqual(
			new Set(['broad-editor']),
		);
	});

	it('does NOT match notResources that excludes the requested project', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'excluded-editor',
				name: 'Excluded',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						notResources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project').size).toBe(0);
	});

	it('matches notActions that does not exclude all edit actions', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'most-actions',
				name: 'Most Actions',
				policy: [
					{
						effect: 'allow',
						notActions: ['deleteFlag'], // updateFlag still allowed
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project')).toEqual(
			new Set(['most-actions']),
		);
	});

	it('does not match notActions of "*" (excludes everything)', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'no-actions',
				name: 'No Actions',
				policy: [
					{
						effect: 'allow',
						notActions: ['*'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project').size).toBe(0);
	});

	it('deny on the same project overrides allow (deny wins)', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'mixed',
				name: 'Mixed',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
					{
						effect: 'deny',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		expect(findProjectEditorRoleKeys(roles, 'my-project').size).toBe(0);
	});
});

// ─── findTeamsWithEditAccess ──────────────────────────────────────────────────

describe('findTeamsWithEditAccess', () => {
	it('returns teams whose roles include any editor role key', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
			{ key: 'sre', name: 'SRE', roles: [{ key: 'viewer' }] },
			{
				key: 'security',
				name: 'Security',
				roles: [{ key: 'viewer' }, { key: 'editor' }],
			},
		];
		const editorRoleKeys = new Set(['editor']);
		expect(findTeamsWithEditAccess(teams, editorRoleKeys)).toEqual(
			new Set(['platform', 'security']),
		);
	});

	it('returns empty set when no team has any editor role', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [{ key: 'viewer' }] },
		];
		expect(findTeamsWithEditAccess(teams, new Set(['editor']))).toEqual(
			new Set(),
		);
	});

	it('returns empty set for empty teams list', () => {
		expect(findTeamsWithEditAccess([], new Set(['editor']))).toEqual(new Set());
	});

	it('returns empty set when editorRoleKeys is empty', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
		];
		expect(findTeamsWithEditAccess(teams, new Set())).toEqual(new Set());
	});

	it('skips teams with no role assignments', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [] },
		];
		expect(findTeamsWithEditAccess(teams, new Set(['editor']))).toEqual(
			new Set(),
		);
	});
});

// ─── resolveSegmentMatch ──────────────────────────────────────────────────────

describe('resolveSegmentMatch', () => {
	it('returns AND combine for negated single segment', () => {
		const lookup = new Map([['seg-a:prod:true', 'sf-not-a']]);
		const clause = makeClause({
			op: 'segmentMatch',
			values: ['seg-a'],
			negate: true,
		});
		const res = resolveSegmentMatch(clause, 'prod', lookup);
		expect(res).toEqual({ combine: 'AND', savedFilterIds: ['sf-not-a'] });
	});

	it('returns OR combine for non-negated single segment', () => {
		const lookup = new Map([['seg-a:prod:false', 'sf-a']]);
		const clause = makeClause({
			op: 'segmentMatch',
			values: ['seg-a'],
			negate: false,
		});
		const res = resolveSegmentMatch(clause, 'prod', lookup);
		expect(res).toEqual({ combine: 'OR', savedFilterIds: ['sf-a'] });
	});

	it('returns OR combine for non-negated multi-segment', () => {
		const lookup = new Map([
			['seg-a:prod:false', 'sf-a'],
			['seg-b:prod:false', 'sf-b'],
		]);
		const clause = makeClause({
			op: 'segmentMatch',
			values: ['seg-a', 'seg-b'],
			negate: false,
		});
		const res = resolveSegmentMatch(clause, 'prod', lookup);
		expect(res).toEqual({ combine: 'OR', savedFilterIds: ['sf-a', 'sf-b'] });
	});

	it('returns AND combine for negated multi-segment', () => {
		const lookup = new Map([
			['seg-a:prod:true', 'sf-not-a'],
			['seg-b:prod:true', 'sf-not-b'],
		]);
		const clause = makeClause({
			op: 'segmentMatch',
			values: ['seg-a', 'seg-b'],
			negate: true,
		});
		const res = resolveSegmentMatch(clause, 'prod', lookup);
		expect(res).toEqual({
			combine: 'AND',
			savedFilterIds: ['sf-not-a', 'sf-not-b'],
		});
	});

	it('returns skip for empty values array', () => {
		const clause = makeClause({
			op: 'segmentMatch',
			values: [],
			negate: false,
		});
		const res = resolveSegmentMatch(clause, 'prod', new Map());
		expect('skip' in res).toBe(true);
	});

	it('returns skip if any segment is missing from lookup', () => {
		const lookup = new Map([['seg-a:prod:false', 'sf-a']]);
		const clause = makeClause({
			op: 'segmentMatch',
			values: ['seg-a', 'seg-missing'],
			negate: false,
		});
		const res = resolveSegmentMatch(clause, 'prod', lookup);
		expect('skip' in res).toBe(true);
	});
});

// ─── buildTargetingRules — segmentMatch support ───────────────────────────────

describe('buildTargetingRules — segmentMatch', () => {
	it('pure segmentMatch single segment → one rule with one SF-ref condition', () => {
		const lookup = new Map([['seg-a:prod:false', 'sf-a']]);
		const clauses = [
			makeClause({ op: 'segmentMatch', values: ['seg-a'], negate: false }),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(true);
		const rules = result as DatadogTargetingRule[];
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions[0]).toEqual({ saved_filter_id: 'sf-a' });
	});

	it('non-negated multi-segment → one rule per segment (fan-out)', () => {
		const lookup = new Map([
			['seg-a:prod:false', 'sf-a'],
			['seg-b:prod:false', 'sf-b'],
		]);
		const clauses = [
			makeClause({
				op: 'segmentMatch',
				values: ['seg-a', 'seg-b'],
				negate: false,
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(true);
		const rules = result as DatadogTargetingRule[];
		expect(rules).toHaveLength(2);
		expect(rules[0].conditions[0]).toEqual({ saved_filter_id: 'sf-a' });
		expect(rules[1].conditions[0]).toEqual({ saved_filter_id: 'sf-b' });
	});

	it("negated multi-segment → one rule with all negated SF-refs AND'd", () => {
		const lookup = new Map([
			['seg-a:prod:true', 'sf-not-a'],
			['seg-b:prod:true', 'sf-not-b'],
		]);
		const clauses = [
			makeClause({
				op: 'segmentMatch',
				values: ['seg-a', 'seg-b'],
				negate: true,
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(true);
		const rules = result as DatadogTargetingRule[];
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions).toHaveLength(2);
		expect(rules[0].conditions[0]).toEqual({ saved_filter_id: 'sf-not-a' });
		expect(rules[0].conditions[1]).toEqual({ saved_filter_id: 'sf-not-b' });
	});

	it('mixed rule: segmentMatch AND inline clause → SF-ref + inline in same rule', () => {
		const lookup = new Map([['seg-a:prod:false', 'sf-a']]);
		const clauses = [
			makeClause({ op: 'segmentMatch', values: ['seg-a'], negate: false }),
			makeClause({
				_id: 'c2',
				op: 'in',
				attribute: 'country',
				values: ['US'],
				negate: false,
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(true);
		const rules = result as DatadogTargetingRule[];
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions).toHaveLength(2);
		expect(rules[0].conditions[0]).toEqual({ saved_filter_id: 'sf-a' });
		expect(rules[0].conditions[1]).toEqual({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US'],
		});
	});

	it('non-negated multi-segment AND inline → fan-out with inline in each rule', () => {
		const lookup = new Map([
			['seg-a:prod:false', 'sf-a'],
			['seg-b:prod:false', 'sf-b'],
		]);
		const clauses = [
			makeClause({
				op: 'segmentMatch',
				values: ['seg-a', 'seg-b'],
				negate: false,
			}),
			makeClause({
				_id: 'c2',
				op: 'semVerGreaterThan',
				attribute: 'version',
				values: ['2.0.0'],
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(true);
		const rules = result as DatadogTargetingRule[];
		expect(rules).toHaveLength(2);
		for (const r of rules) {
			expect(r.conditions).toHaveLength(2);
			expect(r.conditions[1]).toEqual({
				operator: 'SEMVER_GT',
				attribute: 'version',
				value: ['2.0.0'],
			});
		}
	});

	it('returns flagSkip when a segment is missing from lookup', () => {
		const clauses = [
			makeClause({
				op: 'segmentMatch',
				values: ['missing-seg'],
				negate: false,
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', new Map());
		expect(result).not.toBeNull();
		expect(Array.isArray(result)).toBe(false);
		expect((result as { flagSkip: string }).flagSkip).toBeDefined();
	});

	it('returns flagSkip when fan-out exceeds 100 groups', () => {
		// Two OR-combine clauses with 11 values each → 11×11=121 > 100
		const ids = Array.from({ length: 11 }, (_, i) => `seg-${i}`);
		const lookup = new Map(ids.map((k) => [`${k}:prod:false`, `sf-${k}`]));
		const clauses = [
			makeClause({ op: 'segmentMatch', values: [...ids], negate: false }),
			makeClause({
				_id: 'c2',
				op: 'segmentMatch',
				values: [...ids],
				negate: false,
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(false);
		expect((result as { flagSkip: string }).flagSkip).toContain('fan-out');
	});

	it('Case 5: non-negated multi-segment (OR) + negated segment (AND) + inline → 2 rules each with AND-ref and inline', () => {
		// OR-combine: seg-a,seg-b → fans out to 2 rules
		// AND-combine: NOT seg-c → AND'd into every fanned-out rule
		// inline: country=US → AND'd into every fanned-out rule
		const lookup = new Map([
			['seg-a:prod:false', 'sf-a'],
			['seg-b:prod:false', 'sf-b'],
			['seg-c:prod:true', 'sf-not-c'],
		]);
		const clauses = [
			makeClause({
				op: 'segmentMatch',
				values: ['seg-a', 'seg-b'],
				negate: false,
			}),
			makeClause({
				_id: 'c2',
				op: 'segmentMatch',
				values: ['seg-c'],
				negate: true,
			}),
			makeClause({
				_id: 'c3',
				op: 'in',
				attribute: 'country',
				values: ['US'],
				negate: false,
			}),
		];
		const result = buildTargetingRules(clauses, 'prod', lookup);
		expect(Array.isArray(result)).toBe(true);
		const rules = result as DatadogTargetingRule[];
		expect(rules).toHaveLength(2);
		// Each rule: [sf-a or sf-b (OR-selected), sf-not-c (AND), country:US (inline)]
		expect(rules[0].conditions).toHaveLength(3);
		expect(rules[1].conditions).toHaveLength(3);
		expect(rules[0].conditions[0]).toEqual({ saved_filter_id: 'sf-a' });
		expect(rules[0].conditions[1]).toEqual({ saved_filter_id: 'sf-not-c' });
		expect(rules[0].conditions[2]).toEqual({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US'],
		});
		expect(rules[1].conditions[0]).toEqual({ saved_filter_id: 'sf-b' });
		expect(rules[1].conditions[1]).toEqual({ saved_filter_id: 'sf-not-c' });
		expect(rules[1].conditions[2]).toEqual({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US'],
		});
	});
});

// ─── buildAllocations — segmentMatch support ──────────────────────────────────

describe('buildAllocations — segmentMatch', () => {
	it('builds SF-ref allocation for a pure segmentMatch rule', () => {
		const lookup = new Map([['seg-a:production:false', 'sf-a']]);
		const flag = makeFlag({
			key: 'f1',
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
							clauses: [
								makeClause({
									op: 'segmentMatch',
									values: ['seg-a'],
									negate: false,
								}),
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
		const result = buildAllocations(flag, envMapping, lookup);
		expect(Array.isArray(result)).toBe(true);
		const allocs = result as DatadogAllocationForFlagCreation[];
		// rule allocation + fallthrough = 2
		expect(allocs).toHaveLength(2);
		expect(allocs[0].targeting_rules?.[0].conditions[0]).toEqual({
			saved_filter_id: 'sf-a',
		});
	});

	it('returns flagSkip object when segment is missing from lookup', () => {
		const flag = makeFlag({
			key: 'f1',
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
							clauses: [
								makeClause({
									op: 'segmentMatch',
									values: ['missing'],
									negate: false,
								}),
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
		const result = buildAllocations(flag, envMapping, new Map());
		expect(Array.isArray(result)).toBe(false);
		expect((result as { flagSkip: string }).flagSkip).toBeDefined();
	});

	it('fan-out creates multiple targeting rules within the same allocation', () => {
		const lookup = new Map([
			['seg-a:production:false', 'sf-a'],
			['seg-b:production:false', 'sf-b'],
		]);
		const flag = makeFlag({
			key: 'f1',
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
							clauses: [
								makeClause({
									op: 'segmentMatch',
									values: ['seg-a', 'seg-b'],
									negate: false,
								}),
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
		const result = buildAllocations(flag, envMapping, lookup);
		expect(Array.isArray(result)).toBe(true);
		const allocs = result as DatadogAllocationForFlagCreation[];
		const ruleAlloc = allocs.find((a) => a.key.includes('rule'));
		expect(ruleAlloc?.targeting_rules).toHaveLength(2);
	});

	it('variation/rollout carryover: each fanned-out targeting rule inherits the original rollout', () => {
		const lookup = new Map([
			['seg-a:production:false', 'sf-a'],
			['seg-b:production:false', 'sf-b'],
		]);
		const flag = makeFlag({
			key: 'f1',
			environments: {
				production: {
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							rollout: {
								variations: [
									{ variation: 0, weight: 30000 },
									{ variation: 1, weight: 70000 },
								],
							},
							clauses: [
								makeClause({
									op: 'segmentMatch',
									values: ['seg-a', 'seg-b'],
									negate: false,
								}),
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
		const result = buildAllocations(flag, envMapping, lookup);
		expect(Array.isArray(result)).toBe(true);
		const allocs = result as DatadogAllocationForFlagCreation[];
		const ruleAlloc = allocs.find((a) => a.key.includes('rule'));
		if (!ruleAlloc) return;
		expect(ruleAlloc.targeting_rules).toHaveLength(2);
		expect(ruleAlloc.variant_weights).toEqual([
			{ variant_key: 'true', value: 30 },
			{ variant_key: 'false', value: 70 },
		]);
	});

	it("multiple negated segmentMatch clauses AND'd in one rule — all SF-refs in one targeting rule", () => {
		const lookup = new Map([
			['seg-a:production:true', 'sf-not-a'],
			['seg-b:production:true', 'sf-not-b'],
		]);
		const flag = makeFlag({
			key: 'f1',
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
							clauses: [
								makeClause({
									op: 'segmentMatch',
									values: ['seg-a'],
									negate: true,
								}),
								makeClause({
									_id: 'c2',
									op: 'segmentMatch',
									values: ['seg-b'],
									negate: true,
								}),
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
		const result = buildAllocations(
			flag,
			new Map([['production', ddProd]]),
			lookup,
		);
		expect(Array.isArray(result)).toBe(true);
		const allocs = result as DatadogAllocationForFlagCreation[];
		const ruleAlloc = allocs.find((a) => a.key.includes('rule'));
		if (!ruleAlloc) return;
		expect(ruleAlloc.targeting_rules).toHaveLength(1);
		expect(ruleAlloc.targeting_rules?.[0].conditions).toHaveLength(2);
		expect(ruleAlloc.targeting_rules?.[0].conditions[0]).toEqual({
			saved_filter_id: 'sf-not-a',
		});
		expect(ruleAlloc.targeting_rules?.[0].conditions[1]).toEqual({
			saved_filter_id: 'sf-not-b',
		});
	});
});
