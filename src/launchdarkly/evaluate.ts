import type * as LDSdk from '@launchdarkly/node-server-sdk';
import type {
	DDFlagValue,
	DDStatus,
	EvaluationResult,
	SubjectAttributes,
	TestCase,
} from '../types.js';
import { mapFlagType } from './migration.js';
import type { LDClause, LDFlag } from './types.js';

type LDClient = LDSdk.LDClient;

export type { LDClient };

// ─── Test Case Generation ─────────────────────────────────────────────────────

function generateLDMatchingValue(
	clause: LDClause,
): string | number | null | undefined {
	const first = clause.values[0];
	const strFirst = first != null ? String(first) : undefined;

	// When negated, a "matching" value for the negated clause is a "non-matching" value for the base op
	if (clause.negate)
		return generateLDNonMatchingValueBase(clause.op, clause.values);

	switch (clause.op) {
		case 'in':
			return strFirst ?? null;
		case 'contains':
			return strFirst != null ? `test_${strFirst}_test` : undefined;
		case 'startsWith':
			return strFirst != null ? `${strFirst}_suffix` : undefined;
		case 'endsWith':
			return strFirst != null ? `prefix_${strFirst}` : undefined;
		case 'matches':
			return strFirst ?? undefined;
		case 'lessThan':
		case 'lessThanOrEqual': {
			const n = parseFloat(strFirst ?? '');
			return Number.isFinite(n) ? n - 1 : undefined;
		}
		case 'greaterThan':
		case 'greaterThanOrEqual': {
			const n = parseFloat(strFirst ?? '');
			return Number.isFinite(n) ? n + 1 : undefined;
		}
		case 'semVerEqual':
		case 'semVerLessThanOrEqual':
		case 'semVerGreaterThanOrEqual':
			return strFirst ?? undefined;
		case 'semVerLessThan':
		case 'semVerGreaterThan':
			// Strict comparisons can't use the threshold itself as a matching value
			return undefined;
		default:
			return strFirst ?? undefined;
	}
}

function generateLDNonMatchingValueBase(
	op: string,
	values: unknown[],
): string | number | null | undefined {
	const first = values[0];
	const strFirst = first != null ? String(first) : undefined;

	switch (op) {
		case 'in': {
			const strValues = values.map((v) => String(v));
			const slug = strValues
				.map((v) => v.replace(/\W/g, '').slice(0, 6))
				.join('_')
				.slice(0, 20);
			return `__not_${slug}__`;
		}
		case 'contains':
		case 'startsWith':
		case 'endsWith':
		case 'matches':
			return '__no_match__';
		case 'lessThan':
		case 'lessThanOrEqual': {
			const n = parseFloat(strFirst ?? '');
			return Number.isFinite(n) ? n + 1 : undefined;
		}
		case 'greaterThan':
		case 'greaterThanOrEqual': {
			const n = parseFloat(strFirst ?? '');
			return Number.isFinite(n) ? n - 1 : undefined;
		}
		default:
			return `__not_${op}__`;
	}
}

function generateLDNonMatchingValue(
	clause: LDClause,
): string | number | null | undefined {
	if (clause.negate) {
		// Non-matching for negated = matching for base op
		const first = clause.values[0];
		const strFirst = first != null ? String(first) : undefined;
		switch (clause.op) {
			case 'in':
				return strFirst ?? null;
			default:
				return strFirst ?? undefined;
		}
	}
	return generateLDNonMatchingValueBase(clause.op, clause.values);
}

/**
 * Generates test cases for an LD flag based on its targeting rules for a given environment.
 * Produces matching/non-matching attribute sets from rules + individual target test cases.
 */
