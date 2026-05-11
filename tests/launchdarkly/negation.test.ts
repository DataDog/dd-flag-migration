import { describe, expect, it } from '@jest/globals';
import {
	cartesianProduct,
	negateCondition,
	negateTargetingRules,
} from '../../src/launchdarkly/negation.js';
import type {
	DatadogCondition,
	DatadogTargetingRule,
} from '../../src/types.js';

// ─── negateCondition ──────────────────────────────────────────────────────────

describe('negateCondition', () => {
	it('negates ONE_OF to NOT_ONE_OF', () => {
		const c: DatadogCondition = {
			operator: 'ONE_OF',
			attribute: 'key',
			value: ['a'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'NOT_ONE_OF',
			attribute: 'key',
			value: ['a'],
		});
	});

	it('negates NOT_ONE_OF to ONE_OF', () => {
		const c: DatadogCondition = {
			operator: 'NOT_ONE_OF',
			attribute: 'key',
			value: ['b'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'ONE_OF',
			attribute: 'key',
			value: ['b'],
		});
	});

	it('negates MATCHES to NOT_MATCHES', () => {
		const c: DatadogCondition = {
			operator: 'MATCHES',
			attribute: 'email',
			value: ['.*@dd.com'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'NOT_MATCHES',
			attribute: 'email',
			value: ['.*@dd.com'],
		});
	});

	it('negates LT to GTE', () => {
		const c: DatadogCondition = {
			operator: 'LT',
			attribute: 'age',
			value: ['18'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'GTE',
			attribute: 'age',
			value: ['18'],
		});
	});

	it('negates LTE to GT', () => {
		const c: DatadogCondition = {
			operator: 'LTE',
			attribute: 'age',
			value: ['18'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'GT',
			attribute: 'age',
			value: ['18'],
		});
	});

	it('negates GT to LTE', () => {
		const c: DatadogCondition = {
			operator: 'GT',
			attribute: 'age',
			value: ['18'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'LTE',
			attribute: 'age',
			value: ['18'],
		});
	});

	it('negates GTE to LT', () => {
		const c: DatadogCondition = {
			operator: 'GTE',
			attribute: 'age',
			value: ['18'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'LT',
			attribute: 'age',
			value: ['18'],
		});
	});

	it('negates SEMVER_LT to SEMVER_GTE', () => {
		const c: DatadogCondition = {
			operator: 'SEMVER_LT',
			attribute: 'v',
			value: ['2.0.0'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'SEMVER_GTE',
			attribute: 'v',
			value: ['2.0.0'],
		});
	});

	it('negates SEMVER_EQ to SEMVER_NEQ', () => {
		const c: DatadogCondition = {
			operator: 'SEMVER_EQ',
			attribute: 'v',
			value: ['1.0.0'],
		};
		expect(negateCondition(c)).toEqual({
			operator: 'SEMVER_NEQ',
			attribute: 'v',
			value: ['1.0.0'],
		});
	});

	it('returns null for SF-ref condition (no operator)', () => {
		const c: DatadogCondition = { saved_filter_id: 'sf-123' };
		expect(negateCondition(c)).toBeNull();
	});

	it('returns null for unknown operator', () => {
		const c: DatadogCondition = {
			operator: 'UNKNOWN_OP',
			attribute: 'x',
			value: ['y'],
		};
		expect(negateCondition(c)).toBeNull();
	});
});

// ─── cartesianProduct ─────────────────────────────────────────────────────────

