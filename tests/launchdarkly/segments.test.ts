import { describe, expect, it } from '@jest/globals';
import {
	buildNegatedRules,
	buildNonNegatedRules,
	discoverSegmentRefs,
	getCreationType,
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

	it('included list adds an extra OR group with ONE_OF on key', () => {
		const seg = makeSegment({ key: 's', included: ['u1', 'u2'] });
		const result = buildNonNegatedRules(seg);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1);
		expect(result?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'key',
			value: ['u1', 'u2'],
		});
	});

	it('excluded adds NOT_ONE_OF on key into every group', () => {
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
			attribute: 'key',
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
				(c) => c.operator === 'NOT_ONE_OF' && c.attribute === 'key',
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
			attribute: 'key',
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
		// ¬rules = 1 group (NOT_ONE_OF plan pro); + excluded group (ONE_OF key banned)
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
