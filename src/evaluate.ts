#!/usr/bin/env node
import { select, password, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import path from 'node:path';
import fs from 'node:fs';
import {
  CONFIG_DIR,
  getEppoSdkKeyForEnv,
  saveEppoSdkKeyForEnv,
  getDatadogKeys,
  saveDatadogKeys,
  getDatadogClientToken,
  saveDatadogClientToken,
  getDatadogSite,
} from './config.js';
import type { MigrationFile, EppoFlag, MigrationEnvironmentMapping } from './types.js';

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function printHeader(): void {
  const purple = chalk.bold.hex('#632CA6');
  console.log();
  console.log(purple('╔══════════════════════════════════════════╗'));
  console.log(purple('║') + chalk.bold.white('   🚩  Feature Flag Migration Tool  🚩    ') + purple('║'));
  console.log(purple('║') + chalk.hex('#632CA6')('           Evaluate Migration             ') + purple('║'));
  console.log(purple('╚══════════════════════════════════════════╝'));
  console.log();
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

function parseArgs(): { useSavedKeys: boolean; testSubjectId: string | undefined; useLatestMigration: boolean; flagEnvironment: string | undefined } {
  const args = process.argv.slice(2);
  const useSavedKeys = args.includes('--use-saved-keys');
  const useLatestMigration = args.includes('--use-latest-migration');
  const subjectArg = args.find((a) => a.startsWith('--test-subject-id='));
  const testSubjectId = subjectArg ? subjectArg.slice('--test-subject-id='.length) : undefined;
  const envArg = args.find((a) => a.startsWith('--flag-environment='));
  const flagEnvironment = envArg ? envArg.slice('--flag-environment='.length) : undefined;
  return { useSavedKeys, testSubjectId, useLatestMigration, flagEnvironment };
}

// ─── Migration File Selection ─────────────────────────────────────────────────

async function selectMigrationFile(useLatest = false): Promise<MigrationFile> {
  if (!fs.existsSync(CONFIG_DIR)) {
    console.log(chalk.red('\n  No migration files found.'));
    console.log(chalk.gray(`  Run 'yarn migrate' to perform a migration first.\n`));
    process.exit(1);
  }

  const files = fs.readdirSync(CONFIG_DIR)
    .filter((f) => f.startsWith('migration-') && f.endsWith('.json'))
    .sort()
    .reverse(); // newest-first (ISO timestamps sort lexicographically)

  if (files.length === 0) {
    console.log(chalk.red('\n  No migration files found.'));
    console.log(chalk.gray(`  Run 'yarn migrate' to perform a migration first.\n`));
    process.exit(1);
  }

  let chosen: string;

  if (files.length === 1 || useLatest) {
    console.log(chalk.gray(`  Using migration file: ${chalk.cyan(files[0])}\n`));
    chosen = files[0];
  } else {
    chosen = await select<string>({
      message: 'Select a migration to evaluate:',
      choices: files.map((f) => {
        const iso = f.replace('migration-', '').replace('.json', '');
        const date = new Date(iso);
        const dateStr = isNaN(date.getTime()) ? '' : `  ${chalk.gray(date.toLocaleString())}`;
        return { name: `${f}${dateStr}`, value: f, short: f };
      }),
    });
  }

  const filepath = path.join(CONFIG_DIR, chosen);
  const raw = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(raw) as MigrationFile;
}

// ─── Credential Prompts ───────────────────────────────────────────────────────

async function promptForEppoSdkKey(eppoEnvName: string, useSavedKeys = false): Promise<string> {
  const stored = getEppoSdkKeyForEnv(eppoEnvName);

  if (stored && useSavedKeys) {
    console.log(chalk.gray(`  Using saved Eppo SDK key for ${chalk.cyan(eppoEnvName)}.\n`));
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
    validate: (v) => v.trim().length > 0 ? true : 'SDK key cannot be empty',
  });

  saveEppoSdkKeyForEnv(eppoEnvName, key.trim());
  console.log(chalk.gray('  Key saved for future sessions.\n'));
  return key.trim();
}

async function promptForDatadogClientToken(useSavedKeys = false): Promise<string> {
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
    validate: (v) => v.trim().length > 0 ? true : 'Client token cannot be empty',
  });

  saveDatadogClientToken(token.trim());
  console.log(chalk.gray('  Token saved for future sessions.\n'));
  return token.trim();
}

