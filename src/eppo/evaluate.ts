import type * as EppoSdk from '@eppo/node-server-sdk';
import { confirm, password } from '@inquirer/prompts';
import chalk from 'chalk';
import { getEppoSdkKeyForEnv, saveEppoSdkKeyForEnv } from '../config.js';
import type {
	DDFlagValue,
	DDStatus,
	EppoCondition,
	EppoFlag,
	EvaluationResult,
	SubjectAttributes,
	TestCase,
} from '../types.js';

type EppoClient = ReturnType<typeof EppoSdk.getInstance>;

// ─── Test Case Generation ─────────────────────────────────────────────────────

function generateMatchingValue(
	cond: EppoCondition,
): string | number | null | undefined {
	const op = cond.operator.toUpperCase();
	const first = cond.values[0];
	switch (op) {
		case 'ONE_OF':
			return first ?? null;
		case 'NOT_ONE_OF': {
			const set = new Set(cond.values);
			for (const c of ['__other__', 'other', 'none', 'unknown', 'default']) {
				if (!set.has(c)) return c;
			}
			return `__not_${cond.attribute}__`;
		}
		case 'GT': {
			const n = parseFloat(first ?? '');
			return Number.isFinite(n) ? n + 1 : undefined;
		}
		case 'GTE': {
			const n = parseFloat(first ?? '');
			return Number.isFinite(n) ? n : undefined;
		}
		case 'LT': {
			const n = parseFloat(first ?? '');
			return Number.isFinite(n) ? n - 1 : undefined;
		}
		case 'LTE': {
			const n = parseFloat(first ?? '');
			return Number.isFinite(n) ? n : undefined;
		}
		case 'MATCHES':
			return first ?? undefined;
		case 'IS_NULL':
			return null;
		default:
			return first ?? undefined;
	}
}

function generateNonMatchingValue(
	cond: EppoCondition,
): string | number | null | undefined {
	const op = cond.operator.toUpperCase();
	const first = cond.values[0];
	switch (op) {
		case 'ONE_OF': {
			const slug = cond.values
				.map((v) => v.replace(/\W/g, '').slice(0, 6))
				.join('_')
				.slice(0, 20);
			return `__not_${slug}__`;
		}
		case 'NOT_ONE_OF':
			return first ?? `__in_${cond.attribute}__`;
		case 'GT':
		case 'GTE': {
			const n = parseFloat(first ?? '');
			return Number.isFinite(n) ? n - 1 : undefined;
		}
		case 'LT':
		case 'LTE': {
			const n = parseFloat(first ?? '');
			return Number.isFinite(n) ? n + 1 : undefined;
		}
		case 'MATCHES':
			return '__no_match__';
		case 'IS_NULL':
			return `${cond.attribute}_value`;
		default:
			return `__not_${cond.attribute}__`;
	}
}

/**
 * Generates test cases for an Eppo flag based on its targeting rules.
 * Always includes a baseline "no attributes" case plus matching/non-matching
 * attribute sets derived from each targeting rule (property-based testing style).
 */
