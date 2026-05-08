import type { DatadogCondition, DatadogTargetingRule } from '../types.js';
import { mapOperator } from './migration.js';
import { negateTargetingRules } from './negation.js';
import type { LDFlag, LDSegment } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const SAVED_FILTER_NAME_MAX_BYTES = 200;

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface SegmentRef {
	segmentKey: string;
	envKey: string;
	negated: boolean;
}

/**
 * Scan user-selected flags for segmentMatch clauses and return unique
 * (segmentKey, envKey, negated) tuples. Only considers the provided envKeys.
 */
export function discoverSegmentRefs(
	flags: LDFlag[],
	envKeys: string[],
): SegmentRef[] {
	const seen = new Set<string>();
	const refs: SegmentRef[] = [];

	for (const flag of flags) {
		for (const envKey of envKeys) {
			const envConfig = flag.environments?.[envKey];
			if (!envConfig) continue;

			for (const rule of envConfig.rules) {
				if (rule.disabled) continue;
				for (const clause of rule.clauses) {
					if (clause.op !== 'segmentMatch') continue;
					for (const segmentKey of clause.values as string[]) {
						const negated = clause.negate;
						const key = `${segmentKey}:${envKey}:${negated}`;
						if (!seen.has(key)) {
							seen.add(key);
							refs.push({ segmentKey, envKey, negated });
						}
					}
				}
			}
		}
	}

	return refs;
}

// ─── Creation Type ────────────────────────────────────────────────────────────

/**
 * Determine whether the saved filter should be created as LIST or RULES.
 * LIST only for pure key-in segments (single rule, single clause, op:in,
 * attribute:key) with no excluded or included lists.
 */
export function getCreationType(segment: LDSegment): 'RULES' | 'LIST' {
	if (
		segment.excluded.length === 0 &&
		segment.included.length === 0 &&
		segment.rules.length === 1 &&
		segment.rules[0].clauses.length === 1 &&
		segment.rules[0].clauses[0].op === 'in' &&
		segment.rules[0].clauses[0].attribute === 'key'
	) {
		return 'LIST';
	}
	return 'RULES';
}

// ─── Name Rendering ───────────────────────────────────────────────────────────

/** Truncate a string to at most maxBytes UTF-8 bytes at a codepoint boundary. */
function truncateToByteLength(str: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const codePoint of str) {
		const cpBytes = Buffer.byteLength(codePoint, 'utf8');
		if (bytes + cpBytes > maxBytes) break;
		bytes += cpBytes;
		end += codePoint.length;
	}
	return str.slice(0, end);
}

/**
 * Render the saved filter name for a segment+env+negated combination.
 * Truncates the segment name if the full name would exceed 200 UTF-8 bytes.
 * Returns null if the envelope (prefixes + env suffix) alone exceeds 200 bytes.
 */
export function renderSavedFilterName(
	segmentName: string,
	envKey: string,
	negated: boolean,
	namePrefix?: string,
): string | null {
	const notPart = negated ? 'NOT ' : '';
	const prefixPart = namePrefix ? `${namePrefix}-` : '';
	const suffixPart = ` (${envKey})`;

	const fullName = `${notPart}${prefixPart}${segmentName}${suffixPart}`;
	if (Buffer.byteLength(fullName, 'utf8') <= SAVED_FILTER_NAME_MAX_BYTES) {
		return fullName;
	}

	const envelopeBytes =
		Buffer.byteLength(notPart, 'utf8') +
		Buffer.byteLength(prefixPart, 'utf8') +
		Buffer.byteLength('…', 'utf8') +
		Buffer.byteLength(suffixPart, 'utf8');

	const budget = SAVED_FILTER_NAME_MAX_BYTES - envelopeBytes;
	if (budget <= 0) return null;

	const truncated = truncateToByteLength(segmentName, budget);
	return `${notPart}${prefixPart}${truncated}…${suffixPart}`;
}

