#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import type { getInstance as getEppoInstance } from '@eppo/node-server-sdk';
import axios from 'axios';
import chalk from 'chalk';
import { confirm } from './components/Confirm.js';
import { EvaluationSummary } from './components/EvaluationSummary.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { input } from './components/Input.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import {
	type FlagTestResult,
	type MigrationStatus,
	ResultsTable,
	type TableRow,
} from './components/ResultsTable.js';
import { select } from './components/Select.js';
import { spinner as createSpinner } from './components/Spinner.js';
import { ddClient } from './datadog/api.js';
import type {
	MigrationEnvironmentMapping,
	MigrationMetadata,
} from './datadog/types.js';
import {
	evaluateEppoFlag,
	evaluateEppoFlagAdvanced,
	initializeEppo,
} from './eppo/evaluate.js';
import type { MigrationFile } from './eppo/types.js';
import {
	formatExampleTable,
	parseCsv,
	validateHeader,
} from './evaluate/csv.js';
import { fetchDDFlagData } from './evaluate/dd-flags.js';
import {
	CsvSource,
	type FlagWithTestCases,
	SyntheticSource,
	type TestCaseSource,
} from './evaluate/test-case-sources.js';
import {
	CONFIG_DIR,
	getDatadogSite,
	saveDatadogSite,
} from './helpers/config.js';
import { requireEnvVars } from './helpers/env.js';
import { fetchEnvironmentSdkKey, findSdkKeyOwner } from './launchdarkly/api.js';
import {
	evaluateLDFlag,
	evaluateLDFlagAdvanced,
	initializeLaunchDarkly,
	type LDClient,
} from './launchdarkly/evaluate.js';
import { mapFlagType } from './launchdarkly/helpers/migration.js';
import type { LDFlag, LDMigrationFile } from './launchdarkly/types.js';
import type {
	DDFlagValue,
	DDStatus,
	EvaluationExportRow,
	SubjectAttributes,
} from './types.js';

type EppoClient = ReturnType<typeof getEppoInstance>;

// ─── UI Helpers ───────────────────────────────────────────────────────────────

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.evaluate} />);
}

// ─── LD SDK Key Validation ────────────────────────────────────────────────────

/**
 * Resolves the LaunchDarkly SDK key to use for evaluation.
 *
 * Priority:
 *   1. If LAUNCHDARKLY_API_KEY is set, auto-fetch the correct SDK key for the
 *      selected project/environment — no need to set LAUNCHDARKLY_SDK_KEY.
 *   2. Otherwise fall back to LAUNCHDARKLY_SDK_KEY.
 *   3. If neither is set, exit with instructions for both options.
 *
 * When both are set but disagree, emits a warning and proceeds with the
 * auto-fetched key (which is guaranteed correct).
 */