export function generateEppoTestCases(flag: EppoFlag): TestCase[] {
	const base: TestCase[] = [{ label: 'no attributes', attributes: {} }];
	const rulesWithConditions = (flag.allocations ?? [])
		.flatMap((a) => a.targeting_rules ?? [])
		.filter((r) => (r.conditions ?? []).length > 0);

	if (rulesWithConditions.length === 0) return base;

	const extra: TestCase[] = [];

	for (const rule of rulesWithConditions) {
		const matchAttrs: SubjectAttributes = {};
		const nonMatchAttrs: SubjectAttributes = {};
		let canMatch = true;
		let canNonMatch = true;

		for (const cond of rule.conditions) {
			const mv = generateMatchingValue(cond);
			const nv = generateNonMatchingValue(cond);

			if (mv === undefined) {
				canMatch = false;
			} else {
				matchAttrs[cond.attribute] = mv;
			}
			if (nv === undefined) {
				canNonMatch = false;
			} else {
				nonMatchAttrs[cond.attribute] = nv;
			}
		}

		if (canMatch && Object.keys(matchAttrs).length > 0) {
			extra.push({
				label: Object.entries(matchAttrs)
					.map(([k, v]) => `${k}=${v === null ? 'null' : v}`)
					.join(', '),
				attributes: matchAttrs,
			});
		}
		if (canNonMatch && Object.keys(nonMatchAttrs).length > 0) {
			extra.push({
				label: Object.entries(nonMatchAttrs)
					.map(([k, v]) => `${k}=${v === null ? 'null' : v}`)
					.join(', '),
				attributes: nonMatchAttrs,
			});
		}
		if (extra.length >= 4) break;
	}

	// Deduplicate by attribute set JSON
	const seen = new Set<string>();
	return [...base, ...extra].filter((tc) => {
		const k = JSON.stringify(tc.attributes);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

// ─── Credential Prompt ───────────────────────────────────────────────────────

export async function promptForEppoSdkKey(
	eppoEnvName: string,
	useSavedKeys = false,
): Promise<string> {
	const stored = getEppoSdkKeyForEnv(eppoEnvName);

	if (stored && useSavedKeys) {
		console.log(
			chalk.gray(
				`  Using saved Eppo SDK key for ${chalk.cyan(eppoEnvName)}.\n`,
			),
		);
		return stored;
	}

	if (stored) {
		const useStored = await confirm({
			message: `Use your saved Eppo SDK key for ${chalk.cyan(eppoEnvName)}?`,
			default: true,
		});
		if (useStored) return stored;
	}

	const key = await password({
		message: `Enter your Eppo SDK key for ${chalk.cyan(eppoEnvName)} (server SDK key, not the Admin API key):`,
		validate: (v) => (v.trim().length > 0 ? true : 'SDK key cannot be empty'),
	});

	saveEppoSdkKeyForEnv(eppoEnvName, key.trim());
	console.log(chalk.gray('  Key saved for future sessions.\n'));
	return key.trim();
}

// ─── SDK Initialization ───────────────────────────────────────────────────────

export async function initializeEppo(eppoSdkKey: string): Promise<EppoClient> {
	// Suppress pino logs from the Eppo SDK (level:30 info, level:40 warn)
	process.env.LOG_LEVEL = 'silent';
	const sdk = await import('@eppo/node-server-sdk');
	try {
		await sdk.init({
			apiKey: eppoSdkKey,
			assignmentLogger: {
				logAssignment: () => {
					/* intentionally empty */
				},
			},
			throwOnFailedInitialization: true,
			numInitialRequestRetries: 0,
			pollAfterSuccessfulInitialization: false,
			pollAfterFailedInitialization: false,
		});
		return sdk.getInstance();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/401|unauthorized/i.test(msg)) {
			throw new Error(
				'Eppo SDK initialization failed with 401 Unauthorized.\n' +
					'  Your Eppo SDK key may be invalid or expired.\n' +
					'  Note: this requires a server-side SDK key, not the Admin API key.',
			);
		}
		if (/403|forbidden/i.test(msg)) {
			throw new Error(
				'Eppo SDK initialization failed with 403 Forbidden.\n' +
					'  Your Eppo SDK key does not have access to this environment.',
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

export async function evaluateEppoFlag(
	flag: EppoFlag,
	subjectId: string,
	attributes: SubjectAttributes,
	eppoClient: EppoClient,
	ddFlags: Record<string, DDFlagValue>,
	ddFlagKeys: Set<string>,
): Promise<EvaluationResult> {
	const vtype = (flag.variation_type ?? 'STRING').toUpperCase();
	const ddFlag = ddFlags[flag.key];
	const ddStatus: DDStatus =
		ddFlag !== undefined
			? 'assigned'
			: ddFlagKeys.has(flag.key)
				? 'not-assigned'
				: 'not-in-dd';

	try {
		// Eppo SDK's Attributes type does not include null; null means "absent"
		const eppoAttrs = Object.fromEntries(
			Object.entries(attributes).filter(([, v]) => v !== null),
		) as Record<string, string | number | boolean>;

		let providerResult: string;
		let ddResult: string;

		switch (vtype) {
			case 'BOOLEAN': {
				const eppo = eppoClient.getBoolAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					false,
				) as boolean;
				providerResult = String(eppo);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
			case 'INTEGER': {
				const eppo = eppoClient.getIntegerAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					0,
				) as number;
				providerResult = String(eppo);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
			case 'NUMERIC': {
				const eppo = eppoClient.getNumericAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					0,
				) as number;
				providerResult = String(eppo);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
			case 'JSON': {
				const eppo = eppoClient.getJSONAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					{},
				) as object;
				providerResult = JSON.stringify(sortKeys(eppo));
				ddResult =
					ddFlag !== undefined
						? JSON.stringify(sortKeys(ddFlag.variationValue))
						: '';
				break;
			}
			default: {
				const eppo = eppoClient.getStringAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					'control',
				) as string;
				providerResult = String(eppo);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
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

export async function evaluateEppoFlagAdvanced(
	flagKey: string,
	vtype: string,
	subjectId: string,
	attributes: SubjectAttributes,
	eppoClient: EppoClient,
	ddFlags: Record<string, DDFlagValue>,
	ddFlagKeys: Set<string>,
): Promise<
	EvaluationResult & { providerStatus: 'found' | 'not-found' | 'error' }
> {
	const ddFlag = ddFlags[flagKey];
	const ddStatus: DDStatus =
		ddFlag !== undefined
			? 'assigned'
			: ddFlagKeys.has(flagKey)
				? 'not-assigned'
				: 'not-in-dd';

	try {
		const eppoAttrs = Object.fromEntries(
			Object.entries(attributes).filter(([, v]) => v !== null),
		) as Record<string, string | number | boolean>;

		const upperVtype = (vtype ?? 'STRING').toUpperCase();
		let flagEvaluationCode: string | undefined;
		let providerResult: string;
		let ddResult: string;

		switch (upperVtype) {
			case 'BOOLEAN': {
				const det = eppoClient.getBooleanAssignmentDetails(
					flagKey,
					subjectId,
					eppoAttrs,
					false,
				);
				flagEvaluationCode = det.evaluationDetails.flagEvaluationCode;
				providerResult = String(det.variation ?? false);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
			case 'INTEGER': {
				const det = eppoClient.getIntegerAssignmentDetails(
					flagKey,
					subjectId,
					eppoAttrs,
					0,
				);
				flagEvaluationCode = det.evaluationDetails.flagEvaluationCode;
				providerResult = String(det.variation ?? 0);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
			case 'NUMERIC': {
				const det = eppoClient.getNumericAssignmentDetails(
					flagKey,
					subjectId,
					eppoAttrs,
					0,
				);
				flagEvaluationCode = det.evaluationDetails.flagEvaluationCode;
				providerResult = String(det.variation ?? 0);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
			case 'JSON': {
				const det = eppoClient.getJSONAssignmentDetails(
					flagKey,
					subjectId,
					eppoAttrs,
					{},
				);
				flagEvaluationCode = det.evaluationDetails.flagEvaluationCode;
				providerResult = JSON.stringify(sortKeys(det.variation ?? {}));
				ddResult =
					ddFlag !== undefined
						? JSON.stringify(sortKeys(ddFlag.variationValue))
						: '';
				break;
			}
			default: {
				const det = eppoClient.getStringAssignmentDetails(
					flagKey,
					subjectId,
					eppoAttrs,
					'control',
				);
				flagEvaluationCode = det.evaluationDetails.flagEvaluationCode;
				providerResult = String(det.variation ?? 'control');
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
		}

		if (flagEvaluationCode === 'FLAG_UNRECOGNIZED_OR_DISABLED') {
			return {
				providerResult: '',
				ddResult: '',
				ddStatus,
				providerStatus: 'not-found',
			};
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