export function generateLDTestCases(flag: LDFlag, envKey: string): TestCase[] {
	const base: TestCase[] = [{ label: 'no attributes', attributes: {} }];
	const envConfig = flag.environments?.[envKey];
	if (!envConfig) return base;

	const extra: TestCase[] = [];

	// Generate test cases from individual targets (use target key as subject ID)
	for (const target of envConfig.targets ?? []) {
		if (target.values.length > 0) {
			const targetKey = target.values[0];
			extra.push({
				label: `target key=${targetKey}`,
				attributes: {},
				subjectIdOverride: targetKey,
			});
			if (extra.length >= 4) break;
		}
	}

	// Generate test cases from contextTargets (non-user individual targets)
	if (extra.length < 4) {
		for (const ctxTarget of envConfig.contextTargets ?? []) {
			if (ctxTarget.values.length === 0) continue;
			const targetKey = ctxTarget.values[0];
			const ck = ctxTarget.contextKind;
			extra.push({
				label: `${ck} key=${targetKey}`,
				attributes: { [`${ck}.key`]: targetKey },
				contextAttributes: { [ck]: { key: targetKey } },
			});
			if (extra.length >= 4) break;
		}
	}

	// Generate test cases from rules
	if (extra.length < 4) {
		for (const rule of envConfig.rules ?? []) {
			if (rule.disabled) continue;
			const clausesWithValues = rule.clauses.filter((c) => c.values.length > 0);
			if (clausesWithValues.length === 0) continue;

			const matchAttrs: SubjectAttributes = {};
			const nonMatchAttrs: SubjectAttributes = {};
			const matchContextAttrs: Record<string, SubjectAttributes> = {};
			const nonMatchContextAttrs: Record<string, SubjectAttributes> = {};
			const matchLdUserAttrs: SubjectAttributes = {};
			const nonMatchLdUserAttrs: SubjectAttributes = {};
			let canMatch = true;
			let canNonMatch = true;
			let matchSubjectIdOverride: string | undefined;
			let nonMatchSubjectIdOverride: string | undefined;

			for (const clause of clausesWithValues) {
				if (clause.op === 'segmentMatch') continue;
				const mv = generateLDMatchingValue(clause);
				const nv = generateLDNonMatchingValue(clause);
				const ck = clause.contextKind ?? 'user';

				if (mv === undefined) {
					canMatch = false;
				} else if (ck === 'user' && clause.attribute === 'key') {
					matchSubjectIdOverride = String(mv);
				} else {
					const flatKey =
						ck === 'user' ? clause.attribute : `${ck}.${clause.attribute}`;
					matchAttrs[flatKey] = mv;
					if (ck !== 'user') {
						matchContextAttrs[ck] ??= {};
						matchContextAttrs[ck][clause.attribute] = mv;
					} else {
						matchLdUserAttrs[clause.attribute] = mv;
					}
				}

				if (nv === undefined) {
					canNonMatch = false;
				} else if (ck === 'user' && clause.attribute === 'key') {
					nonMatchSubjectIdOverride = String(nv);
				} else {
					const flatKey =
						ck === 'user' ? clause.attribute : `${ck}.${clause.attribute}`;
					nonMatchAttrs[flatKey] = nv;
					if (ck !== 'user') {
						nonMatchContextAttrs[ck] ??= {};
						nonMatchContextAttrs[ck][clause.attribute] = nv;
					} else {
						nonMatchLdUserAttrs[clause.attribute] = nv;
					}
				}
			}

			if (
				canMatch &&
				(Object.keys(matchAttrs).length > 0 ||
					matchSubjectIdOverride !== undefined)
			) {
				const labelParts = Object.entries(matchAttrs).map(
					([k, v]) => `${k}=${v === null ? 'null' : v}`,
				);
				if (matchSubjectIdOverride !== undefined) {
					labelParts.unshift(`key=${matchSubjectIdOverride}`);
				}
				extra.push({
					label: labelParts.join(', '),
					attributes: matchAttrs,
					...(matchSubjectIdOverride !== undefined && {
						subjectIdOverride: matchSubjectIdOverride,
					}),
					...(Object.keys(matchContextAttrs).length > 0 && {
						contextAttributes: matchContextAttrs,
					}),
					...(Object.keys(matchLdUserAttrs).length > 0 && {
						ldUserAttributes: matchLdUserAttrs,
					}),
				});
			}
			if (
				canNonMatch &&
				(Object.keys(nonMatchAttrs).length > 0 ||
					nonMatchSubjectIdOverride !== undefined)
			) {
				const labelParts = Object.entries(nonMatchAttrs).map(
					([k, v]) => `${k}=${v === null ? 'null' : v}`,
				);
				if (nonMatchSubjectIdOverride !== undefined) {
					labelParts.unshift(`key=${nonMatchSubjectIdOverride}`);
				}
				extra.push({
					label: labelParts.join(', '),
					attributes: nonMatchAttrs,
					...(nonMatchSubjectIdOverride !== undefined && {
						subjectIdOverride: nonMatchSubjectIdOverride,
					}),
					...(Object.keys(nonMatchContextAttrs).length > 0 && {
						contextAttributes: nonMatchContextAttrs,
					}),
					...(Object.keys(nonMatchLdUserAttrs).length > 0 && {
						ldUserAttributes: nonMatchLdUserAttrs,
					}),
				});
			}
			if (extra.length >= 4) break;
		}
	}

	// Deduplicate by full evaluation identity (not just flat attributes)
	const seen = new Set<string>();
	return [...base, ...extra].filter((tc) => {
		const k = JSON.stringify({
			a: tc.attributes,
			s: tc.subjectIdOverride,
			c: tc.contextAttributes,
			u: tc.ldUserAttributes,
		});
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

// ─── Context Building ─────────────────────────────────────────────────────────

const USER_SKIP = new Set(['key', 'kind']);

/**
 * Build an LD evaluation context. Returns kind="user" when contextAttributes
 * is absent or empty; returns kind="multi" otherwise.
 *
 * When ldUserAttributes is provided (synthetic mode), uses it directly for the
 * LD user subcontext — no heuristic needed, provenance is known.
 *
 * When ldUserAttributes is absent (CSV / advanced mode), falls back to the
 * prefix-filter heuristic on attributes: filters keys whose dot-prefix matches
 * a present non-user context kind.
 */
export function buildLDContext(
	subjectId: string,
	attributes: SubjectAttributes,
	contextAttributes?: Record<string, SubjectAttributes>,
	ldUserAttributes?: SubjectAttributes,
): object {
	let userAttrs: Record<string, unknown>;

	if (ldUserAttributes !== undefined) {
		userAttrs = Object.fromEntries(
			Object.entries(ldUserAttributes).filter(
				([k, v]) => !USER_SKIP.has(k) && v !== null,
			),
		);
	} else {
		const nonUserPrefixes = new Set(
			Object.keys(contextAttributes ?? {}).map((ck) => `${ck}.`),
		);
		const isNonUserKey = (k: string): boolean => {
			const dot = k.indexOf('.');
			if (dot === -1) return false;
			return nonUserPrefixes.has(k.slice(0, dot + 1));
		};
		userAttrs = Object.fromEntries(
			Object.entries(attributes).filter(
				([k, v]) => !USER_SKIP.has(k) && !isNonUserKey(k) && v !== null,
			),
		);
	}

	if (!contextAttributes || Object.keys(contextAttributes).length === 0) {
		return { kind: 'user', key: subjectId, ...userAttrs };
	}

	const multi: Record<string, unknown> = {
		kind: 'multi',
		user: { key: subjectId, ...userAttrs },
	};
	for (const [ck, ckAttrs] of Object.entries(contextAttributes)) {
		const { key, ...rest } = ckAttrs;
		const ckKey = key != null ? String(key) : 'synthetic';
		const filteredRest = Object.fromEntries(
			Object.entries(rest).filter(([, v]) => v !== null),
		);
		multi[ck] = { key: ckKey, ...filteredRest };
	}
	return multi;
}

// ─── SDK Initialization ───────────────────────────────────────────────────────

export async function initializeLaunchDarkly(
	sdkKey: string,
): Promise<LDClient> {
	const ld = await import('@launchdarkly/node-server-sdk');
	const client = ld.init(sdkKey);
	try {
		await client.waitForInitialization({ timeout: 15 });
		return client;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/401|unauthorized/i.test(msg)) {
			throw new Error(
				'LaunchDarkly SDK initialization failed with 401 Unauthorized.\n' +
					'  Your LaunchDarkly SDK key may be invalid or expired.\n' +
					'  Note: this requires a server-side SDK key, not the API access token.',
			);
		}
		if (/403|forbidden/i.test(msg)) {
			throw new Error(
				'LaunchDarkly SDK initialization failed with 403 Forbidden.\n' +
					'  Your LaunchDarkly SDK key does not have access to this environment.',
			);
		}
		throw err;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Flag Evaluation ──────────────────────────────────────────────────────────

export async function evaluateLDFlag(
	flag: LDFlag,
	subjectId: string,
	attributes: SubjectAttributes,
	ldClient: LDClient,
	ddFlags: Record<string, DDFlagValue>,
	ddFlagKeys: Set<string>,
	datadogFlagKey = flag.key,
	contextAttributes?: Record<string, SubjectAttributes>,
	ldUserAttributes?: SubjectAttributes,
): Promise<EvaluationResult> {
	const vtype = mapFlagType(flag);
	const ddFlag = ddFlags[datadogFlagKey];
	const ddStatus: DDStatus =
		ddFlag !== undefined
			? 'assigned'
			: ddFlagKeys.has(datadogFlagKey)
				? 'not-assigned'
				: 'not-in-dd';

	try {
		const context = buildLDContext(
			subjectId,
			attributes,
			contextAttributes,
			ldUserAttributes,
		);

		let providerResult: string;
		let ddResult: string;

		const defaultValue =
			vtype === 'BOOLEAN'
				? false
				: vtype === 'NUMERIC'
					? 0
					: vtype === 'JSON'
						? {}
						: '';

		const ldValue = await ldClient.variation(
			flag.key,
			context as LDSdk.LDContext,
			defaultValue,
		);

		if (vtype === 'JSON') {
			providerResult = JSON.stringify(sortKeys(ldValue));
			ddResult =
				ddFlag !== undefined
					? JSON.stringify(sortKeys(ddFlag.variationValue))
					: '';
		} else {
			providerResult = String(ldValue);
			ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
		}

		return { providerResult, ddResult, ddStatus };
	} catch (err) {
		return {
			providerResult: 'ERROR',
			ddResult: 'ERROR',
			ddStatus: 'not-assigned',
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function evaluateLDFlagAdvanced(
	flagKey: string,
	vtype: string,
	subjectId: string,
	attributes: SubjectAttributes,
	ldClient: LDClient,
	ddFlags: Record<string, DDFlagValue>,
	ddFlagKeys: Set<string>,
	datadogFlagKey = flagKey,
	contextAttributes?: Record<string, SubjectAttributes>,
	ldUserAttributes?: SubjectAttributes,
): Promise<
	EvaluationResult & { providerStatus: 'found' | 'not-found' | 'error' }
> {
	const ddFlag = ddFlags[datadogFlagKey];
	const ddStatus: DDStatus =
		ddFlag !== undefined
			? 'assigned'
			: ddFlagKeys.has(datadogFlagKey)
				? 'not-assigned'
				: 'not-in-dd';

	const context = buildLDContext(
		subjectId,
		attributes,
		contextAttributes,
		ldUserAttributes,
	);

	// Pick a default value matching the flag's declared type. The LD SDK uses the
	// default for type-mismatch detection; passing a typed default avoids spurious
	// WRONG_TYPE warnings even though FLAG_NOT_FOUND detection itself is type-agnostic.
	const defaultValue: unknown =
		vtype === 'BOOLEAN'
			? false
			: vtype === 'NUMERIC' || vtype === 'INTEGER'
				? 0
				: vtype === 'JSON'
					? {}
					: '';
	try {
		const detail = await ldClient.variationDetail(
			flagKey,
			context as LDSdk.LDContext,
			defaultValue,
		);

		if (detail.reason?.errorKind === 'FLAG_NOT_FOUND') {
			return {
				providerResult: '',
				ddResult: '',
				ddStatus,
				providerStatus: 'not-found',
			};
		}

		const ldValue = (detail as { value: unknown }).value;
		const isJsonValue = ldValue !== null && typeof ldValue === 'object';

		let providerResult: string;
		if (vtype === 'JSON' || isJsonValue) {
			providerResult = JSON.stringify(sortKeys(ldValue));
		} else {
			providerResult = String(ldValue);
		}

		let ddResult: string;
		if (ddFlag !== undefined) {
			const ddIsJson =
				ddFlag.variationType === 'JSON' ||
				(ddFlag.variationValue !== null &&
					typeof ddFlag.variationValue === 'object');
			ddResult = ddIsJson
				? JSON.stringify(sortKeys(ddFlag.variationValue))
				: String(ddFlag.variationValue);
		} else {
			ddResult = '';
		}

		return { providerResult, ddResult, ddStatus, providerStatus: 'found' };
	} catch (err) {
		return {
			providerResult: 'ERROR',
			ddResult: 'ERROR',
			ddStatus: 'not-assigned',
			error: err instanceof Error ? err.message : String(err),
			providerStatus: 'error',
		};
	}
}