async function validateLDSdkKey(
	migration: LDMigrationFile,
	sourceEnvName: string,
): Promise<string> {
	const ldApiKey = process.env.LAUNCHDARKLY_API_KEY?.trim();
	const manualSdkKey = process.env.LAUNCHDARKLY_SDK_KEY?.trim();

	// Auto-fetch path: use LAUNCHDARKLY_API_KEY to retrieve the right SDK key.
	if (ldApiKey) {
		try {
			const fetchedSdkKey = await fetchEnvironmentSdkKey(
				ldApiKey,
				migration.projectKey,
				sourceEnvName,
			);
			if (fetchedSdkKey) {
				console.log(
					chalk.gray(
						`  SDK key for "${sourceEnvName}" fetched via LAUNCHDARKLY_API_KEY\n`,
					),
				);

				// Warn if LAUNCHDARKLY_SDK_KEY is also set but points elsewhere.
				if (manualSdkKey && manualSdkKey !== fetchedSdkKey) {
					const tail = manualSdkKey.slice(-4);
					try {
						const owner = await findSdkKeyOwner(ldApiKey, manualSdkKey);
						let warn =
							`  ⚠ LAUNCHDARKLY_SDK_KEY (ending in "${tail}") doesn't match ` +
							`"${sourceEnvName}"`;
						if (owner) {
							warn += ` — it belongs to project "${owner.projectName}" / environment "${owner.envName}"`;
						}
						console.log(chalk.yellow(`${warn}. Using auto-fetched key.\n`));
					} catch {
						// Owner lookup failed — still proceed with fetched key
					}
				}

				return fetchedSdkKey;
			}
		} catch {
			// Fetch failed (wrong API key scope, network error, etc.) — fall through
			// to manual key so we degrade gracefully instead of blocking evaluation.
		}
	}

	// Manual key path: use LAUNCHDARKLY_SDK_KEY as-is.
	if (manualSdkKey) {
		return manualSdkKey;
	}

	// Neither key available.
	process.stderr.write(chalk.red('\nCannot determine LaunchDarkly SDK key.\n'));
	process.stderr.write(
		chalk.gray(
			`  Option 1 — set LAUNCHDARKLY_API_KEY (already required for migrate):\n` +
				`    The correct SDK key will be fetched automatically.\n\n` +
				`  Option 2 — set LAUNCHDARKLY_SDK_KEY directly:\n` +
				`    Find it in LaunchDarkly:\n` +
				`    Account Settings → Projects → ${migration.projectKey} → ${sourceEnvName} → SDK keys\n` +
				`    export LAUNCHDARKLY_SDK_KEY=sdk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\n\n`,
		),
	);
	process.exit(1);
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

function parseArgs(): {
	testSubjectId: string | undefined;
	useLatestMigration: boolean;
	flagEnvironment: string | undefined;
	datadogSite: string | undefined;
	csvPath: string | undefined;
	forceShowTable: boolean;
} {
	const args = process.argv.slice(2);
	const useLatestMigration = args.includes('--use-latest-migration');
	const forceShowTable = args.includes('--show-table');
	const subjectArg = args.find((a) => a.startsWith('--test-subject-id='));
	const testSubjectId = subjectArg
		? subjectArg.slice('--test-subject-id='.length)
		: undefined;
	const envArg = args.find((a) => a.startsWith('--flag-environment='));
	const flagEnvironment = envArg
		? envArg.slice('--flag-environment='.length)
		: undefined;
	const siteArg = args.find((a) => a.startsWith('--datadog-site='));
	const datadogSite = siteArg
		? siteArg.slice('--datadog-site='.length).trim()
		: undefined;
	if (datadogSite !== undefined && datadogSite.length === 0) {
		process.stderr.write(chalk.red('\n--datadog-site must not be empty.\n\n'));
		process.exit(1);
	}
	const csvArg = args.find((a) => a.startsWith('--csv='));
	const csvPath = csvArg ? csvArg.slice('--csv='.length) : undefined;
	return {
		testSubjectId,
		useLatestMigration,
		flagEnvironment,
		datadogSite,
		csvPath,
		forceShowTable,
	};
}

// ─── Migration File Selection ─────────────────────────────────────────────────

async function selectMigrationFile(useLatest = false): Promise<MigrationFile> {
	if (!fs.existsSync(CONFIG_DIR)) {
		console.log(chalk.red('\n  No migration files found.'));
		console.log(
			chalk.gray(
				`  Run 'dd-flag-migration migrate' to perform a migration first.\n`,
			),
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
			chalk.gray(
				`  Run 'dd-flag-migration migrate' to perform a migration first.\n`,
			),
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

// ─── Evaluation Mode Selection ────────────────────────────────────────────────

async function promptForEvaluationMode(
	csvPathArg: string | undefined,
): Promise<'basic' | 'advanced'> {
	if (csvPathArg !== undefined) return 'advanced';
	const choice = await select<'basic' | 'advanced'>({
		message: 'Which evaluation type would you like to run?',
		choices: [
			{
				name: "Basic Evaluation — auto-generate test cases from each flag's targeting rules",
				value: 'basic',
			},
			{
				name: 'Advanced Evaluation (CSV import) — provide your own test cases via CSV',
				value: 'advanced',
			},
		],
	});
	return choice;
}

async function pickCsvFile(csvPathArg: string | undefined): Promise<string> {
	if (csvPathArg !== undefined) return csvPathArg;
	const csvFiles = fs
		.readdirSync(process.cwd())
		.filter((f) => f.endsWith('.csv') && f !== 'LICENSE-3rdparty.csv')
		.sort();
	if (csvFiles.length > 0) {
		const CUSTOM_PATH = '__custom__';
		const chosen = await select<string>({
			message: 'Select a CSV file:',
			choices: [
				...csvFiles.map((f) => ({
					name: f,
					value: path.join(process.cwd(), f),
				})),
				{ name: 'Enter a different path…', value: CUSTOM_PATH },
			],
		});
		if (chosen !== CUSTOM_PATH) return chosen;
	}
	const entered = await input({
		message: 'Enter the path to your CSV file:',
		validate: (v) => {
			if (!v.trim()) return 'Path cannot be empty';
			if (!fs.existsSync(v.trim())) return `File not found: ${v.trim()}`;
			return true;
		},
	});
	return path.resolve(entered.trim());
}

// ─── Datadog Site Prompt ─────────────────────────────────────────────────────

async function promptForDatadogSite(
	datadogSiteArg: string | undefined,
): Promise<string> {
	if (datadogSiteArg !== undefined) {
		console.log(
			chalk.gray(`  Using Datadog site: ${chalk.cyan(datadogSiteArg)}\n`),
		);
		return datadogSiteArg;
	}

	const stored = getDatadogSite();

	if (stored) {
		const useStored = await confirm({
			message: `Use your saved Datadog site (${stored})?`,
			default: true,
		});
		if (useStored) return stored;
	}

	console.log(
		chalk.gray('  (e.g. "datadoghq.com", "datadoghq.eu", "us5.datadoghq.com")'),
	);
	const site = await input({
		message: 'Which Datadog site does your org use?',
		default: 'datadoghq.com',
		validate: (v) => (v.trim().length > 0 ? true : 'Site cannot be empty'),
	});

	const trimmed = site.trim();
	saveDatadogSite(trimmed);
	console.log(chalk.gray('  Site saved for future sessions.\n'));
	return trimmed;
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
		const resp = await ddClient.get<{
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

	const ddEnvName = matched.queries[0];
	return { ddEnvName, envId, sourceEnvName };
}

// ─── Datadog Flag Fetching ───────────────────────────────────────────────────

function buildEndpointHost(site: string): string {
	return `preview.ff-cdn.${site}`;
}

const DD_FETCH_CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
			}
		},
	);
	await Promise.all(workers);
	return results;
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
		// Intentionally uses plain axios — precompute-assignments accepts dd-client-token
		// (not a management API key), so it belongs to a different rate-limit bucket
		// and is not routed through ddClient.
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const {
		testSubjectId,
		useLatestMigration,
		flagEnvironment,
		datadogSite,
		csvPath,
		forceShowTable,
	} = parseArgs();

	// Validate Datadog env vars up front. Provider-specific SDK env vars are
	// validated after the migration file is loaded so we know which provider
	// was used.
	const ddEnvVars = requireEnvVars([
		'DD_API_KEY',
		'DD_APP_KEY',
		'DD_CLIENT_TOKEN',
	]);
	const ddApiKey = ddEnvVars.DD_API_KEY;
	const ddAppKey = ddEnvVars.DD_APP_KEY;
	const ddClientToken = ddEnvVars.DD_CLIENT_TOKEN;

	await printHeader();

	// 1. Select migration file
	const migration = await selectMigrationFile(useLatestMigration);
	const providerLabel =
		migration.provider === 'eppo'
			? 'Eppo'
			: migration.provider.charAt(0).toUpperCase() +
				migration.provider.slice(1);

	console.log(chalk.bold('Migrated from: ') + chalk.green(providerLabel));
	if (migration.provider === 'launchdarkly') {
		const ldMigration = migration as unknown as LDMigrationFile;
		if (ldMigration.projectKey) {
			console.log(
				chalk.gray(
					`  Project:      ${ldMigration.projectName}  (${ldMigration.projectKey})`,
				),
			);
		}
	}
	console.log(
		chalk.gray(
			`  Migrated at:  ${new Date(migration.migratedAt).toLocaleString()}`,
		),
	);
	console.log(chalk.gray(`  Flags:        ${migration.flags.length}`));
	console.log();

	// 1b. Determine evaluation mode
	const isAdvanced = (await promptForEvaluationMode(csvPath)) === 'advanced';

	let resolvedCsvPath: string | undefined;
	let parsedCsv: { header: string[]; rows: string[][] } | undefined;
	if (isAdvanced) {
		const provider =
			migration.provider === 'launchdarkly' ? 'launchdarkly' : 'eppo';
		console.log();
		console.log(formatExampleTable(provider));
		console.log();
		resolvedCsvPath = await pickCsvFile(csvPath);

		let csvContent: string;
		try {
			csvContent = fs.readFileSync(resolvedCsvPath, 'utf-8');
		} catch (err) {
			console.error(
				chalk.red('\n  Could not read CSV file:'),
				err instanceof Error ? err.message : String(err),
			);
			process.exit(1);
		}
		try {
			parsedCsv = parseCsv(csvContent);
			validateHeader(parsedCsv.header, parsedCsv.rows, provider);
		} catch (err) {
			console.error(
				chalk.red('\n  CSV validation failed:'),
				err instanceof Error ? err.message : String(err),
			);
			process.exit(1);
		}
		console.log();
	}

	// 2. Resolve Datadog site
	const ddSite = await promptForDatadogSite(datadogSite);

	// 3. Select Datadog environment (resolved via API)
	const isLD = migration.provider === 'launchdarkly';

	// Validate that the Eppo SDK key is present before going further (Eppo only —
	// LD SDK key is validated after environment selection so we can include context).
	if (!isLD) {
		requireEnvVars(['EPPO_SDK_KEY']);
	}

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

	// 4a. Validate provider SDK key now that we know the source environment.
	let providerSdkKey: string;
	if (isLD) {
		providerSdkKey = await validateLDSdkKey(
			migration as unknown as LDMigrationFile,
			sourceEnvName,
		);
	} else {
		const eppoEnv = requireEnvVars(['EPPO_SDK_KEY']);
		providerSdkKey = eppoEnv.EPPO_SDK_KEY;
	}

	// 4b. Prompt for test subject ID (only in Basic mode)
	let subjectId: string;
	if (!isAdvanced) {
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
	} else {
		// Advanced mode: each CSV row provides its own subjectId via subjectIdOverride
		subjectId = '';
	}

	// 5a. Load test cases via source
	// resolvedCsvPath is always set when isAdvanced (assigned in the isAdvanced block above)
	if (isAdvanced && resolvedCsvPath === undefined) {
		throw new Error(
			'Internal error: resolvedCsvPath must be set in Advanced mode',
		);
	}
	const source: TestCaseSource = isAdvanced
		? // biome-ignore lint/style/noNonNullAssertion: invariant checked above
			new CsvSource(resolvedCsvPath!, parsedCsv)
		: new SyntheticSource();

	let flagTestCases: FlagWithTestCases[];
	try {
		flagTestCases = await source.collect(migration, sourceEnvName);
	} catch (err) {
		console.error(
			chalk.red('\n  Error loading test cases:'),
			err instanceof Error ? err.message : String(err),
		);
		process.exit(1);
	}

	// Track which flag keys are in the migration file
	const migrationFileKeys = new Set(migration.flags.map((f) => f.key));
	const ldDatadogKeyBySource = isLD
		? new Map(
				((migration as unknown as LDMigrationFile).flagKeyMapping ?? []).map(
					(mapping) => [mapping.sourceKey, mapping.datadogKey],
				),
			)
		: null;

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
	const initSpinner = createSpinner(
		`Initializing ${providerLabel} SDK…`,
	).start();
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
	const ddSpinner = createSpinner(
		`Fetching Datadog data for ${uniqueContexts.size} test context(s)…`,
	).start();
	let ddFlagsPerContext: Map<string, Record<string, DDFlagValue>>;
	let ddFlagKeys: Set<string>;
	let ddEnabledByKey: Map<string, boolean>;
	let ddValueTypeByKey: Map<string, string>;
	let ddMigrationMetadataByKey: Map<string, MigrationMetadata>;

	const contextEntries = [...uniqueContexts.entries()];

	try {
		const [flagData, contextResults] = await Promise.all([
			fetchDDFlagData(ddApiKey, ddAppKey, ddSite, ddEnvId),
			mapWithConcurrency(
				contextEntries,
				DD_FETCH_CONCURRENCY,
				async ([key, ctx]) => ({
					key,
					result: await fetchDDFlags(
						ddClientToken,
						ddSite,
						ddEnv,
						ctx.subjectId.trim(),
						ctx.attributes,
					),
				}),
			),
		]);

		ddFlagKeys = flagData.keys;
		ddEnabledByKey = flagData.enabledByKey;
		ddValueTypeByKey = flagData.valueTypeByKey;
		ddMigrationMetadataByKey = flagData.migrationMetadataByKey;
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
	const evalSpinner = createSpinner(
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
		const inMigrationFile = migrationFileKeys.has(flagKey);
		const datadogFlagKey = ldDatadogKeyBySource?.get(flagKey) ?? flagKey;
		const ddMigrationMetadata = ddMigrationMetadataByKey.get(datadogFlagKey);

		const skipReason = skippedFlagReason.get(flagKey);
		const envFailCount = enableFailCountByFlag.get(flagKey) ?? 0;
		const partialDetails: string[] = [];
		if (skipReason !== undefined) {
			partialDetails.push(skipReason);
		} else if (envFailCount > 0) {
			partialDetails.push(`Could not enable (${envFailCount} env(s))`);
		}

		const migrationStatus: MigrationStatus = !inMigrationFile
			? 'not-in-migration-file'
			: skipReason !== undefined
				? 'skipped'
				: !hasMigrationDetail
					? 'unknown'
					: failedKeys.has(flagKey)
						? 'failed'
						: envFailCount > 0
							? 'partial'
							: 'created';
		const ddEnabled = ddEnabledByKey.get(datadogFlagKey) ?? null;

		const testResults: FlagTestResult[] = [];

		for (const tc of testCases) {
			const tcSubjectId = tc.subjectIdOverride ?? subjectId;
			const contextKey = JSON.stringify({
				s: tcSubjectId,
				a: tc.attributes,
			});
			const ddFlagsForCase = ddFlagsPerContext.get(contextKey) ?? {};

			if (providerInitError) {
				const ddFlag = ddFlagsForCase[datadogFlagKey];
				const ddStatus: DDStatus =
					ddFlag !== undefined
						? 'assigned'
						: ddFlagKeys.has(datadogFlagKey)
							? 'not-assigned'
							: 'not-in-dd';
				testResults.push({
					testCase: tc,
					providerResult: 'ERROR',
					ddResult: ddFlag !== undefined ? String(ddFlag.variationValue) : '',
					ddStatus,
					match: false,
					error: `${providerLabel} SDK: ${providerInitError}`,
					providerStatus: 'error',
				});
			} else if (
				isAdvanced &&
				!inMigrationFile &&
				!ddFlagKeys.has(datadogFlagKey)
			) {
				// Flag not in migration file and not found in DD — skip provider call, will classify as notInDD
				testResults.push({
					testCase: tc,
					providerResult: '',
					ddResult: '',
					ddStatus: 'not-in-dd',
					match: false,
					providerStatus: 'not-evaluated',
				});
			} else if (isLD) {
				if (isAdvanced) {
					// Advanced LD mode
					let vtype = 'STRING';
					if (inMigrationFile) {
						// biome-ignore lint/style/noNonNullAssertion: ldFlagByKey is set when isLD
						const ldFlag = ldFlagByKey!.get(flagKey);
						if (ldFlag) vtype = mapFlagType(ldFlag);
					} else {
						vtype = ddValueTypeByKey.get(flagKey) ?? 'STRING';
					}
					const evalResult = await evaluateLDFlagAdvanced(
						flagKey,
						vtype,
						tcSubjectId.trim(),
						tc.attributes,
						providerClient as LDClient,
						ddFlagsForCase,
						ddFlagKeys,
						datadogFlagKey,
						tc.contextAttributes,
						tc.ldUserAttributes,
					);
					testResults.push({
						testCase: tc,
						...evalResult,
						match:
							evalResult.providerStatus === 'found' &&
							evalResult.ddStatus === 'assigned' &&
							!evalResult.error &&
							evalResult.providerResult === evalResult.ddResult,
					});
				} else {
					// Basic LD mode
					// biome-ignore lint/style/noNonNullAssertion: ldFlagByKey is always set when isLD
					const ldFlag = ldFlagByKey!.get(flagKey);
					if (!ldFlag) continue;
					const evalResult = await evaluateLDFlag(
						ldFlag,
						tcSubjectId.trim(),
						tc.attributes,
						providerClient as LDClient,
						ddFlagsForCase,
						ddFlagKeys,
						datadogFlagKey,
						tc.contextAttributes,
						tc.ldUserAttributes,
					);
					testResults.push({
						testCase: tc,
						...evalResult,
						match:
							!evalResult.error &&
							evalResult.ddStatus === 'assigned' &&
							evalResult.providerResult === evalResult.ddResult,
						// Basic mode has no FLAG_NOT_FOUND detection; providerStatus is
						// always 'found' or 'error' — missing flags show as match/diff.
						providerStatus: evalResult.error ? 'error' : 'found',
					});
				}
			} else {
				if (isAdvanced) {
					// Advanced Eppo mode
					// biome-ignore lint/style/noNonNullAssertion: eppoFlagByKey is set when !isLD
					const eppoFlag = eppoFlagByKey!.get(flagKey);
					let vtype = 'STRING';
					if (inMigrationFile && eppoFlag) {
						vtype = eppoFlag.variation_type ?? 'STRING';
					} else {
						vtype = ddValueTypeByKey.get(flagKey) ?? 'STRING';
					}
					const evalResult = await evaluateEppoFlagAdvanced(
						flagKey,
						vtype,
						tcSubjectId.trim(),
						tc.attributes,
						providerClient as EppoClient,
						ddFlagsForCase,
						ddFlagKeys,
					);
					testResults.push({
						testCase: tc,
						...evalResult,
						match:
							evalResult.providerStatus === 'found' &&
							evalResult.ddStatus === 'assigned' &&
							!evalResult.error &&
							evalResult.providerResult === evalResult.ddResult,
					});
				} else {
					// Basic Eppo mode
					// biome-ignore lint/style/noNonNullAssertion: eppoFlagByKey is always set when !isLD
					const eppoFlag = eppoFlagByKey!.get(flagKey);
					if (!eppoFlag) continue;
					const evalResult = await evaluateEppoFlag(
						eppoFlag,
						tcSubjectId.trim(),
						tc.attributes,
						providerClient as EppoClient,
						ddFlagsForCase,
						ddFlagKeys,
					);
					testResults.push({
						testCase: tc,
						...evalResult,
						match:
							!evalResult.error &&
							evalResult.ddStatus === 'assigned' &&
							evalResult.providerResult === evalResult.ddResult,
						// Basic mode has no FLAG_NOT_FOUND detection; providerStatus is
						// always 'found' or 'error' — missing flags show as match/diff.
						providerStatus: evalResult.error ? 'error' : 'found',
					});
				}
			}
		}

		rows.push({
			key: flagKey,
			testResults,
			migrationStatus,
			ddEnabled,
			partialDetails,
			inMigrationFile,
			ddMigrationMetadata,
		});
	}
	evalSpinner.succeed('Evaluation complete');

	// Close LD client if used
	if (isLD && providerClient) {
		await (providerClient as LDClient).close();
	}

	// 8. Render results
	const totalRows = rows.reduce((sum, r) => sum + r.testResults.length, 0);
	const showTable = forceShowTable || !isAdvanced || totalRows < 100;

	if (showTable) {
		await renderStatic(
			<ResultsTable rows={rows} providerLabel={providerLabel} />,
			{ stream: process.stdout },
		);
		await renderStatic(<EvaluationSummary rows={rows} />, {
			stream: process.stdout,
		});
	}

	// SDK keys are scoped to a specific provider environment, so a mismatch can
	// easily mean the SDK key is for the wrong environment rather than a real
	// migration bug. Surface this whenever we see at least one differing result.
	const hasDiffer = rows.some((r) =>
		r.testResults.some(
			(t) => !t.match && !t.error && t.ddStatus === 'assigned',
		),
	);
	if (hasDiffer) {
		const envVarName = isLD ? 'LAUNCHDARKLY_SDK_KEY' : 'EPPO_SDK_KEY';
		const tail = providerSdkKey.slice(-4);
		console.log(
			chalk.yellow(
				`  Reminder: SDK keys are scoped to your environment. Be sure that your ` +
					`${envVarName} ending in "${tail}" belongs to your "${sourceEnvName}" environment.`,
			),
		);
		console.log();
	}

	// 9. Build export rows
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
			inMigrationFile: row.inMigrationFile,
			providerStatus: tr.providerStatus,
			ddMigrationMetadata: row.ddMigrationMetadata,
		}));
	});

	// 10. Optional .xlsx export
	const { exportEvaluationToXlsx } = await import('./eppo/helpers/xlsx.js');

	const ldProjectInfo =
		migration.provider === 'launchdarkly'
			? {
					key: (migration as unknown as LDMigrationFile).projectKey,
					name: (migration as unknown as LDMigrationFile).projectName,
				}
			: undefined;

	if (isAdvanced && totalRows >= 100) {
		if (!showTable) {
			await renderStatic(<EvaluationSummary rows={rows} />, {
				stream: process.stdout,
			});
		}
		await exportEvaluationToXlsx(
			exportRows,
			providerLabel,
			migration.migratedAt,
			ldProjectInfo,
		);
	} else {
		const exportToXlsx = await confirm({
			message: 'Would you like to export evaluation results to an .xlsx file?',
			default: true,
		});
		if (exportToXlsx) {
			await exportEvaluationToXlsx(
				exportRows,
				providerLabel,
				migration.migratedAt,
				ldProjectInfo,
			);
		}
	}
}

main().catch((err: unknown) => {
	if (err instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), err);
	process.exit(1);
});