function getDatadogSiteFromConfig(): string {
  return getDatadogSite() ?? 'datadoghq.com';
}

async function promptForDatadogKeys(useSavedKeys = false): Promise<{ apiKey: string; appKey: string }> {
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
    validate: (v) => v.trim().length > 0 ? true : 'API key cannot be empty',
  });
  const appKey = await password({
    message: 'Enter your Datadog Application key:',
    validate: (v) => v.trim().length > 0 ? true : 'Application key cannot be empty',
  });

  saveDatadogKeys(apiKey.trim(), appKey.trim());
  console.log(chalk.gray('  Keys saved for future sessions.\n'));
  return { apiKey: apiKey.trim(), appKey: appKey.trim() };
}

type ApiEnvironment = { id: string; queries: string[] };

async function fetchEnvironmentsFromApi(apiKey: string, appKey: string, site: string): Promise<ApiEnvironment[]> {
  const baseUrl = `https://api.${site}`;
  const resp = await axios.get<{ data: Array<{ id: string; attributes: { queries: string[] } }> }>(
    `${baseUrl}/api/unstable/feature-flags/environments`,
    { headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey } },
  );
  return resp.data.data.map((item) => ({ id: item.id, queries: item.attributes.queries ?? [] }));
}

async function selectDDEnvironment(
  environmentMapping: MigrationEnvironmentMapping[],
  apiKey: string,
  appKey: string,
  site: string,
  flagEnvironment?: string,
): Promise<{ ddEnvName: string; envId: string; eppoEnvName: string }> {
  if (environmentMapping.length === 0) {
    throw new Error('No environment mapping found in migration file. Re-run the migration first.');
  }

  let chosen: MigrationEnvironmentMapping;

  if (flagEnvironment !== undefined) {
    const match = environmentMapping.find((m) => m.datadogEnvName === flagEnvironment);
    if (!match) {
      throw new Error(
        `No environment named "${flagEnvironment}" found in migration file. ` +
        `Available: ${environmentMapping.map((m) => m.datadogEnvName).join(', ')}`
      );
    }
    chosen = match;
    console.log(chalk.gray(`  Using Datadog environment: ${chalk.cyan(chosen.datadogEnvName)}\n`));
  } else if (environmentMapping.length === 1) {
    chosen = environmentMapping[0];
    console.log(chalk.gray(`  Using Datadog environment: ${chalk.cyan(chosen.datadogEnvName)}\n`));
  } else {
    const chosenId = await select<string>({
      message: 'Select the Datadog environment to evaluate against:',
      choices: environmentMapping.map((m) => ({
        name: m.datadogEnvName,
        value: m.datadogEnvId,
      })),
    });
    chosen = environmentMapping.find((m) => m.datadogEnvId === chosenId)!;
  }

  // Fetch the live environment from the API to get its dd_env queries
  const apiEnvs = await fetchEnvironmentsFromApi(apiKey, appKey, site);
  const matched = apiEnvs.find((e) => e.id === chosen.datadogEnvId);

  if (!matched || matched.queries.length === 0) {
    throw new Error(
      `No DD_ENV names found for environment "${chosen.datadogEnvName}" (id: ${chosen.datadogEnvId}). ` +
      'Configure DD_ENV names in Datadog → Feature Flags → Environments → Edit.'
    );
  }

  const envId = chosen.datadogEnvId;
  const eppoEnvName = chosen.sourceEnvName;

  if (matched.queries.length === 1 || flagEnvironment !== undefined) return { ddEnvName: matched.queries[0], envId, eppoEnvName };

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
    feature_flag_environments?: Array<{ environment_id: string; status: 'ENABLED' | 'DISABLED' }>;
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
      { headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey }, params: { limit, offset, is_archived: false } },
    );
    const flags = resp.data.data ?? [];
    for (const f of flags) {
      keys.add(f.attributes.key);
      const envEntry = (f.attributes.feature_flag_environments ?? []).find((e) => e.environment_id === envId);
      if (envEntry !== undefined) enabledByKey.set(f.attributes.key, envEntry.status === 'ENABLED');
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
): Promise<Record<string, DDFlagValue>> {
  const host = buildEndpointHost(site);
  const url = `https://${host}/precompute-assignments?dd_env=${encodeURIComponent(env)}`;
  try {
    const resp = await axios.post(url, {
      data: {
        type: 'precompute-assignments-request',
        attributes: {
          env: { dd_env: env },
          sdk: { name: 'browser', version: 'dev' },
          subject: { targeting_key: subjectId, targeting_attributes: {} },
        },
      },
    }, {
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'dd-client-token': clientToken,
      },
    });
    return (resp.data?.data?.attributes?.flags ?? {}) as Record<string, DDFlagValue>;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const detail = JSON.stringify(err.response.data);
      throw new Error(`HTTP ${err.response.status} from ${url}\n  ${detail}`);
    }
    throw err;
  }
}

