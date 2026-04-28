#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { confirm, input, password, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import {
	CONFIG_DIR,
	getDatadogClientToken,
	getDatadogKeys,
	getDatadogSite,
	saveDatadogClientToken,
	saveDatadogKeys,
} from './config.js';
import {
	evaluateEppoFlag,
	generateEppoTestCases,
	initializeEppo,
	promptForEppoSdkKey,
} from './eppo/evaluate.js';
import {
	evaluateLDFlag,
	generateLDTestCases,
	initializeLaunchDarkly,
	type LDClient,
	promptForLDSdkKey,
} from './launchdarkly/evaluate.js';
import type { LDFlag } from './launchdarkly/types.js';
import type {
	DDFlagValue,
	DDStatus,
	EvaluationExportRow,
	MigrationEnvironmentMapping,
	MigrationFile,
	SubjectAttributes,
	TestCase,
} from './types.js';

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

// ─── Datadog Credential Prompts ──────────────────────────────────────────────

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
		console.log(chalk.gray('  Using saved Datadog keys.\n'));
		return { apiKey: stored.apiKey, appKey: stored.appKey };
	}

	if (stored.apiKey && stored.appKey) {
		const useStored = await confirm({
			message: 'Use your saved Datadog keys?',
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

// ─── Datadog Environment Selection ───────────────────────────────────────────

type ApiEnvironment = { id: string; queries: string[] };

async function fetchEnvironmentsFromApi(
	apiKey: string,
	appKey: string,
	site: string,
): Promise<ApiEnvironment[]> {
	const baseUrl = `https://api.${site}`;
	try {
		const resp = await axios.get<{
			data: Array<{ id: string; attributes: { queries: string[] } }>;
		}>(`${baseUrl}/api/v2/feature-flags/environments`, {
			headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
		});
		return resp.data.data.map((item) => ({
			id: item.id,
			queries: item.attributes.queries ?? [],
		}));
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			throw new Error(
				'Datadog API returned 403 Forbidden when fetching feature flag environments.\n' +
					'  Please check that:\n' +
					'  • Your Datadog API key and Application key are valid\n' +
					'  • Your Application key has permission to read feature flags',
			);
		}
		if (axios.isAxiosError(err) && err.response?.status === 401) {
			throw new Error(
				'Datadog API returned 401 Unauthorized.\n' +
					'  Your API key or Application key is invalid.',
			);
		}
		throw err;
	}
}

async function selectDDEnvironment(
	environmentMapping: MigrationEnvironmentMapping[],
	apiKey: string,
	appKey: string,
	site: string,
	flagEnvironment?: string,
): Promise<{ ddEnvName: string; envId: string; sourceEnvName: string }> {
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
	const sourceEnvName = chosen.sourceEnvName;

	if (matched.queries.length === 1 || flagEnvironment !== undefined)
		return { ddEnvName: matched.queries[0], envId, sourceEnvName };

	const ddEnvName = await select<string>({
		message: `Select a DD_ENV for "${chosen.datadogEnvName}":`,
		choices: matched.queries.map((q) => ({ name: q, value: q })),
	});
	return { ddEnvName, envId, sourceEnvName };
}

// ─── Datadog Flag Fetching ───────────────────────────────────────────────────

function buildEndpointHost(site: string): string {
	return `preview.ff-cdn.${site}`;
}

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
	try {
		while (true) {
			const resp = await axios.get<{ data: DDFlagListItem[] }>(
				`${baseUrl}/api/v2/feature-flags`,
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
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			throw new Error(
				'Datadog API returned 403 Forbidden when fetching feature flags.\n' +
					'  Please check that:\n' +
					'  • Your Datadog API key and Application key are valid\n' +
					'  • Your Application key has permission to read feature flags',
			);
		}
		if (axios.isAxiosError(err) && err.response?.status === 401) {
			throw new Error(
				'Datadog API returned 401 Unauthorized.\n' +
					'  Your API key or Application key is invalid.',
			);
		}
		throw err;
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
						sdk: { name: 'migration', version: 'dev' },
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

// ─── Table Rendering ──────────────────────────────────────────────────────────

type MigrationStatus = 'created' | 'partial' | 'failed' | 'skipped' | 'unknown';

interface FlagTestResult {
	testCase: TestCase;
	providerResult: string;
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

			let providerDisplay: string;
			let ddDisplay: string;

			if (tr.error) {
				providerDisplay = chalk.red(pad('ERROR', COL_EVAL));
				ddDisplay =
					tr.ddStatus === 'assigned'
						? chalk.dim(pad(tr.ddResult, COL_EVAL))
						: chalk.dim(pad('—', COL_EVAL));
			} else if (
				tr.ddStatus === 'not-in-dd' ||
				tr.ddStatus === 'not-assigned'
			) {
				providerDisplay = chalk.dim(pad(tr.providerResult, COL_EVAL));
				ddDisplay = chalk.dim(pad('—', COL_EVAL));
			} else if (tr.match) {
				providerDisplay = chalk.green(pad(tr.providerResult, COL_EVAL));
				ddDisplay = chalk.green(pad(tr.ddResult, COL_EVAL));
			} else {
				providerDisplay = chalk.yellow(pad(tr.providerResult, COL_EVAL));
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
					providerDisplay +
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
	const isLD = migration.provider === 'launchdarkly';
	const {
		ddEnvName: ddEnv,
		envId: ddEnvId,
		sourceEnvName,
	} = await selectDDEnvironment(
		migration.environmentMapping ?? [],
		ddApiKey,
		ddAppKey,
		ddSite,
		flagEnvironment,
	);
	console.log();

	// 4a. Collect provider SDK key for this specific environment
	let providerSdkKey: string;
	if (isLD) {
		providerSdkKey = await promptForLDSdkKey(sourceEnvName, useSavedKeys);
	} else {
		providerSdkKey = await promptForEppoSdkKey(sourceEnvName, useSavedKeys);
	}
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
	type FlagWithTestCases = {
		flagKey: string;
		flagName: string;
		team: string;
		testCases: TestCase[];
	};
	let flagTestCases: FlagWithTestCases[];

	if (isLD) {
		const ldFlags = migration.flags as unknown as LDFlag[];
		flagTestCases = ldFlags.map((flag) => ({
			flagKey: flag.key,
			flagName: flag.name,
			team: flag._maintainerTeam?.name ?? flag._maintainer?.email ?? '',
			testCases: generateLDTestCases(flag, sourceEnvName),
		}));
	} else {
		flagTestCases = migration.flags.map((flag) => ({
			flagKey: flag.key,
			flagName: flag.name,
			team: flag.owner?.name ?? '',
			testCases: generateEppoTestCases(flag),
		}));
	}

	// Collect all unique (subjectId, attributes) contexts needed across all flags
	type DDContext = { subjectId: string; attributes: SubjectAttributes };
	const uniqueContexts = new Map<string, DDContext>();
	for (const { testCases } of flagTestCases) {
		for (const tc of testCases) {
			const sid = tc.subjectIdOverride ?? subjectId;
			const k = JSON.stringify({ s: sid, a: tc.attributes });
			if (!uniqueContexts.has(k))
				uniqueContexts.set(k, { subjectId: sid, attributes: tc.attributes });
		}
	}

	// 5b. Initialize provider SDK (non-fatal — errors surface in the table)
	const initSpinner = ora(`Initializing ${providerLabel} SDK…`).start();
	let providerClient: unknown = null;
	let providerInitError: string | undefined;

	try {
		if (isLD) {
			providerClient = await initializeLaunchDarkly(providerSdkKey);
		} else {
			providerClient = await initializeEppo(providerSdkKey);
		}
		initSpinner.succeed(`${providerLabel} SDK initialized`);
	} catch (err) {
		providerInitError = err instanceof Error ? err.message : String(err);
		initSpinner.fail(
			`${providerLabel} SDK initialization failed: ${chalk.red(providerInitError)}`,
		);
	}

	// 6. Fetch Datadog data: flag list + assignments for every unique context
	const ddSpinner = ora(
		`Fetching Datadog data for ${uniqueContexts.size} test context(s)…`,
	).start();
	let ddFlagsPerContext: Map<string, Record<string, DDFlagValue>>;
	let ddFlagKeys: Set<string>;
	let ddEnabledByKey: Map<string, boolean>;

	try {
		const [flagData, contextResults] = await Promise.all([
			fetchDDFlagData(ddApiKey, ddAppKey, ddSite, ddEnvId),
			Promise.all(
				[...uniqueContexts.entries()].map(async ([key, ctx]) => ({
					key,
					result: await fetchDDFlags(
						ddClientToken,
						ddSite,
						ddEnv,
						ctx.subjectId.trim(),
						ctx.attributes,
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
				`and ${uniqueContexts.size} test context(s)`,
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
		`Evaluating ${flagTestCases.length} flag(s) across ${totalEvals} test case(s)…`,
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

	// Build flag lookup for provider-specific evaluation
	const ldFlagByKey = isLD
		? new Map((migration.flags as unknown as LDFlag[]).map((f) => [f.key, f]))
		: null;
	const eppoFlagByKey = !isLD
		? new Map(migration.flags.map((f) => [f.key, f]))
		: null;

	for (const { flagKey, testCases } of flagTestCases) {
		const skipReason = skippedFlagReason.get(flagKey);
		const envFailCount = enableFailCountByFlag.get(flagKey) ?? 0;
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
					: failedKeys.has(flagKey)
						? 'failed'
						: envFailCount > 0
							? 'partial'
							: 'created';
		const ddEnabled = ddEnabledByKey.get(flagKey) ?? null;

		const testResults: FlagTestResult[] = [];

		for (const tc of testCases) {
			const tcSubjectId = tc.subjectIdOverride ?? subjectId;
			const contextKey = JSON.stringify({
				s: tcSubjectId,
				a: tc.attributes,
			});
			const ddFlagsForCase = ddFlagsPerContext.get(contextKey) ?? {};

			if (providerInitError) {
				const ddFlag = ddFlagsForCase[flagKey];
				const ddStatus: DDStatus =
					ddFlag !== undefined
						? 'assigned'
						: ddFlagKeys.has(flagKey)
							? 'not-assigned'
							: 'not-in-dd';
				testResults.push({
					testCase: tc,
					providerResult: 'ERROR',
					ddResult: ddFlag !== undefined ? String(ddFlag.variationValue) : '',
					ddStatus,
					match: false,
					error: `${providerLabel} SDK: ${providerInitError}`,
				});
			} else if (isLD) {
				// biome-ignore lint/style/noNonNullAssertion: ldFlagByKey is always set when isLD
				const ldFlag = ldFlagByKey!.get(flagKey);
				if (!ldFlag) continue;
				const { providerResult, ddResult, ddStatus, error } =
					await evaluateLDFlag(
						ldFlag,
						tcSubjectId.trim(),
						tc.attributes,
						providerClient as LDClient,
						ddFlagsForCase,
						ddFlagKeys,
					);
				testResults.push({
					testCase: tc,
					providerResult,
					ddResult,
					ddStatus,
					match:
						!error && ddStatus === 'assigned' && providerResult === ddResult,
					error,
				});
			} else {
				// biome-ignore lint/style/noNonNullAssertion: eppoFlagByKey is always set when !isLD
				const eppoFlag = eppoFlagByKey!.get(flagKey);
				if (!eppoFlag) continue;
				const { providerResult, ddResult, ddStatus, error } =
					await evaluateEppoFlag(
						eppoFlag,
						tcSubjectId.trim(),
						tc.attributes,
						providerClient as ReturnType<
							typeof import('@eppo/node-server-sdk').getInstance
						>,
						ddFlagsForCase,
						ddFlagKeys,
					);
				testResults.push({
					testCase: tc,
					providerResult,
					ddResult,
					ddStatus,
					match:
						!error && ddStatus === 'assigned' && providerResult === ddResult,
					error,
				});
			}
		}

		rows.push({
			key: flagKey,
			testResults,
			migrationStatus,
			ddEnabled,
			partialDetails,
		});
	}
	evalSpinner.succeed('Evaluation complete');

	// Close LD client if used
	if (isLD && providerClient) {
		await (providerClient as LDClient).close();
	}

	// 8. Render results
	renderTable(rows, providerLabel);
	printSummary(rows);

	// 9. Optional .xlsx export
	const exportToXlsx = await confirm({
		message: 'Would you like to export evaluation results to an .xlsx file?',
		default: false,
	});
	if (exportToXlsx) {
		const flagMeta = new Map(
			flagTestCases.map((f) => [f.flagKey, { name: f.flagName, team: f.team }]),
		);
		const exportRows: EvaluationExportRow[] = rows.flatMap((row) => {
			const meta = flagMeta.get(row.key);
			return row.testResults.map((tr) => ({
				flagKey: row.key,
				flagName: meta?.name ?? row.key,
				team: meta?.team ?? '',
				testCaseLabel: tr.testCase.label,
				providerResult: tr.providerResult,
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
