import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../../src/datadog/api.js';
import type { DatadogEnvironment } from '../../src/datadog/types.js';
import { ldClient } from '../../src/launchdarkly/api.js';
import { buildTargetingRules } from '../../src/launchdarkly/helpers/migration.js';
import {
	buildNegatedRules,
	buildNonNegatedRules,
	discoverSegmentRefs,
	getCreationType,
	migrateSegments,
	planDryRunSegments,
	renderSavedFilterName,
} from '../../src/launchdarkly/segments.js';
import type {
	LDClause,
	LDFlag,
	LDRule,
	LDSegment,
} from '../../src/launchdarkly/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClause(overrides: Partial<LDClause> = {}): LDClause {
	return {
		_id: 'c1',
		attribute: 'key',
		op: 'in',
		values: ['user-1'],
		contextKind: 'user',
		negate: false,
		...overrides,
	};
}

function makeRule(
	clauses: LDClause[],
	overrides: Partial<LDRule> = {},
): LDRule {
	return {
		_id: 'r1',
		clauses,
		trackEvents: false,
		...overrides,
	};
}

function makeSegment(
	overrides: Partial<LDSegment> & { key: string },
): LDSegment {
	return {
		name: overrides.key,
		description: undefined,
		tags: [],
		included: [],
		excluded: [],
		includedContexts: [],
		excludedContexts: [],
		rules: [],
		deleted: false,
		_flags: [],
		...overrides,
	};
}

function makeFlag(key: string, envKey: string, clauses: LDClause[]): LDFlag {
	return {
		name: key,
		kind: 'boolean',
		key,
		variations: [
			{ _id: 'v0', value: true },
			{ _id: 'v1', value: false },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
		environments: {
			[envKey]: {
				on: true,
				archived: false,
				targets: [],
				contextTargets: [],
				rules: [makeRule(clauses)],
				fallthrough: { variation: 1 },
				offVariation: 1,
				prerequisites: [],
				_environmentName: envKey,
			},
		},
	};
}

const ddProd: DatadogEnvironment = {
	id: 'dd-prod',
	name: 'Production',
	is_production: true,
	queries: ['prod'],
};

// ─── discoverSegmentRefs ──────────────────────────────────────────────────────

describe('discoverSegmentRefs', () => {
	it('collects non-negated segmentMatch refs', () => {
		const flag = makeFlag('f1', 'prod', [
			makeClause({ op: 'segmentMatch', values: ['seg-a'], negate: false }),
		]);
		const refs = discoverSegmentRefs([flag], ['prod']);
		expect(refs).toContainEqual({
			segmentKey: 'seg-a',
			envKey: 'prod',
			negated: false,
		});
	});

	it('collects negated segmentMatch refs', () => {
		const flag = makeFlag('f1', 'prod', [
			makeClause({ op: 'segmentMatch', values: ['seg-a'], negate: true }),
		]);
		const refs = discoverSegmentRefs([flag], ['prod']);
		expect(refs).toContainEqual({
			segmentKey: 'seg-a',
			envKey: 'prod',
			negated: true,
		});
	});

	it('deduplicates identical refs', () => {
		const clause = makeClause({
			op: 'segmentMatch',
			values: ['seg-a'],
			negate: false,
		});
		const f1 = makeFlag('f1', 'prod', [clause]);
		const f2 = makeFlag('f2', 'prod', [clause]);
		const refs = discoverSegmentRefs([f1, f2], ['prod']);
		const matches = refs.filter(
			(r) => r.segmentKey === 'seg-a' && r.envKey === 'prod' && !r.negated,
		);
		expect(matches).toHaveLength(1);
	});

	it('handles multi-value segmentMatch clause — one ref per value', () => {
		const flag = makeFlag('f1', 'prod', [
			makeClause({
				op: 'segmentMatch',
				values: ['seg-a', 'seg-b'],
				negate: false,
			}),
		]);
		const refs = discoverSegmentRefs([flag], ['prod']);
		expect(refs).toContainEqual({
			segmentKey: 'seg-a',
			envKey: 'prod',
			negated: false,
		});
		expect(refs).toContainEqual({
			segmentKey: 'seg-b',
			envKey: 'prod',
			negated: false,
		});
	});

	it('only scans environments listed in envKeys', () => {
		const flag = makeFlag('f1', 'staging', [
			makeClause({ op: 'segmentMatch', values: ['seg-a'], negate: false }),
		]);
		const refs = discoverSegmentRefs([flag], ['prod']);
		expect(refs).toHaveLength(0);
	});

	it('ignores non-segmentMatch clauses', () => {
		const flag = makeFlag('f1', 'prod', [
			makeClause({ op: 'in', attribute: 'country', values: ['US'] }),
		]);
		const refs = discoverSegmentRefs([flag], ['prod']);
		expect(refs).toHaveLength(0);
	});
});

// ─── getCreationType ──────────────────────────────────────────────────────────

describe('getCreationType', () => {
	it('returns LIST for single rule, single key-in clause, no excluded', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([makeClause({ op: 'in', attribute: 'key', values: ['u1'] })]),
			],
		});
		expect(getCreationType(seg)).toBe('LIST');
	});

	it('returns RULES for a list-shaped segment with excluded', () => {
		const seg = makeSegment({
			key: 's',
			excluded: ['u-bad'],
			rules: [
				makeRule([makeClause({ op: 'in', attribute: 'key', values: ['u1'] })]),
			],
		});
		expect(getCreationType(seg)).toBe('RULES');
	});

	it('returns RULES for multi-rule segment', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([makeClause({ op: 'in', attribute: 'key', values: ['u1'] })]),
				makeRule(
					[makeClause({ op: 'in', attribute: 'country', values: ['US'] })],
					{ _id: 'r2' },
				),
			],
		});
		expect(getCreationType(seg)).toBe('RULES');
	});

	it('returns RULES for a non-key attribute', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'country', values: ['US'] }),
				]),
			],
		});
		expect(getCreationType(seg)).toBe('RULES');
	});

	it('returns RULES for included-only segment (no rules)', () => {
		const seg = makeSegment({ key: 's', included: ['u1', 'u2'] });
		expect(getCreationType(seg)).toBe('RULES');
	});

	it('returns RULES (not LIST) for a non-user contextKind key clause', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({
						op: 'in',
						attribute: 'key',
						values: ['org-1'],
						contextKind: 'org',
					}),
				]),
			],
		});
		expect(getCreationType(seg)).toBe('RULES');
	});
});

