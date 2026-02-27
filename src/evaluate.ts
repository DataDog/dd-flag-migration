#!/usr/bin/env node
import { select, password, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import path from 'node:path';
import fs from 'node:fs';
import {
  CONFIG_DIR,
  getEppoSdkKey,
  saveEppoSdkKey,
  getDatadogKeys,
  saveDatadogKeys,
  getDatadogClientToken,
  saveDatadogClientToken,
  getDatadogSite,
  saveDatadogSite,
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

// ─── Migration File Selection ─────────────────────────────────────────────────

async function selectMigrationFile(): Promise<MigrationFile> {
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

  if (files.length === 1) {
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

async function promptForEppoSdkKey(): Promise<string> {
  const stored = getEppoSdkKey();

  if (stored) {
    const useStored = await confirm({
      message: 'Use your saved Eppo SDK key?',
      default: true,
    });
    if (useStored) return stored;
  }

  const key = await password({
    message: 'Enter your Eppo SDK key (client/server SDK key, not the Admin API key):',
    validate: (v) => v.trim().length > 0 ? true : 'SDK key cannot be empty',
  });

  saveEppoSdkKey(key.trim());
  console.log(chalk.gray('  Key saved for future sessions.\n'));
  return key.trim();
}

async function promptForDatadogClientToken(): Promise<string> {
  const stored = getDatadogClientToken();

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

async function promptForDatadogSite(): Promise<string> {
  const stored = getDatadogSite();

  if (stored) {
    const useStored = await confirm({
      message: `Use your saved Datadog site (${stored})?`,
      default: true,
    });
    if (useStored) return stored;
  }

  const site = await select<string>({
    message: 'Select your Datadog site:',
    choices: [
      { name: 'datadoghq.com (US1)', value: 'datadoghq.com' },
      { name: 'us3.datadoghq.com (US3)', value: 'us3.datadoghq.com' },
      { name: 'datadoghq.eu (EU)', value: 'datadoghq.eu' },
      { name: 'datad0g.com (Staging)', value: 'datad0g.com' },
    ],
    default: 'datadoghq.com',
  });

  saveDatadogSite(site);
  console.log(chalk.gray('  Site saved for future sessions.\n'));
  return site;
}

async function promptForDatadogKeys(): Promise<{ apiKey: string; appKey: string }> {
  const stored = getDatadogKeys();

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
): Promise<{ ddEnvName: string; envId: string }> {
  if (environmentMapping.length === 0) {
    throw new Error('No environment mapping found in migration file. Re-run the migration first.');
  }

  let chosen: MigrationEnvironmentMapping;

  if (environmentMapping.length === 1) {
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

  if (matched.queries.length === 1) return { ddEnvName: matched.queries[0], envId };

  const ddEnvName = await select<string>({
    message: `Select a DD_ENV for "${chosen.datadogEnvName}":`,
    choices: matched.queries.map((q) => ({ name: q, value: q })),
  });
  return { ddEnvName, envId };
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
  await init({ apiKey: eppoSdkKey, throwOnFailedInitialization: false });
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

type MigrationStatus = 'created' | 'partial' | 'failed' | 'unknown';

interface TableRow {
  key: string;
  eppo: string;
  dd: string;
  match: boolean;
  ddStatus: DDStatus;
  error?: string;
  migrationStatus: MigrationStatus;
  ddEnabled: boolean | null;
}

function renderTable(rows: TableRow[], providerLabel: string): void {
  const COL1 = 32;
  const COL2 = 18;
  const COL3 = 12;
  const COL4 = 10;

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len - 1) + '…' : s.padEnd(len);

  const divider = chalk.gray(
    '─'.repeat(COL1) + '─┼─' + '─'.repeat(COL2) + '─┼─' + '─'.repeat(COL2) + '─┼─' + '─'.repeat(COL3) + '─┼─' + '─'.repeat(COL4)
  );
  const header =
    chalk.bold(truncate('Flag Key', COL1)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate(providerLabel, COL2)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate('Datadog Flags', COL2)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate('Migration', COL3)) +
    chalk.gray(' │ ') +
    chalk.bold('Enabled');

  console.log();
  console.log(header);
  console.log(divider);

  const migrationCol = (status: MigrationStatus) => {
    switch (status) {
      case 'created': return chalk.green('✓ Created'.padEnd(COL3));
      case 'partial': return chalk.yellow('⚠ Partial'.padEnd(COL3));
      case 'failed':  return chalk.red('✗ Failed'.padEnd(COL3));
      default:        return chalk.gray('—'.padEnd(COL3));
    }
  };

  const enabledCol = (enabled: boolean | null) => {
    if (enabled === null) return chalk.gray('—'.padEnd(COL4));
    return enabled ? chalk.green('✓ Enabled'.padEnd(COL4)) : chalk.gray('✗ Disabled'.padEnd(COL4));
  };

  for (const row of rows) {
    const key = truncate(row.key, COL1);
    const sep = chalk.gray(' │ ');
    const mig = migrationCol(row.migrationStatus);
    const ena = enabledCol(row.ddEnabled);

    if (row.error) {
      console.log(key + sep + chalk.red(truncate('ERROR', COL2)) + sep + chalk.red(truncate('ERROR', COL2)) + sep + mig + sep + ena);
    } else if (row.ddStatus === 'not-in-dd') {
      console.log(chalk.dim(key) + sep + chalk.dim(truncate(row.eppo, COL2)) + sep + chalk.dim('—'.padEnd(COL2)) + sep + mig + sep + ena);
    } else if (row.ddStatus === 'not-assigned') {
      console.log(chalk.dim(key) + sep + chalk.dim(truncate(row.eppo, COL2)) + sep + chalk.dim('—'.padEnd(COL2)) + sep + mig + sep + ena);
    } else if (row.match) {
      console.log(key + sep + chalk.green(truncate(row.eppo, COL2)) + sep + chalk.green(truncate(row.dd, COL2)) + sep + mig + sep + ena);
    } else {
      console.log(key + sep + chalk.yellow(truncate(row.eppo, COL2)) + sep + chalk.yellow(truncate(row.dd, COL2)) + sep + mig + sep + ena);
    }
  }

  console.log();
  console.log(chalk.gray('  Migration:'));
  console.log('  • ' + chalk.green('✓ Created') + chalk.gray(' — flag was successfully created during migration'));
  console.log('  • ' + chalk.yellow('⚠ Partial') + chalk.gray(' — flag was created but failed to enable in one or more environments'));
  console.log('  • ' + chalk.red('✗ Failed') + chalk.gray(' — flag creation itself failed'));
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
  printHeader();

  // 1. Select migration file
  const migration = await selectMigrationFile();
  const providerLabel = migration.provider === 'eppo' ? 'Eppo'
    : migration.provider.charAt(0).toUpperCase() + migration.provider.slice(1);

  console.log(chalk.bold('Migrated from: ') + chalk.green(providerLabel));
  console.log(chalk.gray(`  Migrated at:  ${new Date(migration.migratedAt).toLocaleString()}`));
  console.log(chalk.gray(`  Flags:        ${migration.flags.length}`));
  console.log();

  // 2. Collect credentials
  const eppoSdkKey = await promptForEppoSdkKey();
  console.log();
  const { apiKey: ddApiKey, appKey: ddAppKey } = await promptForDatadogKeys();
  const ddClientToken = await promptForDatadogClientToken();
  const ddSite = await promptForDatadogSite();

  // 3. Select Datadog environment (resolved via API)
  const { ddEnvName: ddEnv, envId: ddEnvId } = await selectDDEnvironment(migration.environmentMapping ?? [], ddApiKey, ddAppKey, ddSite);
  console.log();

  // 4. Prompt for test subject ID
  const subjectId = await input({
    message: 'Enter a test subject ID (user ID for flag evaluation):',
    validate: (v) => v.trim().length > 0 ? true : 'Subject ID cannot be empty',
  });
  console.log();

  // 5. Initialize Eppo SDK
  const initSpinner = ora('Initializing Eppo SDK…').start();
  let eppoClient: unknown;

  try {
    eppoClient = await initializeEppo(eppoSdkKey);
    initSpinner.succeed('Eppo SDK initialized');
  } catch (err) {
    initSpinner.fail('Failed to initialize Eppo SDK');
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
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
  const partialKeys = new Set((migration.enableFailures ?? []).map((f) => f.key));
  const hasMigrationDetail = migration.failures !== undefined;

  for (const flag of migration.flags) {
    const { eppoResult, ddResult, ddStatus, error } = await evaluateFlag(
      flag, subjectId.trim(), eppoClient, ddFlags, ddFlagKeys
    );
    const migrationStatus: MigrationStatus = !hasMigrationDetail ? 'unknown'
      : failedKeys.has(flag.key) ? 'failed'
      : partialKeys.has(flag.key) ? 'partial'
      : 'created';
    const ddEnabled = ddEnabledByKey.has(flag.key) ? ddEnabledByKey.get(flag.key)! : null;
    rows.push({
      key: flag.key,
      eppo: eppoResult,
      dd: ddResult,
      ddStatus,
      match: !error && ddStatus === 'assigned' && eppoResult === ddResult,
      error,
      migrationStatus,
      ddEnabled,
    });
  }
  evalSpinner.succeed('Evaluation complete');

  // 8. Render results
  renderTable(rows, providerLabel);
  printSummary(rows);
  process.exit(0);
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.log(chalk.gray('\nBye!'));
    process.exit(0);
  }
  console.error(chalk.red('\nUnexpected error:'), err);
  process.exit(1);
});
