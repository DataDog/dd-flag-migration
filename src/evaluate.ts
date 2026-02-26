#!/usr/bin/env node
import { select, password, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import fs from 'node:fs';
import {
  CONFIG_DIR,
  getEppoSdkKey,
  saveEppoSdkKey,
  getDatadogKeys,
  saveDatadogKeys,
} from './config.js';
import type { MigrationFile, EppoFlag } from './types.js';

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
    console.log(chalk.gray(`  Run 'yarn dev' to perform a migration first.\n`));
    process.exit(1);
  }

  const files = fs.readdirSync(CONFIG_DIR)
    .filter((f) => f.startsWith('migration-') && f.endsWith('.json'))
    .sort()
    .reverse(); // newest-first (ISO timestamps sort lexicographically)

  if (files.length === 0) {
    console.log(chalk.red('\n  No migration files found.'));
    console.log(chalk.gray(`  Run 'yarn dev' to perform a migration first.\n`));
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

async function promptForDatadogKeys(): Promise<{ apiKey: string; appKey: string }> {
  const stored = getDatadogKeys();

  if (stored.apiKey && stored.appKey) {
    const useStored = await confirm({
      message: 'Use your saved Datadog API keys?',
      default: true,
    });
    if (useStored) return { apiKey: stored.apiKey, appKey: stored.appKey };
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
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
}

// ─── SDK Initialization ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initializeSdks(ddApiKey: string, ddAppKey: string, eppoSdkKey: string): Promise<{ eppoClient: any; ddClient: any }> {
  // Set env vars BEFORE dynamically importing tracer (tracer reads them at init time)
  process.env.DD_API_KEY = ddApiKey;
  process.env.DD_APP_KEY = ddAppKey;

  // Dynamic imports ensure correct initialization ordering
  const { default: tracer } = await import('dd-trace') as { default: any };
  tracer.init({
    remoteConfig: { pollInterval: 5 },
    experimental: {
      flaggingProvider: { enabled: true },
    },
  });

  const { OpenFeature } = await import('@openfeature/server-sdk') as { OpenFeature: any };
  OpenFeature.setProvider(tracer.openfeature);
  const ddClient = OpenFeature.getClient();

  const { init, getInstance } = await import('@eppo/node-server-sdk') as { init: any; getInstance: any };
  await init({ apiKey: eppoSdkKey, throwOnFailedInitialization: false });
  const eppoClient = getInstance();

  return { eppoClient, ddClient };
}

// ─── Flag Evaluation ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evaluateFlag(flag: EppoFlag, subjectId: string, eppoClient: any, ddClient: any): Promise<{ eppoResult: string; ddResult: string; error?: string }> {
  const vtype = (flag.variation_type ?? 'STRING').toUpperCase();

  try {
    let eppoResult: string;
    let ddResult: string;

    switch (vtype) {
      case 'BOOLEAN': {
        const eppo = eppoClient.getBoolAssignment(flag.key, subjectId, {}, false) as boolean;
        const dd = await ddClient.getBooleanValue(flag.key, false, { targetingKey: subjectId }) as boolean;
        eppoResult = String(eppo);
        ddResult = String(dd);
        break;
      }
      case 'INTEGER': {
        const eppo = eppoClient.getIntegerAssignment(flag.key, subjectId, {}, 0) as number;
        const dd = await ddClient.getNumberValue(flag.key, 0, { targetingKey: subjectId }) as number;
        eppoResult = String(eppo);
        ddResult = String(dd);
        break;
      }
      case 'NUMERIC': {
        const eppo = eppoClient.getNumericAssignment(flag.key, subjectId, {}, 0) as number;
        const dd = await ddClient.getNumberValue(flag.key, 0, { targetingKey: subjectId }) as number;
        eppoResult = String(eppo);
        ddResult = String(dd);
        break;
      }
      case 'JSON': {
        const eppo = eppoClient.getJSONAssignment(flag.key, subjectId, {}, {}) as object;
        const dd = await ddClient.getObjectValue(flag.key, {}, { targetingKey: subjectId }) as object;
        eppoResult = JSON.stringify(eppo);
        ddResult = JSON.stringify(dd);
        break;
      }
      default: {
        const eppo = eppoClient.getStringAssignment(flag.key, subjectId, {}, 'control') as string;
        const dd = await ddClient.getStringValue(flag.key, 'control', { targetingKey: subjectId }) as string;
        eppoResult = String(eppo);
        ddResult = String(dd);
        break;
      }
    }

    return { eppoResult, ddResult };
  } catch (err) {
    return {
      eppoResult: 'ERROR',
      ddResult: 'ERROR',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Table Rendering ──────────────────────────────────────────────────────────

interface TableRow {
  key: string;
  eppo: string;
  dd: string;
  match: boolean;
  error?: string;
}

function renderTable(rows: TableRow[], providerLabel: string): void {
  const COL1 = 32;
  const COL2 = 18;

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len - 1) + '…' : s.padEnd(len);

  const divider = chalk.gray('─'.repeat(COL1) + '─┼─' + '─'.repeat(COL2) + '─┼─' + '─'.repeat(COL2 + 2));
  const header =
    chalk.bold(truncate('Flag Key', COL1)) +
    chalk.gray(' │ ') +
    chalk.bold(truncate(providerLabel, COL2)) +
    chalk.gray(' │ ') +
    chalk.bold('Datadog Flags');

  console.log();
  console.log(header);
  console.log(divider);

  for (const row of rows) {
    const key = truncate(row.key, COL1);

    if (row.error) {
      console.log(
        key +
        chalk.gray(' │ ') +
        chalk.red(truncate('ERROR', COL2)) +
        chalk.gray(' │ ') +
        chalk.red(truncate('ERROR', COL2)) +
        '  ' + chalk.red('ERROR')
      );
    } else if (row.match) {
      console.log(
        key +
        chalk.gray(' │ ') +
        chalk.green(truncate(row.eppo, COL2)) +
        chalk.gray(' │ ') +
        chalk.green(truncate(row.dd, COL2)) +
        '  ' + chalk.green('✓')
      );
    } else {
      console.log(
        key +
        chalk.gray(' │ ') +
        chalk.yellow(truncate(row.eppo, COL2)) +
        chalk.gray(' │ ') +
        chalk.yellow(truncate(row.dd, COL2)) +
        '  ' + chalk.yellow('✗')
      );
    }
  }

  console.log();
}

function printSummary(rows: TableRow[]): void {
  const matched = rows.filter((r) => r.match && !r.error).length;
  const differed = rows.filter((r) => !r.match && !r.error).length;
  const errored = rows.filter((r) => Boolean(r.error)).length;

  console.log(chalk.bold('Summary:'));
  console.log(
    `  ${chalk.green(String(matched))} match  ` +
    `${chalk.yellow(String(differed))} differ  ` +
    `${chalk.red(String(errored))} error`
  );
  console.log();

  if (differed > 0) {
    console.log(chalk.yellow(
      '  Some flags returned different values. This may be expected if remote\n' +
      '  config has not yet propagated or flag configurations differ between providers.'
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

  // 3. Prompt for test subject ID
  const subjectId = await input({
    message: 'Enter a test subject ID (user ID for flag evaluation):',
    validate: (v) => v.trim().length > 0 ? true : 'Subject ID cannot be empty',
  });
  console.log();

  // 4. Initialize SDKs
  const initSpinner = ora('Initializing Eppo and Datadog SDKs…').start();
  let eppoClient: unknown;
  let ddClient: unknown;

  try {
    ({ eppoClient, ddClient } = await initializeSdks(ddApiKey, ddAppKey, eppoSdkKey));
    initSpinner.succeed('SDKs initialized');
  } catch (err) {
    initSpinner.fail('Failed to initialize SDKs');
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // 5. Wait for remote config to propagate
  const waitSpinner = ora('Waiting for Datadog remote config to load…').start();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  waitSpinner.succeed('Remote config ready');

  // 6. Evaluate each flag
  const evalSpinner = ora(`Evaluating ${migration.flags.length} flag(s)…`).start();
  const rows: TableRow[] = [];

  for (const flag of migration.flags) {
    const { eppoResult, ddResult, error } = await evaluateFlag(
      flag, subjectId.trim(), eppoClient, ddClient
    );
    rows.push({
      key: flag.key,
      eppo: eppoResult,
      dd: ddResult,
      match: !error && eppoResult === ddResult,
      error,
    });
  }
  evalSpinner.succeed('Evaluation complete');

  // 7. Render results
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