// ─── renderSavedFilterName ────────────────────────────────────────────────────

describe('renderSavedFilterName', () => {
	it('renders non-negated name correctly', () => {
		expect(renderSavedFilterName('my-segment', 'production', false)).toBe(
			'my-segment (production)',
		);
	});

	it('renders negated name with NOT prefix', () => {
		expect(renderSavedFilterName('my-segment', 'production', true)).toBe(
			'NOT my-segment (production)',
		);
	});

	it('includes name_prefix', () => {
		expect(renderSavedFilterName('seg', 'prod', false, 'proj-a')).toBe(
			'proj-a-seg (prod)',
		);
	});

	it('returns short name unchanged when within 200 bytes', () => {
		const name = 'a'.repeat(50);
		const result = renderSavedFilterName(name, 'prod', false);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(200);
		expect(result).toContain(name);
	});

	it('truncates segment-name middle when over 200 bytes', () => {
		const longName = 'a'.repeat(210);
		const result = renderSavedFilterName(longName, 'production', false);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(Buffer.byteLength(result, 'utf8')).toBe(200);
		expect(result).toContain('…');
		expect(result).toContain('(production)');
	});

	it('negated truncation preserves NOT prefix and env suffix', () => {
		const longName = 'b'.repeat(210);
		const result = renderSavedFilterName(longName, 'production', true);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(Buffer.byteLength(result, 'utf8')).toBe(200);
		expect(result.startsWith('NOT ')).toBe(true);
		expect(result.endsWith('(production)')).toBe(true);
		expect(result).toContain('…');
	});

	it('returns null when envelope alone exceeds 200 bytes', () => {
		const longPrefix = 'p'.repeat(190);
		const longEnv = 'e'.repeat(10);
		// envelope = "NOT " (4) + "{190-char prefix}-" (191) + "…" (3) + " ({10-char env})" (13) = 211 bytes
		const result = renderSavedFilterName('any', longEnv, true, longPrefix);
		expect(result).toBeNull();
	});

	it('truncation is deterministic across calls', () => {
		const longName = 'x'.repeat(300);
		const r1 = renderSavedFilterName(longName, 'prod', false);
		const r2 = renderSavedFilterName(longName, 'prod', false);
		expect(r1).toBe(r2);
	});

	it('truncation respects UTF-8 codepoint boundaries (no mid-codepoint slice)', () => {
		// Each '日' is 3 bytes in UTF-8; fill to just over 200 bytes to trigger truncation
		const longName = '日'.repeat(80); // 240 bytes
		const result = renderSavedFilterName(longName, 'prod', false);
		expect(result).not.toBeNull();
		if (!result) return;
		// Result must be valid UTF-8 (Buffer.from will throw on invalid UTF-8)
		expect(() => Buffer.from(result, 'utf8').toString('utf8')).not.toThrow();
		expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(200);
		expect(result).toContain('…');
	});
});