// ─── SDK Initialization ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initializeEppo(eppoSdkKey: string): Promise<any> {
  // Suppress pino logs from the Eppo SDK (level:30 info, level:40 warn)
  process.env.LOG_LEVEL = 'silent';
  const { init, getInstance } = await import('@eppo/node-server-sdk') as { init: any; getInstance: any };
  await init({
    apiKey: eppoSdkKey,
    throwOnFailedInitialization: true,
    numInitialRequestRetries: 0,
    pollAfterSuccessfulInitialization: false,
    pollAfterFailedInitialization: false,
  });
  return getInstance();
}

// ─── Flag Evaluation ──────────────────────────────────────────────────────────

type DDStatus = 'assigned' | 'not-assigned' | 'not-in-dd';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evaluateFlag(flag: EppoFlag, subjectId: string, eppoClient: any, ddFlags: Record<string, DDFlagValue>, ddFlagKeys: Set<string>): Promise<{ eppoResult: string; ddResult: string; ddStatus: DDStatus; error?: string }> {
  const vtype = (flag.variation_type ?? 'STRING').toUpperCase();
  const ddFlag = ddFlags[flag.key];
  const ddStatus: DDStatus = ddFlag !== undefined ? 'assigned'
    : ddFlagKeys.has(flag.key) ? 'not-assigned'
    : 'not-in-dd';

  try {
    let eppoResult: string;
    let ddResult: string;

    switch (vtype) {
      case 'BOOLEAN': {
        const eppo = eppoClient.getBoolAssignment(flag.key, subjectId, {}, false) as boolean;
        eppoResult = String(eppo);
        ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
        break;
      }
      case 'INTEGER': {
        const eppo = eppoClient.getIntegerAssignment(flag.key, subjectId, {}, 0) as number;
        eppoResult = String(eppo);
        ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
        break;
      }
      case 'NUMERIC': {
        const eppo = eppoClient.getNumericAssignment(flag.key, subjectId, {}, 0) as number;
        eppoResult = String(eppo);
        ddResult = ddFlag !== undefined ? String(ddFlag.variationValue) : '';
        break;
      }
      case 'JSON': {
        const eppo = eppoClient.getJSONAssignment(flag.key, subjectId, {}, {}) as object;
        eppoResult = JSON.stringify(eppo);
        ddResult = ddFlag !== undefined ? JSON.stringify(ddFlag.variationValue) : '';
        break;
      }
      default: {
        const eppo = eppoClient.getStringAssignment(flag.key, subjectId, {}, 'control') as string;
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

interface TableRow {
  key: string;
  eppo: string;
  dd: string;
  match: boolean;
  ddStatus: DDStatus;
  error?: string;
  migrationStatus: MigrationStatus;
  ddEnabled: boolean | null;
  partialDetails: string[];
}

function renderTable(rows: TableRow[], providerLabel: string): void {
  const COL1 = 32;
  const COL2 = 18;
  const COL3 = 12;
  const COL4 = 10;
  const COL5 = 44;

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len - 1) + '…' : s.padEnd(len);

  const divider = chalk.gray(
    '─'.repeat(COL1) + '─┼─' + '─'.repeat(COL2) + '─┼─' + '─'.repeat(COL2) + '─┼─' + '─'.repeat(COL3) + '─┼─' + '─'.repeat(COL4) + '─┼─' + '─'.repeat(COL5)
  );
  const header =
    chalk.bold(truncate('Flag Key', COL1)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate(`${providerLabel} Evaluation`, COL2)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate('Datadog Evaluation', COL2)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate('Migration', COL3)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate('Enabled', COL4)) +
    chalk.gray(' │ ') +
    chalk.bold('Skipped');

  console.log();
  console.log(header);
  console.log(divider);

  const migrationCol = (status: MigrationStatus) => {
    switch (status) {
      case 'created': return chalk.green('✓ Created'.padEnd(COL3));
      case 'partial': return chalk.yellow('⚠ Partial'.padEnd(COL3));
      case 'failed':  return chalk.red('✗ Failed'.padEnd(COL3));
      case 'skipped': return chalk.gray('— Skipped'.padEnd(COL3));
      default:        return chalk.gray('—'.padEnd(COL3));
    }
  };

  const enabledCol = (enabled: boolean | null) => {
    if (enabled === null) return chalk.gray('—'.padEnd(COL4));
    return enabled ? chalk.green('✓ Enabled'.padEnd(COL4)) : chalk.gray('✗ Disabled'.padEnd(COL4));
  };

  const skippedCol = (details: string[]) => {
    if (details.length === 0) return chalk.gray('—');
    return chalk.yellow(details.join(' | '));
  };

  for (const row of rows) {
    const key = truncate(row.key, COL1);
    const sep = chalk.gray(' │ ');
    const mig = migrationCol(row.migrationStatus);
    const ena = enabledCol(row.ddEnabled);
    const skp = skippedCol(row.partialDetails);

    if (row.error) {
      const ddDisplay = row.ddStatus === 'assigned'
        ? chalk.dim(truncate(row.dd, COL2))
        : chalk.dim('—'.padEnd(COL2));
      console.log(key + sep + chalk.red(truncate('ERROR', COL2)) + sep + ddDisplay + sep + mig + sep + ena + sep + skp);
    } else if (row.ddStatus === 'not-in-dd') {
      console.log(chalk.dim(key) + sep + chalk.dim(truncate(row.eppo, COL2)) + sep + chalk.dim('—'.padEnd(COL2)) + sep + mig + sep + ena + sep + skp);
    } else if (row.ddStatus === 'not-assigned') {
      console.log(chalk.dim(key) + sep + chalk.dim(truncate(row.eppo, COL2)) + sep + chalk.dim('—'.padEnd(COL2)) + sep + mig + sep + ena + sep + skp);
    } else if (row.match) {
      console.log(key + sep + chalk.green(truncate(row.eppo, COL2)) + sep + chalk.green(truncate(row.dd, COL2)) + sep + mig + sep + ena + sep + skp);
    } else {
      console.log(key + sep + chalk.yellow(truncate(row.eppo, COL2)) + sep + chalk.yellow(truncate(row.dd, COL2)) + sep + mig + sep + ena + sep + skp);
    }
  }

  console.log();
  console.log(chalk.gray('  Migration:'));
  console.log('  • ' + chalk.green('✓ Created') + chalk.gray(' — flag was successfully created during migration'));
  console.log('  • ' + chalk.yellow('⚠ Partial') + chalk.gray(' — flag was created but could not be enabled in some environments'));
  console.log('  • ' + chalk.red('✗ Failed') + chalk.gray(' — flag creation itself failed'));
  console.log('  • ' + chalk.gray('— Skipped') + chalk.gray(' — flag type is not supported (BANDIT, LAYER)'));
  console.log();
}

function printSummary(rows: TableRow[]): void {
  const matched = rows.filter((r) => r.match).length;
  const differed = rows.filter((r) => !r.match && !r.error && r.ddStatus === 'assigned').length;
  const notAssigned = rows.filter((r) => r.ddStatus === 'not-assigned').length;
  const notInDD = rows.filter((r) => r.ddStatus === 'not-in-dd').length;
  const errored = rows.filter((r) => Boolean(r.error)).length;

  console.log(chalk.bold('Summary:'));
  let summary = `  ${chalk.green(String(matched))} match  ${chalk.yellow(String(differed))} differ  ${chalk.red(String(errored))} error`;
  if (notAssigned > 0) summary += `  ${chalk.dim(String(notAssigned))} not assigned`;
  if (notInDD > 0) summary += `  ${chalk.red(String(notInDD))} not in Datadog`;
  console.log(summary);
  console.log();

  if (differed > 0) {
    console.log(chalk.yellow(
      '  Some flags returned different values. This may be expected if\n' +
      '  flag configurations differ between providers.'
    ));
    console.log();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { useSavedKeys, testSubjectId, useLatestMigration, flagEnvironment } = parseArgs();
  printHeader();

  // 1. Select migration file
  const migration = await selectMigrationFile(useLatestMigration);
  const providerLabel = migration.provider === 'eppo' ? 'Eppo'
    : migration.provider.charAt(0).toUpperCase() + migration.provider.slice(1);

  console.log(chalk.bold('Migrated from: ') + chalk.green(providerLabel));
  console.log(chalk.gray(`  Migrated at:  ${new Date(migration.migratedAt).toLocaleString()}`));
  console.log(chalk.gray(`  Flags:        ${migration.flags.length}`));
  console.log();

  // 2. Collect Datadog credentials
  const { apiKey: ddApiKey, appKey: ddAppKey } = await promptForDatadogKeys(useSavedKeys);
  const ddClientToken = await promptForDatadogClientToken(useSavedKeys);
  const ddSite = getDatadogSiteFromConfig();

  // 3. Select Datadog environment (resolved via API)
  const { ddEnvName: ddEnv, envId: ddEnvId, eppoEnvName } = await selectDDEnvironment(migration.environmentMapping ?? [], ddApiKey, ddAppKey, ddSite, flagEnvironment);
  console.log();

  // 4a. Collect Eppo SDK key for this specific environment
  const eppoSdkKey = await promptForEppoSdkKey(eppoEnvName, useSavedKeys);
  console.log();

  // 4b. Prompt for test subject ID
  let subjectId: string;
  if (testSubjectId !== undefined) {
    console.log(chalk.gray(`  Using test subject ID: ${chalk.cyan(testSubjectId)}\n`));
    subjectId = testSubjectId;
  } else {
    subjectId = await input({
      message: 'Enter a test subject ID (user ID for flag evaluation):',
      validate: (v) => v.trim().length > 0 ? true : 'Subject ID cannot be empty',
    });
    console.log();
  }

  // 5. Initialize Eppo SDK (non-fatal — errors surface in the table)
  const initSpinner = ora('Initializing Eppo SDK…').start();
  let eppoClient: unknown = null;
  let eppoInitError: string | undefined;

  try {
    eppoClient = await initializeEppo(eppoSdkKey);
    initSpinner.succeed('Eppo SDK initialized');
  } catch (err) {
    eppoInitError = err instanceof Error ? err.message : String(err);
    initSpinner.fail(`Eppo SDK initialization failed: ${chalk.red(eppoInitError)}`);
  }

  // 6. Fetch Datadog data (flag assignments + full flag list) in parallel
  const ddSpinner = ora('Fetching Datadog flag data…').start();
  let ddFlags: Record<string, DDFlagValue>;
  let ddFlagKeys: Set<string>;
  let ddEnabledByKey: Map<string, boolean>;

  try {
    const [assignments, flagData] = await Promise.all([
      fetchDDFlags(ddClientToken, ddSite, ddEnv, subjectId.trim()),
      fetchDDFlagData(ddApiKey, ddAppKey, ddSite, ddEnvId),
    ]);
    ddFlags = assignments;
    ddFlagKeys = flagData.keys;
    ddEnabledByKey = flagData.enabledByKey;
    ddSpinner.succeed(`Fetched ${Object.keys(ddFlags).length} assignment(s) across ${ddFlagKeys.size} Datadog flag(s)`);
  } catch (err) {
    ddSpinner.fail('Failed to fetch Datadog flag data');
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // 7. Evaluate each flag
  const evalSpinner = ora(`Evaluating ${migration.flags.length} flag(s)…`).start();
  const rows: TableRow[] = [];

  const failedKeys = new Set((migration.failures ?? []).map((f) => f.key));
  const hasMigrationDetail = migration.failures !== undefined;

  const skippedFlagReason = new Map<string, string>();
  for (const s of migration.skippedFlags ?? []) {
    skippedFlagReason.set(s.key, s.reason);
  }
  const enableFailCountByFlag = new Map<string, number>();
  for (const f of migration.enableFailures ?? []) {
    enableFailCountByFlag.set(f.key, (enableFailCountByFlag.get(f.key) ?? 0) + 1);
  }

  for (const flag of migration.flags) {
    const skipReason = skippedFlagReason.get(flag.key);
    const envFailCount = enableFailCountByFlag.get(flag.key) ?? 0;
    const partialDetails: string[] = [];
    if (skipReason !== undefined) {
      partialDetails.push(skipReason);
    } else if (envFailCount > 0) {
      partialDetails.push(`Could not enable (${envFailCount} env(s))`);
    }

    const migrationStatus: MigrationStatus = skipReason !== undefined ? 'skipped'
      : !hasMigrationDetail ? 'unknown'
      : failedKeys.has(flag.key) ? 'failed'
      : envFailCount > 0 ? 'partial'
      : 'created';
    const ddEnabled = ddEnabledByKey.has(flag.key) ? ddEnabledByKey.get(flag.key)! : null;

    if (eppoInitError) {
      const ddFlag = ddFlags[flag.key];
      const ddStatus: DDStatus = ddFlag !== undefined ? 'assigned'
        : ddFlagKeys.has(flag.key) ? 'not-assigned'
        : 'not-in-dd';
      rows.push({
        key: flag.key,
        eppo: 'ERROR',
        dd: ddFlag !== undefined ? String(ddFlag.variationValue) : '',
        ddStatus,
        match: false,
        error: `Eppo SDK: ${eppoInitError}`,
        migrationStatus,
        ddEnabled,
        partialDetails,
      });
    } else {
      const { eppoResult, ddResult, ddStatus, error } = await evaluateFlag(
        flag, subjectId.trim(), eppoClient, ddFlags, ddFlagKeys
      );
      rows.push({
        key: flag.key,
        eppo: eppoResult,
        dd: ddResult,
        ddStatus,
        match: !error && ddStatus === 'assigned' && eppoResult === ddResult,
        error,
        migrationStatus,
        ddEnabled,
        partialDetails,
      });
    }
  }
  evalSpinner.succeed('Evaluation complete');

  // 8. Render results
  renderTable(rows, providerLabel);
  printSummary(rows);
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.log(chalk.gray('\nBye!'));
    process.exit(0);
  }
  console.error(chalk.red('\nUnexpected error:'), err);
  process.exit(1);
});
