import type { DatadogCondition, DatadogTargetingRule } from '../types.js';

const NEGATION_TABLE: Record<string, string> = {
	ONE_OF: 'NOT_ONE_OF',
	NOT_ONE_OF: 'ONE_OF',
	MATCHES: 'NOT_MATCHES',
	NOT_MATCHES: 'MATCHES',
	LT: 'GTE',
	LTE: 'GT',
	GT: 'LTE',
	GTE: 'LT',
	SEMVER_EQ: 'SEMVER_NEQ',
	SEMVER_NEQ: 'SEMVER_EQ',
	SEMVER_LT: 'SEMVER_GTE',
	SEMVER_LTE: 'SEMVER_GT',
	SEMVER_GT: 'SEMVER_LTE',
	SEMVER_GTE: 'SEMVER_LT',
};

const DNF_EXPLOSION_LIMIT = 100;

/** Negate a single inline condition. Returns null for SF-ref or unknown operator. */
export function negateCondition(
	condition: DatadogCondition,
): DatadogCondition | null {
	if (!condition.operator) return null;
	const negated = NEGATION_TABLE[condition.operator];
	if (!negated) return null;
	return { ...condition, operator: negated };
}

/**
 * Cartesian product of disjunctive condition groups → new DNF targeting rules.
 * Each inner array is one disjunction; the product picks one element from each.
 */
export function cartesianProduct(
	groups: DatadogCondition[][],
): DatadogTargetingRule[] {
	if (groups.length === 0) return [];

	let result: DatadogCondition[][] = [[]];
	for (const group of groups) {
		const next: DatadogCondition[][] = [];
		for (const existing of result) {
			for (const cond of group) {
				next.push([...existing, cond]);
			}
		}
		result = next;
	}

	return result.map((conditions) => ({ conditions }));
}

/**
 * Negate a set of targeting rules already in DNF and return new DNF.
 * Returns null if any condition has an unsupported operator or the product
 * would exceed the 100-group explosion limit.
 */
export function negateTargetingRules(
	rules: DatadogTargetingRule[],
): DatadogTargetingRule[] | null {
	if (rules.length === 0) return [];

	// De Morgan step 1: negate each condition in each group → disjunctions
	const disjunctions: DatadogCondition[][] = [];
	for (const rule of rules) {
		const disjunction: DatadogCondition[] = [];
		for (const cond of rule.conditions) {
			const neg = negateCondition(cond);
			if (neg === null) return null;
			disjunction.push(neg);
		}
		disjunctions.push(disjunction);
	}

	// Explosion guard before building the Cartesian product
	const totalGroups = disjunctions.reduce((prod, g) => prod * g.length, 1);
	if (totalGroups > DNF_EXPLOSION_LIMIT) return null;

	// Steps 2+3: AND all negated disjunctions via Cartesian product
	return cartesianProduct(disjunctions);
}