describe('segment attribute compatibility with flag targeting', () => {
	it.each([
		['user', 'key', 'id'],
		[undefined, 'key', 'id'],
		['ld_device', 'key', 'ld_device.key'],
		['org', 'key', 'org.key'],
		['user', '/key', 'id'],
		['org', '/key', 'org.key'],
		['ld_device', '/key', 'ld_device.key'],
		[undefined, '/key', '/key'],
		['user', '/profile/key', '/profile/key'],
		['user', '/~1key', '/~1key'],
		['user', 'profile/key', 'profile/key'],
		['ld_device', '/os/name', 'ld_device.osname'],
		['user', 'id', 'id'],
	])('%s + %s remains consistent with flag targeting', (contextKind, attribute, expected) => {
		const clause = makeClause({ contextKind, attribute });
		const segment = makeSegment({ key: 's', rules: [makeRule([clause])] });
		const conditions = [
			{ operator: 'ONE_OF', attribute: expected, value: ['user-1'] },
		];
		expect(buildTargetingRules([clause])).toEqual([{ conditions }]);
		expect(buildTargetingRules([{ ...clause, negate: true }])).toEqual([
			{ conditions: [{ ...conditions[0], operator: 'NOT_ONE_OF' }] },
		]);
		expect(buildNonNegatedRules(segment)).toEqual([{ conditions }]);
		expect(buildNegatedRules(segment)).toEqual([
			{ conditions: [{ ...conditions[0], operator: 'NOT_ONE_OF' }] },
		]);
		const negatedClauseSegment = makeSegment({
			key: 's',
			rules: [makeRule([{ ...clause, negate: true }])],
		});
		expect(buildNonNegatedRules(negatedClauseSegment)).toEqual([
			{ conditions: [{ ...conditions[0], operator: 'NOT_ONE_OF' }] },
		]);
		expect(buildNegatedRules(negatedClauseSegment)).toEqual([{ conditions }]);
	});
});

// ─── buildNonNegatedRules ─────────────────────────────────────────────────────