// ─── Rule Building ────────────────────────────────────────────────────────────

/**
 * Map one LD segment to DD targeting rules for the non-negated saved filter.
 * Formula: (rules ∨ included) ∧ ¬excluded
 * Returns null if the segment uses unsupported features.
 */
export function buildNonNegatedRules(
	segment: LDSegment,
): DatadogTargetingRule[] | null {
	if (
		segment.includedContexts.length > 0 ||
		segment.excludedContexts.length > 0
	) {
		return null; // multi-context unsupported
	}

	// Check for nested segmentMatch in segment rules
	for (const rule of segment.rules) {
		for (const clause of rule.clauses) {
			if (clause.op === 'segmentMatch') return null;
		}
	}

	const groups: DatadogTargetingRule[] = [];

	// Rule groups
	for (const rule of segment.rules) {
		const conditions: DatadogCondition[] = [];
		for (const clause of rule.clauses) {
			const mapped = mapOperator(clause.op, clause.negate, clause.values);
			if ('skip' in mapped) return null;
			conditions.push({
				operator: mapped.operator,
				attribute: clause.attribute,
				value: mapped.values,
			});
		}
		groups.push({ conditions });
	}

	// Included group
	if (segment.included.length > 0) {
		groups.push({
			conditions: [
				{ operator: 'ONE_OF', attribute: 'key', value: segment.included },
			],
		});
	}

	// AND excluded into every group
	if (segment.excluded.length > 0) {
		const excludeCondition: DatadogCondition = {
			operator: 'NOT_ONE_OF',
			attribute: 'key',
			value: [...segment.excluded],
		};
		for (const group of groups) {
			group.conditions.push(excludeCondition);
		}
	}

	return groups;
}

/**
 * Build targeting rules for the negated saved filter from scratch.
 * Formula: (¬rules ∧ ¬included) ∨ excluded
 * Does NOT pipe the non-negated filter through negateTargetingRules.
 * Returns null if unsupported or explosion guard fires.
 */
export function buildNegatedRules(
	segment: LDSegment,
): DatadogTargetingRule[] | null {
	if (
		segment.includedContexts.length > 0 ||
		segment.excludedContexts.length > 0
	) {
		return null;
	}

	for (const rule of segment.rules) {
		for (const clause of rule.clauses) {
			if (clause.op === 'segmentMatch') return null;
		}
	}

	let negatedRulesGroups: DatadogTargetingRule[];

	if (segment.rules.length > 0) {
		// Map segment rules to DD targeting rules
		const ruleGroups: DatadogTargetingRule[] = [];
		for (const rule of segment.rules) {
			const conditions: DatadogCondition[] = [];
			for (const clause of rule.clauses) {
				const mapped = mapOperator(clause.op, clause.negate, clause.values);
				if ('skip' in mapped) return null;
				conditions.push({
					operator: mapped.operator,
					attribute: clause.attribute,
					value: mapped.values,
				});
			}
			ruleGroups.push({ conditions });
		}

		const negated = negateTargetingRules(ruleGroups);
		if (negated === null) return null; // explosion or unsupported operator
		negatedRulesGroups = negated;
	} else {
		// Empty rules → ¬rules = tautology (single group with zero conditions)
		negatedRulesGroups = [{ conditions: [] }];
	}

	// AND key NOT_ONE_OF included into every ¬rules group
	if (segment.included.length > 0) {
		const notIncluded: DatadogCondition = {
			operator: 'NOT_ONE_OF',
			attribute: 'key',
			value: [...segment.included],
		};
		for (const group of negatedRulesGroups) {
			group.conditions.push(notIncluded);
		}
	}

	// OR group: key ONE_OF excluded
	if (segment.excluded.length > 0) {
		negatedRulesGroups.push({
			conditions: [
				{ operator: 'ONE_OF', attribute: 'key', value: segment.excluded },
			],
		});
	}

	return negatedRulesGroups;
}