describe('cartesianProduct', () => {
	it('returns empty array for empty groups', () => {
		expect(cartesianProduct([])).toEqual([]);
	});

	it('wraps a single one-element group into one targeting rule', () => {
		const c: DatadogCondition = {
			operator: 'ONE_OF',
			attribute: 'a',
			value: ['1'],
		};
		const result = cartesianProduct([[c]]);
		expect(result).toHaveLength(1);
		expect(result[0].conditions).toEqual([c]);
	});

	it('produces 2×2=4 rules for two groups of 2', () => {
		const c1: DatadogCondition = {
			operator: 'ONE_OF',
			attribute: 'a',
			value: ['1'],
		};
		const c2: DatadogCondition = {
			operator: 'ONE_OF',
			attribute: 'a',
			value: ['2'],
		};
		const c3: DatadogCondition = {
			operator: 'ONE_OF',
			attribute: 'b',
			value: ['x'],
		};
		const c4: DatadogCondition = {
			operator: 'ONE_OF',
			attribute: 'b',
			value: ['y'],
		};
		const result = cartesianProduct([
			[c1, c2],
			[c3, c4],
		]);
		expect(result).toHaveLength(4);
		for (const r of result) expect(r.conditions).toHaveLength(2);
		const combos = result.map(
			(r) => `${r.conditions[0].value?.[0]},${r.conditions[1].value?.[0]}`,
		);
		expect(combos).toContain('1,x');
		expect(combos).toContain('1,y');
		expect(combos).toContain('2,x');
		expect(combos).toContain('2,y');
	});

	it('produces 2×3=6 rules for groups of size 2 and 3', () => {
		const g1 = [
			{ operator: 'ONE_OF', attribute: 'a', value: ['1'] } as DatadogCondition,
			{ operator: 'ONE_OF', attribute: 'a', value: ['2'] } as DatadogCondition,
		];
		const g2 = [
			{ operator: 'ONE_OF', attribute: 'b', value: ['x'] } as DatadogCondition,
			{ operator: 'ONE_OF', attribute: 'b', value: ['y'] } as DatadogCondition,
			{ operator: 'ONE_OF', attribute: 'b', value: ['z'] } as DatadogCondition,
		];
		expect(cartesianProduct([g1, g2])).toHaveLength(6);
	});
});

// ─── negateTargetingRules ─────────────────────────────────────────────────────

describe('negateTargetingRules', () => {
	it('returns empty array for empty input', () => {
		expect(negateTargetingRules([])).toEqual([]);
	});

	it('negates a single rule with one condition', () => {
		const rules: DatadogTargetingRule[] = [
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', value: ['US'] },
				],
			},
		];
		expect(negateTargetingRules(rules)).toEqual([
			{
				conditions: [
					{ operator: 'NOT_ONE_OF', attribute: 'country', value: ['US'] },
				],
			},
		]);
	});

	it('negates a single rule with 3 conditions → 3 result groups (De Morgan)', () => {
		const rules: DatadogTargetingRule[] = [
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'a', value: ['1'] },
					{ operator: 'ONE_OF', attribute: 'b', value: ['2'] },
					{ operator: 'ONE_OF', attribute: 'c', value: ['3'] },
				],
			},
		];
		const result = negateTargetingRules(rules);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result).toHaveLength(3);
		for (const r of result) expect(r.conditions).toHaveLength(1);
		expect(result[0].conditions[0].operator).toBe('NOT_ONE_OF');
	});

	it('negates 2 rules of 2 conditions each → 2×2=4 result groups (Cartesian)', () => {
		const rules: DatadogTargetingRule[] = [
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'a', value: ['1'] },
					{ operator: 'ONE_OF', attribute: 'b', value: ['2'] },
				],
			},
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'c', value: ['3'] },
					{ operator: 'ONE_OF', attribute: 'd', value: ['4'] },
				],
			},
		];
		const result = negateTargetingRules(rules);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result).toHaveLength(4);
		for (const r of result) expect(r.conditions).toHaveLength(2);
	});

	it('returns null for a rule with an unknown operator', () => {
		const rules: DatadogTargetingRule[] = [
			{
				conditions: [{ operator: 'UNKNOWN_OP', attribute: 'x', value: ['y'] }],
			},
		];
		expect(negateTargetingRules(rules)).toBeNull();
	});

	it('returns null when the product exceeds 100 groups (explosion guard)', () => {
		// 5 rules × 5 clauses each → 5^5 = 3,125 groups
		const fiveClauses: DatadogCondition[] = Array.from(
			{ length: 5 },
			(_, i) => ({
				operator: 'ONE_OF',
				attribute: `attr${i}`,
				value: [`val${i}`],
			}),
		);
		const rules: DatadogTargetingRule[] = Array.from({ length: 5 }, () => ({
			conditions: [...fiveClauses],
		}));
		expect(negateTargetingRules(rules)).toBeNull();
	});

	it('allows exactly 100 groups (boundary — should not be null)', () => {
		// 2 rules × 10 clauses each → 10^2 = 100 groups (boundary, allowed)
		const tenClauses: DatadogCondition[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				operator: 'ONE_OF',
				attribute: `attr${i}`,
				value: [`val${i}`],
			}),
		);
		const rules: DatadogTargetingRule[] = [
			{ conditions: [...tenClauses] },
			{ conditions: [...tenClauses] },
		];
		const result = negateTargetingRules(rules);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(100);
	});
});