describe('buildNonNegatedRules', () => {
	it('maps a single rule clause to one targeting rule', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'tenant', values: ['acme'] }),
				]),
			],
		});
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'tenant',
			value: ['acme'],
		});
	});

	it('prefixes non-user contextKind on clause attribute', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				{
					_id: 'r1',
					clauses: [
						makeClause({
							attribute: 'plan',
							op: 'in',
							values: ['enterprise'],
							contextKind: 'org',
						}),
					],
					trackEvents: false,
				},
			],
		});
		const rules = buildNonNegatedRules(seg);
		expect(rules).not.toBeNull();
		const cond = rules?.[0].conditions[0];
		expect(cond?.attribute).toBe('org.plan');
		expect(cond?.operator).toBe('ONE_OF');
		expect(cond?.value).toEqual(['enterprise']);
	});

	it('strips slashes from LaunchDarkly built-in attributes', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({
						attribute: '/os/name',
						contextKind: 'ld_device',
						values: ['macOS'],
					}),
				]),
			],
		});

		expect(buildNonNegatedRules(seg)?.[0].conditions[0].attribute).toBe(
			'ld_device.osname',
		);
	});

	it('preserves literal user attributes that start with ld_', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({
						attribute: 'ld_profile/name',
						contextKind: 'user',
						values: ['pro'],
					}),
				]),
			],
		});

		expect(buildNonNegatedRules(seg)?.[0].conditions[0].attribute).toBe(
			'ld_profile/name',
		);
	});

	it('multi-rule segment → one targeting rule per rule (OR semantics)', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'plan', values: ['beta'] }),
				]),
				makeRule(
					[makeClause({ op: 'in', attribute: 'role', values: ['qa'] })],
					{ _id: 'r2' },
				),
			],
		});
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(2);
	});

	it('included list adds an extra OR group with ONE_OF on id', () => {
		const seg = makeSegment({ key: 's', included: ['u1', 'u2'] });
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'id',
			value: ['u1', 'u2'],
		});
	});

	it('excluded adds NOT_ONE_OF on id into every group', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'plan', values: ['pro'] }),
				]),
			],
			excluded: ['bad-user'],
		});
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions).toHaveLength(2);
		expect(result?.[0].conditions[1]).toEqual({
			operator: 'NOT_ONE_OF',
			attribute: 'id',
			value: ['bad-user'],
		});
	});

	it('rules + included + excluded: full formula (rules∨included)∧¬excluded', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'plan', values: ['pro'] }),
				]),
			],
			included: ['vip-user'],
			excluded: ['banned'],
		});
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(2); // rule group + included group
		if (!result) return;
		for (const r of result) {
			const notOneOf = r.conditions.find(
				(c) => c.operator === 'NOT_ONE_OF' && c.attribute === 'id',
			);
			expect(notOneOf).toBeDefined();
			expect(notOneOf?.value).toEqual(['banned']);
		}
	});

	it('returns null for segment with multi-context includedContexts', () => {
		const seg = makeSegment({
			key: 's',
			includedContexts: [{ contextKind: 'org', values: ['org-1'] }],
		});
		expect(buildNonNegatedRules(seg)).toBeNull();
	});

	it('returns null for segment with multi-context excludedContexts', () => {
		const seg = makeSegment({
			key: 's',
			excludedContexts: [{ contextKind: 'device', values: ['ios'] }],
		});
		expect(buildNonNegatedRules(seg)).toBeNull();
	});

	it('returns null for nested segment (segmentMatch in segment rules)', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([makeClause({ op: 'segmentMatch', values: ['other-seg'] })]),
			],
		});
		expect(buildNonNegatedRules(seg)).toBeNull();
	});

	it('returns null for a rule with an unsupported operator', () => {
		const seg = makeSegment({
			key: 's',
			rules: [makeRule([makeClause({ op: 'before', values: ['2024-01-01'] })])],
		});
		expect(buildNonNegatedRules(seg)).toBeNull();
	});

	it('empty segment (no rules, no included, no excluded): returns empty array', () => {
		const seg = makeSegment({ key: 's' });
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(0);
	});
});

// ─── buildNegatedRules ────────────────────────────────────────────────────────

