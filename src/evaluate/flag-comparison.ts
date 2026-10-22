import { randomUUID } from 'node:crypto';
import type { SubjectAttributes, TestCase } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** What one platform served one subject for one flag. */
export type Assignment = {
	/** False when the platform served its fallback (no variant). */
	assigned: boolean;
	value: unknown;
	variant: string | null;
	allocation: string | null;
	/** Why nothing was assigned, or an evaluation error code. */
	detail?: string;
};

export type FlagMismatch = {
	subjectKey: string;
	environment: string;
	context: string;
	attributes: SubjectAttributes;
	source: Assignment;
	datadog: Assignment;
};

export type FlagComparisonResult = {
	flagKey: string;
	environment: string;
	subjects: number;
	contexts: number;
	evaluations: number;
	matches: number;
	mismatches: FlagMismatch[];
	/** Evaluations per source allocation and variant, to show rollout coverage. */
	sourceDistribution: Map<string, number>;
	/** Evaluations per Datadog allocation and variant. */
	datadogDistribution: Map<string, number>;
};

export type FlagComparisonInput = {
	flagKey: string;
	environment: string;
	subjectKeys: string[];
	contexts: TestCase[];
	evaluateSource: (
		subjectKey: string,
		attributes: SubjectAttributes,
	) => Assignment;
	evaluateDatadog: (
		subjectKey: string,
		attributes: SubjectAttributes,
	) => Assignment;
	/** Called after each batch so a spinner can update and redraw. */
	onProgress?: (completed: number, total: number) => void;
};

// ─── Subjects ─────────────────────────────────────────────────────────────────

export const DEFAULT_SUBJECT_COUNT = 10_000;

export function generateSubjectKeys(
	count: number,
	makeKey: () => string = randomUUID,
): string[] {
	if (!Number.isInteger(count) || count <= 0) {
		throw new Error(`Subject count must be a positive integer, got ${count}`);
	}
	const keys = new Set<string>();
	while (keys.size < count) keys.add(makeKey());
	return [...keys];
}

// ─── Comparison ───────────────────────────────────────────────────────────────

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, sortKeys(v)]),
		);
	}
	return value;
}

/**
 * Datadog rejects top-level JSON arrays, so the migration stores them as
 * `{ "value": [...] }`. Unwrap that shape when the source value is an array.
 */
function unwrapJsonArray(sourceValue: unknown, datadogValue: unknown): unknown {
	if (
		Array.isArray(sourceValue) &&
		datadogValue !== null &&
		typeof datadogValue === 'object' &&
		!Array.isArray(datadogValue)
	) {
		const entries = Object.entries(datadogValue as Record<string, unknown>);
		if (
			entries.length === 1 &&
			entries[0][0] === 'value' &&
			Array.isArray(entries[0][1])
		) {
			return entries[0][1];
		}
	}
	return datadogValue;
}

export function formatAssignmentValue(value: unknown): string {
	if (value === undefined) return '';
	if (value !== null && typeof value === 'object') {
		return JSON.stringify(sortKeys(value));
	}
	return String(value);
}

/**
 * Assignments match when neither platform assigned a variant, or when both
 * served the same value. Values are compared instead of variant keys because
 * the migration may slugify variant keys.
 */
export function assignmentsMatch(
	source: Assignment,
	datadog: Assignment,
): boolean {
	if (!source.assigned || !datadog.assigned) {
		return source.assigned === datadog.assigned;
	}
	return (
		formatAssignmentValue(source.value) ===
		formatAssignmentValue(unwrapJsonArray(source.value, datadog.value))
	);
}

export function distributionKey(assignment: Assignment): string {
	if (!assignment.assigned) {
		return `(no assignment${assignment.detail ? `: ${assignment.detail}` : ''})`;
	}
	return `${assignment.allocation ?? '(unknown allocation)'} → ${assignment.variant ?? '(unknown variant)'}`;
}

function increment(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

const PROGRESS_BATCH_SIZE = 1_000;

/**
 * Evaluate a flag for every subject and context on both platforms. Yields to
 * the event loop between batches so a spinner keeps rendering.
 */
export async function compareFlagForSubjects(
	input: FlagComparisonInput,
): Promise<FlagComparisonResult> {
	const contexts =
		input.contexts.length > 0
			? input.contexts
			: [{ label: 'no attributes', attributes: {} }];
	const total = input.subjectKeys.length * contexts.length;
	const result: FlagComparisonResult = {
		flagKey: input.flagKey,
		environment: input.environment,
		subjects: input.subjectKeys.length,
		contexts: contexts.length,
		evaluations: 0,
		matches: 0,
		mismatches: [],
		sourceDistribution: new Map(),
		datadogDistribution: new Map(),
	};

	for (const subjectKey of input.subjectKeys) {
		for (const context of contexts) {
			const source = input.evaluateSource(subjectKey, context.attributes);
			const datadog = input.evaluateDatadog(subjectKey, context.attributes);
			increment(result.sourceDistribution, distributionKey(source));
			increment(result.datadogDistribution, distributionKey(datadog));
			if (assignmentsMatch(source, datadog)) {
				result.matches++;
			} else {
				result.mismatches.push({
					subjectKey,
					environment: input.environment,
					context: context.label,
					attributes: context.attributes,
					source,
					datadog,
				});
			}
			result.evaluations++;
			if (result.evaluations % PROGRESS_BATCH_SIZE === 0) {
				input.onProgress?.(result.evaluations, total);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	}
	input.onProgress?.(result.evaluations, total);
	return result;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function describeAssignment(assignment: Assignment): string {
	if (!assignment.assigned) {
		return `no assignment${assignment.detail ? ` (${assignment.detail})` : ''}`;
	}
	return `${assignment.variant ?? '(unknown variant)'} = ${formatAssignmentValue(assignment.value)}`;
}

export function formatMismatchLine(
	mismatch: FlagMismatch,
	sourceLabel: string,
): string {
	return (
		`subject=${mismatch.subjectKey}  env=${mismatch.environment}  ` +
		`context=${mismatch.context}  ${sourceLabel}: ${describeAssignment(mismatch.source)}  ` +
		`Datadog: ${describeAssignment(mismatch.datadog)}`
	);
}

function csvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function mismatchesToCsv(
	mismatches: FlagMismatch[],
	sourceLabel: string,
): string {
	const header = [
		'subject_key',
		'environment',
		'context',
		`${sourceLabel.toLowerCase()}_allocation`,
		`${sourceLabel.toLowerCase()}_variant`,
		`${sourceLabel.toLowerCase()}_value`,
		'datadog_allocation',
		'datadog_variant',
		'datadog_value',
	];
	const rows = mismatches.map((m) => [
		m.subjectKey,
		m.environment,
		m.context,
		m.source.allocation ?? '',
		m.source.variant ?? m.source.detail ?? '',
		formatAssignmentValue(m.source.value),
		m.datadog.allocation ?? '',
		m.datadog.variant ?? m.datadog.detail ?? '',
		formatAssignmentValue(m.datadog.value),
	]);
	return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
