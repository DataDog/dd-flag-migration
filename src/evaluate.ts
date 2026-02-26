#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import type * as EppoSdk from '@eppo/node-server-sdk';
import { confirm, input, password, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import {
	CONFIG_DIR,
	getDatadogClientToken,
	getDatadogKeys,
	getDatadogSite,
	getEppoSdkKeyForEnv,
	saveDatadogClientToken,
	saveDatadogKeys,
	saveEppoSdkKeyForEnv,
} from './config.js';
import type {
	EppoCondition,
	EppoFlag,
	EvaluationExportRow,
	MigrationEnvironmentMapping,
	MigrationFile,
} from './types.js';

type EppoClient = ReturnType<typeof EppoSdk.getInstance>;

type SubjectAttributes = Record<string, string | number | boolean | null>;

interface TestCase {
	label: string;
	attributes: SubjectAttributes;
}

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
 * Generates test cases for a flag based on its targeting rules.
 * Always includes a baseline "no attributes" case plus matching/non-matching
 * attribute sets derived from each targeting rule (property-based testing style).
 */
function generateTestCases(flag: EppoFlag): TestCase[] {
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

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function printHeader(): void {
	const purple = chalk.bold.hex('#632CA6');
	console.log();
	console.log(purple('╔══════════════════════════════════════════╗'));
	console.log(
		purple('║') +
			chalk.bold.white('   🚩  Feature Flag Migration Tool  🚩    ') +
			purple('║'),
	);
	console.log(
		purple('║') +
			chalk.hex('#632CA6')('           Evaluate Migration             ') +
			purple('║'),
	);
	console.log(purple('╚══════════════════════════════════════════╝'));
	console.log();
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

function parseArgs(): {
	useSavedKeys: boolean;
	testSubjectId: string | undefined;
	useLatestMigration: boolean;
	flagEnvironment: string | undefined;
} {
	const args = process.argv.slice(2);
	const useSavedKeys = args.includes('--use-saved-keys');
	const useLatestMigration = args.includes('--use-latest-migration');
	const subjectArg = args.find((a) => a.startsWith('--test-subject-id='));
	const testSubjectId = subjectArg
		? subjectArg.slice('--test-subject-id='.length)
		: undefined;
	const envArg = args.find((a) => a.startsWith('--flag-environment='));
	const flagEnvironment = envArg
		? envArg.slice('--flag-environment='.length)
		: undefined;
	return { useSavedKeys, testSubjectId, useLatestMigration, flagEnvironment };
}

// ─── Migration File Selection ─────────────────────────────────────────────────

async function selectMigrationFile(useLatest = false): Promise<MigrationFile> {
	if (!fs.existsSync(CONFIG_DIR)) {
		console.log(chalk.red('\n  No migration files found.'));
		console.log(
			chalk.gray(`  Run 'yarn migrate' to perform a migration first.\n`),
		);
		process.exit(1);
	}

	const files = fs
		.readdirSync(CONFIG_DIR)
		.filter((f) => f.startsWith('migration-') && f.endsWith('.json'))
		.sort()
		.reverse(); // newest-first (ISO timestamps sort lexicographically)

	if (files.length === 0) {
		console.log(chalk.red('\n  No migration files found.'));
		console.log(
			chalk.gray(`  Run 'yarn migrate' to perform a migration first.\n`),
		);
		process.exit(1);
	}

	let chosen: string;

	if (files.length === 1 || useLatest) {
		console.log(
			chalk.gray(`  Using migration file: ${chalk.cyan(files[0])}\n`),
		);
		chosen = files[0];
	} else {
		chosen = await select<string>({
			message: 'Select a migration to evaluate:',
			choices: files.map((f) => {
				const iso = f.replace('migration-', '').replace('.json', '');
				const date = new Date(iso);
				const dateStr = Number.isNaN(date.getTime())
					? ''
					: `  ${chalk.gray(date.toLocaleString())}`;
				return { name: `${f}${dateStr}`, value: f, short: f };
			}),
		});
	}

	const filepath = path.join(CONFIG_DIR, chosen);
	const raw = fs.readFileSync(filepath, 'utf-8');
	return JSON.parse(raw) as MigrationFile;
}

// ─── Credential Prompts ───────────────────────────────────────────────────────

async function promptForEppoSdkKey(
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

async function promptForDatadogClientToken(
	useSavedKeys = false,
): Promise<string> {
	const stored = getDatadogClientToken();

	if (stored && useSavedKeys) {
		console.log(chalk.gray('  Using saved Datadog client token.\n'));
		return stored;
	}

	if (stored) {
		const useStored = await confirm({
			message: 'Use your saved Datadog client token?',
			default: true,
		});
		if (useStored) return stored;
	}

	const token = await password({
		message: 'Enter your Datadog client token:',
		validate: (v) =>
			v.trim().length > 0 ? true : 'Client token cannot be empty',
	});

	saveDatadogClientToken(token.trim());
	console.log(chalk.gray('  Token saved for future sessions.\n'));
	return token.trim();
}

function getDatadogSiteFromConfig(): string {
	return getDatadogSite() ?? 'datadoghq.com';
}

async function promptForDatadogKeys(
	useSavedKeys = false,
): Promise<{ apiKey: string; appKey: string }> {
	const stored = getDatadogKeys();

	if (stored.apiKey && stored.appKey && useSavedKeys) {
		console.log(chalk.gray('  Using saved Datadog API keys.\n'));
		return { apiKey: stored.apiKey, appKey: stored.appKey };
	}

	if (stored.apiKey && stored.appKey) {
		const useStored = await confirm({
			message: 'Use your saved Datadog API keys?',
			default: true,
		});
		if (useStored) return { apiKey: stored.apiKey, appKey: stored.appKey };
	}

	const apiKey = await password({
		message: 'Enter your Datadog API key:',
		validate: (v) => (v.trim().length > 0 ? true : 'API key cannot be empty'),
	});
	const appKey = await password({
		message: 'Enter your Datadog Application key:',
		validate: (v) =>
			v.trim().length > 0 ? true : 'Application key cannot be empty',
	});

	saveDatadogKeys(apiKey.trim(), appKey.trim());
	console.log(chalk.gray('  Keys saved for future sessions.\n'));
	return { apiKey: apiKey.trim(), appKey: appKey.trim() };
}

type ApiEnvironment = { id: string; queries: string[] };

async function fetchEnvironmentsFromApi(
	apiKey: string,
	appKey: string,
	site: string,
): Promise<ApiEnvironment[]> {
	const baseUrl = `https://api.${site}`;
	const resp = await axios.get<{
		data: Array<{ id: string; attributes: { queries: string[] } }>;
	}>(`${baseUrl}/api/unstable/feature-flags/environments`, {
		headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
	});
	return resp.data.data.map((item) => ({
		id: item.id,
		queries: item.attributes.queries ?? [],
	}));
}

async function selectDDEnvironment(
	environmentMapping: MigrationEnvironmentMapping[],
	apiKey: string,
	appKey: string,
	site: string,
	flagEnvironment?: string,
): Promise<{ ddEnvName: string; envId: string; eppoEnvName: string }> {
	if (environmentMapping.length === 0) {
		throw new Error(
			'No environment mapping found in migration file. Re-run the migration first.',
		);
	}

	let chosen: MigrationEnvironmentMapping;

	if (flagEnvironment !== undefined) {
		const match = environmentMapping.find(
			(m) => m.datadogEnvName === flagEnvironment,
		);
		if (!match) {
			throw new Error(
				`No environment named "${flagEnvironment}" found in migration file. ` +
					`Available: ${environmentMapping.map((m) => m.datadogEnvName).join(', ')}`,
			);
		}
		chosen = match;
		console.log(
			chalk.gray(
				`  Using Datadog environment: ${chalk.cyan(chosen.datadogEnvName)}\n`,
			),
		);
	} else if (environmentMapping.length === 1) {
		chosen = environmentMapping[0];
		console.log(
			chalk.gray(
				`  Using Datadog environment: ${chalk.cyan(chosen.datadogEnvName)}\n`,
			),
		);
	} else {
		const chosenId = await select<string>({
			message: 'Select the Datadog environment to evaluate against:',
			choices: environmentMapping.map((m) => ({
				name: m.datadogEnvName,
				value: m.datadogEnvId,
			})),
		});
		const found = environmentMapping.find((m) => m.datadogEnvId === chosenId);
		if (!found) throw new Error(`Selected environment not found: ${chosenId}`);
		chosen = found;
	}

	// Fetch the live environment from the API to get its dd_env queries
	const apiEnvs = await fetchEnvironmentsFromApi(apiKey, appKey, site);
	const matched = apiEnvs.find((e) => e.id === chosen.datadogEnvId);

	if (!matched || matched.queries.length === 0) {
		throw new Error(
			`No DD_ENV names found for environment "${chosen.datadogEnvName}" (id: ${chosen.datadogEnvId}). ` +
				'Configure DD_ENV names in Datadog → Feature Flags → Environments → Edit.',
		);
	}

	const envId = chosen.datadogEnvId;
	const eppoEnvName = chosen.sourceEnvName;

	if (matched.queries.length === 1 || flagEnvironment !== undefined)
		return { ddEnvName: matched.queries[0], envId, eppoEnvName };

	const ddEnvName = await select<string>({
		message: `Select a DD_ENV for "${chosen.datadogEnvName}":`,
		choices: matched.queries.map((q) => ({ name: q, value: q })),
	});
	return { ddEnvName, envId, eppoEnvName };
}

// ─── Endpoint Host Mapping ────────────────────────────────────────────────────

function buildEndpointHost(site: string): string {
	return `preview.ff-cdn.${site}`;
}

// ─── DD Flag Fetching ─────────────────────────────────────────────────────────

type DDFlagValue = { variationValue: unknown; variationType: string };

type DDFlagListItem = {
	attributes: {
		key: string;
		feature_flag_environments?: Array<{
			environment_id: string;
			status: 'ENABLED' | 'DISABLED';
		}>;
	};
};

async function fetchDDFlagData(
	apiKey: string,
	appKey: string,
	site: string,
	envId: string,
): Promise<{ keys: Set<string>; enabledByKey: Map<string, boolean> }> {
	const baseUrl = `https://api.${site}`;
	const keys = new Set<string>();
	const enabledByKey = new Map<string, boolean>();
	let offset = 0;
	const limit = 200;
	while (true) {
		const resp = await axios.get<{ data: DDFlagListItem[] }>(
			`${baseUrl}/api/unstable/feature-flags`,
			{
				headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
				params: { limit, offset, is_archived: false },
			},
		);
		const flags = resp.data.data ?? [];
		for (const f of flags) {
			keys.add(f.attributes.key);
			const envEntry = (f.attributes.feature_flag_environments ?? []).find(
				(e) => e.environment_id === envId,
			);
			if (envEntry !== undefined)
				enabledByKey.set(f.attributes.key, envEntry.status === 'ENABLED');
		}
		if (flags.length < limit) break;
		offset += limit;
	}
	return { keys, enabledByKey };
}

async function fetchDDFlags(
	clientToken: string,
	site: string,
	env: string,
	subjectId: string,
	subjectAttributes: SubjectAttributes = {},
): Promise<Record<string, DDFlagValue>> {
	const host = buildEndpointHost(site);
	const url = `https://${host}/precompute-assignments?dd_env=${encodeURIComponent(env)}`;
	try {
		const resp = await axios.post(
			url,
			{
				data: {
					type: 'precompute-assignments-request',
					attributes: {
						env: { dd_env: env },
						sdk: { name: 'browser', version: 'dev' },
						subject: {
							targeting_key: subjectId,
							targeting_attributes: subjectAttributes,
						},
					},
				},
			},
			{
				headers: {
					'Content-Type': 'application/vnd.api+json',
					'dd-client-token': clientToken,
				},
			},
		);
		return (resp.data?.data?.attributes?.flags ?? {}) as Record<
			string,
			DDFlagValue
		>;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response) {
			const detail = JSON.stringify(err.response.data);
			throw new Error(`HTTP ${err.response.status} from ${url}\n  ${detail}`);
		}
		throw err;
	}
}

// ─── SDK Initialization ───────────────────────────────────────────────────────

async function initializeEppo(eppoSdkKey: string): Promise<EppoClient> {
	// Suppress pino logs from the Eppo SDK (level:30 info, level:40 warn)
	process.env.LOG_LEVEL = 'silent';
	const sdk = await import('@eppo/node-server-sdk');
	await sdk.init({
		apiKey: eppoSdkKey,
		assignmentLogger: { logAssignment: () => {} },
		throwOnFailedInitialization: true,
		numInitialRequestRetries: 0,
		pollAfterSuccessfulInitialization: false,
		pollAfterFailedInitialization: false,
	});
	return sdk.getInstance();
}

// ─── Flag Evaluation ──────────────────────────────────────────────────────────

type DDStatus = 'assigned' | 'not-assigned' | 'not-in-dd';

async function evaluateFlag(
	flag: EppoFlag,
	subjectId: string,
	attributes: SubjectAttributes,
	eppoClient: EppoClient,
	ddFlags: Record<string, DDFlagValue>,
	ddFlagKeys: Set<string>,
): Promise<{
	eppoResult: string;
	ddResult: string;
	ddStatus: DDStatus;
	error?: string;
}> {
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

		let eppoResult: string;
		let ddResult: string;

		switch (vtype) {
			case 'BOOLEAN': {
				const eppo = eppoClient.getBoolAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					false,
				) as boolean;
				eppoResult = String(eppo);
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
				eppoResult = String(eppo);
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
				eppoResult = String(eppo);
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
				eppoResult = JSON.stringify(eppo);
				ddResult =
					ddFlag !== undefined ? JSON.stringify(ddFlag.variationValue) : '';
				break;
			}
			default: {
				const eppo = eppoClient.getStringAssignment(
					flag.key,
					subjectId,
					eppoAttrs,
					'control',
				) as string;
				eppoResult = String(eppo);
				ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
				break;
			}
		}

		return { eppoResult, ddResult, ddStatus };
	} catch (err) {
		return {
			eppoResult: 'ERROR',
			ddResult: 'ERROR',
			ddStatus: 'assigned',
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ─── Table Rendering ──────────────────────────────────────────────────────────

type MigrationStatus = 'created' | 'partial' | 'failed' | 'skipped' | 'unknown';

interface FlagTestResult {
	testCase: TestCase;
	eppoResult: string;
	ddResult: string;
	ddStatus: DDStatus;
	match: boolean;
	error?: string;
}

interface TableRow {
	key: string;
	testResults: FlagTestResult[];
	migrationStatus: MigrationStatus;
	ddEnabled: boolean | null;
	partialDetails: string[];
}

function renderTable(rows: TableRow[], providerLabel: string): void {
	const COL_FLAG = 32;
	const COL_TEST = 26;
	const COL_EVAL = 14;
	const COL_MIG = 12;
	const COL_ENA = 10;

	const pad = (s: string, len: number) =>
		s.length >= len ? `${s.slice(0, len - 1)}…` : s.padEnd(len);

	const sep = chalk.gray(' │ ');

	const divider = chalk.gray(
		'─'.repeat(COL_FLAG) +
			'─┼─' +
			'─'.repeat(COL_TEST) +
			'─┼─' +
			'─'.repeat(COL_EVAL) +
			'─┼─' +
			'─'.repeat(COL_EVAL) +
			'─┼─' +
			'─'.repeat(COL_MIG) +
			'─┼─' +
			'─'.repeat(COL_ENA),
	);

	const header =
		chalk.bold(pad('Flag Key', COL_FLAG)) +
		sep +
		chalk.bold(pad('Test Case', COL_TEST)) +
		sep +
		chalk.bold(pad(providerLabel, COL_EVAL)) +
		sep +
		chalk.bold(pad('Datadog', COL_EVAL)) +
		sep +
		chalk.bold(pad('Migration', COL_MIG)) +
		sep +
		chalk.bold('Enabled');

	console.log();
	console.log(header);
	console.log(divider);

	const migrationCol = (status: MigrationStatus): string => {
		switch (status) {
			case 'created':
				return chalk.green('✓ Created'.padEnd(COL_MIG));
			case 'partial':
				return chalk.yellow('⚠ Partial'.padEnd(COL_MIG));
			case 'failed':
				return chalk.red('✗ Failed'.padEnd(COL_MIG));
			case 'skipped':
				return chalk.gray('— Skipped'.padEnd(COL_MIG));
			default:
				return chalk.gray('—'.padEnd(COL_MIG));
		}
	};

	const enabledCol = (enabled: boolean | null): string => {
		if (enabled === null) return chalk.gray('—'.padEnd(COL_ENA));
		return enabled
			? chalk.green('✓ Enabled'.padEnd(COL_ENA))
			: chalk.gray('✗ Disabled'.padEnd(COL_ENA));
	};

	for (const row of rows) {
		for (let i = 0; i < row.testResults.length; i++) {
			const tr = row.testResults[i];
			const isFirst = i === 0;

			const flagKeyStr = isFirst
				? pad(row.key, COL_FLAG)
				: ' '.repeat(COL_FLAG);

			const testLabelStr = pad(tr.testCase.label, COL_TEST);

			let eppoDisplay: string;
			let ddDisplay: string;

			if (tr.error) {
				eppoDisplay = chalk.red(pad('ERROR', COL_EVAL));
				ddDisplay =
					tr.ddStatus === 'assigned'
						? chalk.dim(pad(tr.ddResult, COL_EVAL))
						: chalk.dim(pad('—', COL_EVAL));
			} else if (
				tr.ddStatus === 'not-in-dd' ||
				tr.ddStatus === 'not-assigned'
			) {
				eppoDisplay = chalk.dim(pad(tr.eppoResult, COL_EVAL));
				ddDisplay = chalk.dim(pad('—', COL_EVAL));
			} else if (tr.match) {
				eppoDisplay = chalk.green(pad(tr.eppoResult, COL_EVAL));
				ddDisplay = chalk.green(pad(tr.ddResult, COL_EVAL));
			} else {
				eppoDisplay = chalk.yellow(pad(tr.eppoResult, COL_EVAL));
				ddDisplay = chalk.yellow(pad(tr.ddResult, COL_EVAL));
			}

			const migDisplay = isFirst
				? migrationCol(row.migrationStatus)
				: ' '.repeat(COL_MIG);
			const enaDisplay = isFirst
				? enabledCol(row.ddEnabled)
				: ' '.repeat(COL_ENA);

			console.log(
				flagKeyStr +
					sep +
					testLabelStr +
					sep +
					eppoDisplay +
					sep +
					ddDisplay +
					sep +
					migDisplay +
					sep +
					enaDisplay,
			);
		}

		if (row.partialDetails.length > 0) {
			console.log(
				' '.repeat(COL_FLAG + 3) +
					chalk.yellow(`⚠ ${row.partialDetails.join(' | ')}`),
			);
		}

		console.log(divider);
	}

	console.log();
	console.log(chalk.gray('  Migration:'));
	console.log(
		'  • ' +
			chalk.green('✓ Created') +
			chalk.gray(' — flag was successfully created during migration'),
	);
	console.log(
		'  • ' +
			chalk.yellow('⚠ Partial') +
			chalk.gray(
				' — flag was created but could not be enabled in some environments',
			),
	);
	console.log(
		'  • ' +
			chalk.red('✗ Failed') +
			chalk.gray(' — flag creation itself failed'),
	);
	console.log(
		'  • ' +
			chalk.gray('— Skipped') +
			chalk.gray(' — flag type is not supported (BANDIT, LAYER)'),
	);
	console.log();
}

function printSummary(rows: TableRow[]): void {
	const allResults = rows.flatMap((r) => r.testResults);
	const matched = allResults.filter((r) => r.match).length;
	const differed = allResults.filter(
		(r) => !r.match && !r.error && r.ddStatus === 'assigned',
	).length;
	const notAssigned = allResults.filter(
		(r) => r.ddStatus === 'not-assigned',
	).length;
	const notInDD = allResults.filter((r) => r.ddStatus === 'not-in-dd').length;
	const errored = allResults.filter((r) => Boolean(r.error)).length;

	const flagsWithDiff = rows.filter((r) =>
		r.testResults.some(
			(t) => !t.match && !t.error && t.ddStatus === 'assigned',
		),
	).length;

	console.log(chalk.bold('Summary:'));
	let summary = `  ${chalk.green(String(matched))} match  ${chalk.yellow(String(differed))} differ  ${chalk.red(String(errored))} error`;
	if (notAssigned > 0)
		summary += `  ${chalk.dim(String(notAssigned))} not assigned`;
	if (notInDD > 0) summary += `  ${chalk.red(String(notInDD))} not in Datadog`;
	console.log(summary);
	console.log(
		chalk.gray(
			`  Across ${rows.length} flag(s), ${allResults.length} evaluation(s) total`,
		),
	);
	console.log();

	if (flagsWithDiff > 0) {
		console.log(
			chalk.yellow(
				`  ${flagsWithDiff} flag(s) returned different values in at least one test case.\n` +
					'  This may be expected if flag configurations differ between providers.',
			),
		);
		console.log();
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { useSavedKeys, testSubjectId, useLatestMigration, flagEnvironment } =
		parseArgs();
	printHeader();

	// 1. Select migration file
	const migration = await selectMigrationFile(useLatestMigration);
	const providerLabel =
		migration.provider === 'eppo'
			? 'Eppo'
			: migration.provider.charAt(0).toUpperCase() +
				migration.provider.slice(1);

	console.log(chalk.bold('Migrated from: ') + chalk.green(providerLabel));
	console.log(
		chalk.gray(
			`  Migrated at:  ${new Date(migration.migratedAt).toLocaleString()}`,
		),
	);
	console.log(chalk.gray(`  Flags:        ${migration.flags.length}`));
	console.log();

	// 2. Collect Datadog credentials
	const { apiKey: ddApiKey, appKey: ddAppKey } =
		await promptForDatadogKeys(useSavedKeys);
	const ddClientToken = await promptForDatadogClientToken(useSavedKeys);
	const ddSite = getDatadogSiteFromConfig();

	// 3. Select Datadog environment (resolved via API)
	const {
		ddEnvName: ddEnv,
		envId: ddEnvId,
		eppoEnvName,
	} = await selectDDEnvironment(
		migration.environmentMapping ?? [],
		ddApiKey,
		ddAppKey,
		ddSite,
		flagEnvironment,
	);
	console.log();

	// 4a. Collect Eppo SDK key for this specific environment
	const eppoSdkKey = await promptForEppoSdkKey(eppoEnvName, useSavedKeys);
	console.log();

	// 4b. Prompt for test subject ID
	let subjectId: string;
	if (testSubjectId !== undefined) {
		console.log(
			chalk.gray(`  Using test subject ID: ${chalk.cyan(testSubjectId)}\n`),
		);
		subjectId = testSubjectId;
	} else {
		subjectId = await input({
			message: 'Enter a test subject ID (user ID for flag evaluation):',
			validate: (v) =>
				v.trim().length > 0 ? true : 'Subject ID cannot be empty',
		});
		console.log();
	}

	// 5a. Generate test cases for each flag from its targeting rules
	const flagTestCases = migration.flags.map((flag) => ({
		flag,
		testCases: generateTestCases(flag),
	}));

	// Collect all unique attribute sets needed across all flags
	const uniqueAttrSets = new Map<string, SubjectAttributes>();
	for (const { testCases } of flagTestCases) {
		for (const tc of testCases) {
			const k = JSON.stringify(tc.attributes);
			if (!uniqueAttrSets.has(k)) uniqueAttrSets.set(k, tc.attributes);
		}
	}

	// 5b. Initialize Eppo SDK (non-fatal — errors surface in the table)
	const initSpinner = ora('Initializing Eppo SDK…').start();
	let eppoClient: unknown = null;
	let eppoInitError: string | undefined;

	try {
		eppoClient = await initializeEppo(eppoSdkKey);
		initSpinner.succeed('Eppo SDK initialized');
	} catch (err) {
		eppoInitError = err instanceof Error ? err.message : String(err);
		initSpinner.fail(
			`Eppo SDK initialization failed: ${chalk.red(eppoInitError)}`,
		);
	}

	// 6. Fetch Datadog data: flag list + assignments for every unique attribute set
	const ddSpinner = ora(
		`Fetching Datadog data for ${uniqueAttrSets.size} test context(s)…`,
	).start();
	let ddFlagsPerContext: Map<string, Record<string, DDFlagValue>>;
	let ddFlagKeys: Set<string>;
	let ddEnabledByKey: Map<string, boolean>;

	try {
		const [flagData, contextResults] = await Promise.all([
			fetchDDFlagData(ddApiKey, ddAppKey, ddSite, ddEnvId),
			Promise.all(
				[...uniqueAttrSets.entries()].map(async ([key, attrs]) => ({
					key,
					result: await fetchDDFlags(
						ddClientToken,
						ddSite,
						ddEnv,
						subjectId.trim(),
						attrs,
					),
				})),
			),
		]);

		ddFlagKeys = flagData.keys;
		ddEnabledByKey = flagData.enabledByKey;
		ddFlagsPerContext = new Map(contextResults.map((r) => [r.key, r.result]));

		const totalAssignments = contextResults.reduce(
			(sum, r) => sum + Object.keys(r.result).length,
			0,
		);
		ddSpinner.succeed(
			`Fetched ${totalAssignments} assignment(s) across ${ddFlagKeys.size} flag(s) ` +
				`and ${uniqueAttrSets.size} test context(s)`,
		);
	} catch (err) {
		ddSpinner.fail('Failed to fetch Datadog flag data');
		console.error(chalk.red(err instanceof Error ? err.message : String(err)));
		process.exit(1);
	}

	// 7. Evaluate each flag against each of its test cases
	const totalEvals = flagTestCases.reduce(
		(sum, { testCases }) => sum + testCases.length,
		0,
	);
	const evalSpinner = ora(
		`Evaluating ${migration.flags.length} flag(s) across ${totalEvals} test case(s)…`,
	).start();
	const rows: TableRow[] = [];

	const failedKeys = new Set((migration.failures ?? []).map((f) => f.key));
	const hasMigrationDetail = migration.failures !== undefined;

	const skippedFlagReason = new Map<string, string>();
	for (const s of migration.skippedFlags ?? []) {
		skippedFlagReason.set(s.key, s.reason);
	}
	const enableFailCountByFlag = new Map<string, number>();
	for (const f of migration.enableFailures ?? []) {
		enableFailCountByFlag.set(
			f.key,
			(enableFailCountByFlag.get(f.key) ?? 0) + 1,
		);
	}

	for (const { flag, testCases } of flagTestCases) {
		const skipReason = skippedFlagReason.get(flag.key);
		const envFailCount = enableFailCountByFlag.get(flag.key) ?? 0;
		const partialDetails: string[] = [];
		if (skipReason !== undefined) {
			partialDetails.push(skipReason);
		} else if (envFailCount > 0) {
			partialDetails.push(`Could not enable (${envFailCount} env(s))`);
		}

		const migrationStatus: MigrationStatus =
			skipReason !== undefined
				? 'skipped'
				: !hasMigrationDetail
					? 'unknown'
					: failedKeys.has(flag.key)
						? 'failed'
						: envFailCount > 0
							? 'partial'
							: 'created';
		const ddEnabled = ddEnabledByKey.get(flag.key) ?? null;

		const testResults: FlagTestResult[] = [];

		for (const tc of testCases) {
			const attrKey = JSON.stringify(tc.attributes);
			const ddFlagsForCase = ddFlagsPerContext.get(attrKey) ?? {};

			if (eppoInitError) {
				const ddFlag = ddFlagsForCase[flag.key];
				const ddStatus: DDStatus =
					ddFlag !== undefined
						? 'assigned'
						: ddFlagKeys.has(flag.key)
							? 'not-assigned'
							: 'not-in-dd';
				testResults.push({
					testCase: tc,
					eppoResult: 'ERROR',
					ddResult: ddFlag !== undefined ? String(ddFlag.variationValue) : '',
					ddStatus,
					match: false,
					error: `Eppo SDK: ${eppoInitError}`,
				});
			} else {
				const { eppoResult, ddResult, ddStatus, error } = await evaluateFlag(
					flag,
					subjectId.trim(),
					tc.attributes,
					eppoClient as EppoClient,
					ddFlagsForCase,
					ddFlagKeys,
				);
				testResults.push({
					testCase: tc,
					eppoResult,
					ddResult,
					ddStatus,
					match: !error && ddStatus === 'assigned' && eppoResult === ddResult,
					error,
				});
			}
		}

		rows.push({
			key: flag.key,
			testResults,
			migrationStatus,
			ddEnabled,
			partialDetails,
		});
	}
	evalSpinner.succeed('Evaluation complete');

	// 8. Render results
	renderTable(rows, providerLabel);
	printSummary(rows);

	// 9. Optional .xlsx export
	const flagByKey = new Map(migration.flags.map((f) => [f.key, f]));

	const exportToXlsx = await confirm({
		message: 'Would you like to export evaluation results to an .xlsx file?',
		default: false,
	});
	if (exportToXlsx) {
		const exportRows: EvaluationExportRow[] = rows.flatMap((row) => {
			const flag = flagByKey.get(row.key);
			return row.testResults.map((tr) => ({
				flagKey: row.key,
				flagName: flag?.name ?? row.key,
				team: flag?.owner?.name ?? '',
				testCaseLabel: tr.testCase.label,
				eppoResult: tr.eppoResult,
				ddResult: tr.ddResult,
				match: tr.match,
				ddStatus: tr.ddStatus,
				migrationStatus: row.migrationStatus,
				ddEnabled: row.ddEnabled,
				error: tr.error,
			}));
		});
		const { exportEvaluationToXlsx } = await import('./xlsx.js');
		await exportEvaluationToXlsx(
			exportRows,
			providerLabel,
			migration.migratedAt,
		);
	}
}

main().catch((err: unknown) => {
	if (err instanceof Error && err.name === 'ExitPromptError') {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), err);
	process.exit(1);
});
