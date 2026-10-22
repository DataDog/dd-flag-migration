import { describe, expect, it } from '@jest/globals';
import { distributionChannelForFlag } from '../src/evaluate/datadog-rules.js';
import {
	type Assignment,
	assignmentsMatch,
	compareFlagForSubjects,
	evaluationOutcome,
	formatMismatchLine,
	generateSubjectKeys,
} from '../src/evaluate/flag-comparison.js';

function assigned(
	value: unknown,
	variant = String(value),
	allocation = 'alloc',
): Assignment {
	return { assigned: true, value, variant, allocation };
}

const unassigned = (detail?: string): Assignment => ({
	assigned: false,
	value: undefined,
	variant: null,
	allocation: null,
	detail,
});

describe('generateSubjectKeys', () => {
	it('returns the requested number of unique keys', () => {
		const generated = ['x', 'x', 'y', 'z'];
		const keys = generateSubjectKeys(3, () => generated.shift() ?? 'unused');
		expect(keys).toEqual(['x', 'y', 'z']);
	});

	it('rejects non-positive counts', () => {
		expect(() => generateSubjectKeys(0)).toThrow('positive integer');
		expect(() => generateSubjectKeys(1.5)).toThrow('positive integer');
	});
});

describe('assignmentsMatch', () => {
	it('matches when neither platform assigns a variant', () => {
		expect(
			assignmentsMatch(
				unassigned('FLAG_UNRECOGNIZED_OR_DISABLED'),
				unassigned('DISABLED'),
			),
		).toBe(true);
	});

	it('does not match when only one platform assigns a variant', () => {
		expect(assignmentsMatch(assigned(true), unassigned())).toBe(false);
		expect(assignmentsMatch(unassigned(), assigned(true))).toBe(false);
	});

	it('compares values, not variant keys', () => {
		expect(
			assignmentsMatch(
				assigned('on', 'On Variant'),
				assigned('on', 'on-variant'),
			),
		).toBe(true);
		expect(assignmentsMatch(assigned('on'), assigned('off'))).toBe(false);
	});

	it('ignores JSON key order', () => {
		expect(
			assignmentsMatch(assigned({ a: 1, b: 2 }), assigned({ b: 2, a: 1 })),
		).toBe(true);
	});

	it('unwraps JSON arrays that the migration stored as { value: [...] }', () => {
		expect(
			assignmentsMatch(assigned([1, 2]), assigned({ value: [1, 2] })),
		).toBe(true);
		expect(
			assignmentsMatch(assigned([1, 2]), assigned({ value: [2, 1] })),
		).toBe(false);
	});
});

describe('compareFlagForSubjects', () => {
	it('evaluates every subject for every context and reports mismatches', async () => {
		const progress: number[] = [];
		const result = await compareFlagForSubjects({
			flagKey: 'checkout',
			environment: 'Production',
			subjectKeys: ['a', 'b', 'c'],
			contexts: [
				{ label: 'no attributes', attributes: {} },
				{ label: 'country=US', attributes: { country: 'US' } },
			],
			evaluateSource: (subjectKey) =>
				subjectKey === 'c'
					? unassigned('DEFAULT_ALLOCATION_NULL')
					: assigned(true),
			evaluateDatadog: (subjectKey, attributes) =>
				subjectKey === 'b' && attributes.country === 'US'
					? assigned(false, 'off', 'rollout')
					: subjectKey === 'c'
						? unassigned('DEFAULT')
						: assigned(true),
			onProgress: (completed) => progress.push(completed),
		});

		expect(result.subjects).toBe(3);
		expect(result.contexts).toBe(2);
		expect(result.evaluations).toBe(6);
		expect(result.matches).toBe(5);
		expect(result.mismatches).toEqual([
			{
				subjectKey: 'b',
				environment: 'Production',
				context: 'country=US',
				attributes: { country: 'US' },
				source: assigned(true),
				datadog: assigned(false, 'off', 'rollout'),
				outcome: 'different-value',
			},
		]);
		expect(
			result.records.map((r) => `${r.subjectKey}/${r.context}/${r.outcome}`),
		).toEqual([
			'a/no attributes/match',
			'a/country=US/match',
			'b/no attributes/match',
			'b/country=US/different-value',
			'c/no attributes/match',
			'c/country=US/match',
		]);
		expect(result.sourceDistribution).toEqual(
			new Map([
				['alloc → true', 4],
				['(no assignment: DEFAULT_ALLOCATION_NULL)', 2],
			]),
		);
		expect(result.datadogDistribution.get('rollout → off')).toBe(1);
		expect(progress.at(-1)).toBe(6);
	});

	it('uses one empty context when the flag has no generated contexts', async () => {
		const result = await compareFlagForSubjects({
			flagKey: 'checkout',
			environment: 'Production',
			subjectKeys: ['a'],
			contexts: [],
			evaluateSource: () => assigned(true),
			evaluateDatadog: () => assigned(true),
		});
		expect(result.contexts).toBe(1);
		expect(result.evaluations).toBe(1);
	});
});

describe('evaluationOutcome', () => {
	it('separates value differences from one-sided assignments', () => {
		expect(evaluationOutcome(assigned(true), assigned(true))).toBe('match');
		expect(evaluationOutcome(unassigned(), unassigned())).toBe('match');
		expect(evaluationOutcome(assigned(true), assigned(false))).toBe(
			'different-value',
		);
		expect(evaluationOutcome(assigned(true), unassigned())).toBe('only-source');
		expect(evaluationOutcome(unassigned(), assigned(true))).toBe(
			'only-datadog',
		);
	});
});

describe('formatMismatchLine', () => {
	it('includes the subject, context, variants, values, and allocations', () => {
		expect(
			formatMismatchLine(
				{
					subjectKey: 'user-1',
					environment: 'Production → Production',
					context: 'country=US',
					attributes: { country: 'US' },
					source: assigned('on', 'treatment', 'split'),
					datadog: unassigned('DISABLED'),
					outcome: 'only-source',
				},
				'Eppo',
			),
		).toBe(
			'subject=user-1  env=Production → Production  context=country=US  ' +
				'Eppo: treatment = on [split]  Datadog: no assignment (DISABLED)',
		);
	});
});

describe('distributionChannelForFlag', () => {
	it('uses the client channel only for client-distributed flags', () => {
		expect(distributionChannelForFlag('CLIENT')).toBe('client');
		expect(distributionChannelForFlag('SERVER')).toBe('server');
		expect(distributionChannelForFlag('ALL')).toBe('server');
		expect(distributionChannelForFlag(undefined)).toBe('server');
	});
});