describe('buildNegatedRules', () => {
	it('negates a single-rule single-clause segment', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'tenant', values: ['acme'] }),
				]),
			],
		});
		const result = buildNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions[0]).toEqual({
			operator: 'NOT_ONE_OF',
			attribute: 'tenant',
			value: ['acme'],
		});
	});

	it('strips slashes from LaunchDarkly built-in attributes', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({
						attribute: '/os/name',
						contextKind: 'ld_device',
						values: ['macOS'],
					}),
				]),
			],
		});

		expect(buildNegatedRules(seg)?.[0].conditions[0].attribute).toBe(
			'ld_device.osname',
		);
	});

	it('negates 2 rules of 2 clauses → 4 result groups (2×2 Cartesian)', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'employee', values: ['true'] }),
					makeClause({
						_id: 'c2',
						op: 'in',
						attribute: 'plan',
						values: ['beta'],
					}),
				]),
				makeRule(
					[
						makeClause({
							_id: 'c3',
							op: 'in',
							attribute: 'role',
							values: ['qa'],
						}),
						makeClause({
							_id: 'c4',
							op: 'in',
							attribute: 'org_id',
							values: ['1', '2'],
						}),
					],
					{ _id: 'r2' },
				),
			],
		});
		const result = buildNegatedRules(seg);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result).toHaveLength(4);
		for (const r of result) {
			for (const c of r.conditions) {
				expect(c.operator).toBe('NOT_ONE_OF');
			}
		}
	});

	it('included-only segment (no rules): negated produces single group with NOT_ONE_OF', () => {
		const seg = makeSegment({ key: 's', included: ['u1', 'u2'] });
		const result = buildNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions).toHaveLength(1);
		expect(result?.[0].conditions[0]).toEqual({
			operator: 'NOT_ONE_OF',
			attribute: 'id',
			value: ['u1', 'u2'],
		});
	});

	it('included-only + excluded: (¬included) ∨ excluded → two groups', () => {
		const seg = makeSegment({
			key: 's',
			included: ['u1'],
			excluded: ['u-bad'],
		});
		const result = buildNegatedRules(seg);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.conditions[0].attribute)).toEqual(['id', 'id']);
		const hasNotOneOf = result.some(
			(r) =>
				r.conditions[0].operator === 'NOT_ONE_OF' &&
				r.conditions[0].value?.includes('u1'),
		);
		const hasOneOf = result.some(
			(r) =>
				r.conditions[0].operator === 'ONE_OF' &&
				r.conditions[0].value?.includes('u-bad'),
		);
		expect(hasNotOneOf).toBe(true);
		expect(hasOneOf).toBe(true);
	});

	it('rules + excluded: negated ¬rules groups AND NOT_ONE_OF excluded; excluded group is OR', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([
					makeClause({ op: 'in', attribute: 'plan', values: ['pro'] }),
				]),
			],
			excluded: ['banned'],
		});
		const result = buildNegatedRules(seg);
		expect(result).not.toBeNull();
		// ¬rules = 1 group (NOT_ONE_OF plan pro); + excluded group (ONE_OF id banned)
		expect(result).toHaveLength(2);
	});

	it('returns null for explosion guard exceeded', () => {
		const fiveClauses = Array.from({ length: 5 }, (_, i) =>
			makeClause({
				_id: `c${i}`,
				attribute: `a${i}`,
				op: 'in',
				values: [`v${i}`],
			}),
		);
		const seg = makeSegment({
			key: 's',
			rules: Array.from({ length: 5 }, (_, i) =>
				makeRule(fiveClauses, { _id: `r${i}` }),
			),
		});
		expect(buildNegatedRules(seg)).toBeNull();
	});

	it('returns null for nested segment in rules', () => {
		const seg = makeSegment({
			key: 's',
			rules: [
				makeRule([makeClause({ op: 'segmentMatch', values: ['other'] })]),
			],
		});
		expect(buildNegatedRules(seg)).toBeNull();
	});

	it('returns null for multi-context segment', () => {
		const seg = makeSegment({
			key: 's',
			includedContexts: [{ contextKind: 'org', values: ['o1'] }],
		});
		expect(buildNegatedRules(seg)).toBeNull();
	});

	it('empty segment (no rules, no included, no excluded): returns single group with zero conditions (tautology)', () => {
		const seg = makeSegment({ key: 's' });
		const result = buildNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions).toHaveLength(0);
	});
});

// ─── planDryRunSegments ───────────────────────────────────────────────────────

describe('segment re-migration compatibility', () => {
	let ldMock: AxiosMockAdapter;
	let ddMock: AxiosMockAdapter;

	beforeEach(() => {
		ldMock = new AxiosMockAdapter(ldClient as never);
		ddMock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		ldMock.restore();
		ddMock.restore();
	});

	it.each(
		[
			{
				attribute: 'key',
				contextKind: 'user',
				creationType: 'LIST',
				expected: 'id',
			},
			{
				attribute: '/key',
				contextKind: 'user',
				creationType: 'RULES',
				expected: 'id',
			},
			{
				attribute: '/key',
				contextKind: 'org',
				creationType: 'RULES',
				expected: 'org.key',
			},
			{
				attribute: '/key',
				contextKind: undefined,
				creationType: 'RULES',
				expected: '/key',
			},
		].flatMap((testCase) => [
			{ ...testCase, negated: false },
			{ ...testCase, negated: true },
		]),
	)('updates $contextKind $attribute (negated=$negated) in place on repeated migrations', async ({
		attribute,
		contextKind,
		negated,
		creationType,
		expected,
	}) => {
		const segment = makeSegment({
			key: 's',
			rules: [makeRule([makeClause({ attribute, contextKind })])],
		});
		const metadata = {
			provider: 'launchdarkly',
			project_key: 'project',
			segment_key: 's',
			environment_key: 'prod',
			negated,
		};
		const operator = negated ? 'NOT_ONE_OF' : 'ONE_OF';
		const stored = {
			id: 'existing-filter-id',
			attributes: {
				name: `${negated ? 'NOT ' : ''}s (prod)`,
				creation_type: creationType,
				migration_metadata: metadata,
				targeting_rules: [
					{
						conditions: [
							{
								operator,
								attribute:
									contextKind && contextKind !== 'user'
										? `${contextKind}.${attribute}`
										: attribute,
								value: ['user-1'],
							},
						],
					},
				],
			},
		};
		ldMock
			.onGet(
				'https://app.launchdarkly.com/api/v2/segments/project/prod?limit=50',
			)
			.reply(200, { items: [segment] });
		const url = 'https://api.datadoghq.com/api/v2/feature-flags/saved-filters';
		ddMock
			.onGet(url)
			.reply(() => [200, { data: [stored], meta: { total: 1 } }]);
		ddMock.onPut(`${url}/${stored.id}`).reply((config) => {
			const body = JSON.parse(config.data);
			expect(body.data.id).toBe(stored.id);
			expect(body.data.attributes).toEqual({
				...stored.attributes,
				...(negated ? { description: 'Inverse of s' } : {}),
				targeting_rules: [
					{
						conditions: [{ operator, attribute: expected, value: ['user-1'] }],
					},
				],
			});
			stored.attributes = body.data.attributes;
			return [200, {}];
		});
		for (let run = 0; run < 2; run++) {
			const result = await migrateSegments({
				ldApiKey: 'test-ld-key',
				projectKey: 'project',
				selectedFlags: [
					makeFlag('f1', 'prod', [
						makeClause({ op: 'segmentMatch', values: ['s'], negate: negated }),
					]),
				],
				envMapping: new Map([['prod', ddProd]]),
				ddApiKey: 'test-dd-key',
				ddAppKey: 'test-dd-app-key',
				ddSite: 'datadoghq.com',
			});
			expect(result.savedFilterLookup.get(`s:prod:${negated}`)).toBe(stored.id);
			expect(result.stats).toMatchObject({
				created: 0,
				reused: 1,
				updated: 1,
				failures: [],
			});
		}
		expect(ddMock.history.put).toHaveLength(2);
		expect(ddMock.history.post).toHaveLength(0);
		expect(ddMock.history.delete).toHaveLength(0);
	});
});

describe('planDryRunSegments', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('folds empty segment refs as constants instead of synthetic saved filters', async () => {
		const flag = makeFlag('f1', 'prod', [
			makeClause({
				op: 'segmentMatch',
				values: ['empty-seg'],
				negate: false,
			}),
			makeClause({
				_id: 'c2',
				op: 'segmentMatch',
				values: ['empty-seg'],
				negate: true,
			}),
			makeClause({
				_id: 'c3',
				op: 'segmentMatch',
				values: ['real-seg'],
				negate: false,
			}),
		]);

		mock
			.onGet(
				'https://app.launchdarkly.com/api/v2/segments/project/prod?limit=50',
			)
			.reply(200, {
				items: [
					makeSegment({ key: 'empty-seg' }),
					makeSegment({ key: 'real-seg', included: ['user-1'] }),
				],
			});

		const result = await planDryRunSegments({
			ldApiKey: 'ld-api-key',
			projectKey: 'project',
			selectedFlags: [flag],
			envMapping: new Map([['prod', ddProd]]),
		});

		expect(result.segmentConstantLookup.get('empty-seg:prod:false')).toBe(
			false,
		);
		expect(result.segmentConstantLookup.get('empty-seg:prod:true')).toBe(true);
		expect(result.savedFilterLookup.has('empty-seg:prod:false')).toBe(false);
		expect(result.savedFilterLookup.has('empty-seg:prod:true')).toBe(false);
		expect(result.savedFilterLookup.get('real-seg:prod:false')).toBe(
			'dry-run-placeholder-0',
		);
	});
});
