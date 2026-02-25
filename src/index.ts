#!/usr/bin/env node
import { select, password, confirm } from '@inquirer/prompts';
import { filterableCheckbox } from './filterable-checkbox.js';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { getEppoApiKey, saveEppoApiKey, getDatadogKeys, saveDatadogKeys } from './config.js';
import { fetchEppoFlags, validateEppoApiKey, extractEnvironments } from './eppo.js';
import { fetchDatadogFlagKeys, fetchDatadogEnvironments, validateDatadogKeys, createFeatureFlag } from './datadog.js';
import type { EppoFlag, EppoFlagEnvironment, DatadogEnvironment, DatadogCreateFlagRequest, DatadogAllocationForFlagCreation } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { name: 'Eppo', value: 'eppo' },
  { name: chalk.dim('LaunchDarkly') + chalk.yellow('  (Coming Soon!)'), value: 'launchdarkly', short: 'LaunchDarkly' },
  { name: chalk.dim('Statsig') + chalk.yellow('  (Coming Soon!)'), value: 'statsig', short: 'Statsig' },
] as const;

type ProviderValue = (typeof PROVIDERS)[number]['value'];

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function printHeader(): void {
  const purple = chalk.bold.hex('#632CA6');
  console.log();
  console.log(purple('╔══════════════════════════════════════════╗'));
  console.log(purple('║') + chalk.bold.white('   🚩  Feature Flag Migration Tool  🚩    ') + purple('║'));
  console.log(purple('║') + chalk.hex('#632CA6')('            Migrate to Datadog            ') + purple('║'));
  console.log(purple('╚══════════════════════════════════════════╝'));
  console.log();
}

function ddEnvLabel(env: DatadogEnvironment): string {
  const prodBadge = env.is_production ? '  ' + chalk.bgHex('#632CA6').white(' Prod ') : '';
  return `${env.name}${prodBadge}`;
}

function envLabel(env: EppoFlagEnvironment, flagCount: number): string {
  const prodBadge = env.is_production ? '  ' + chalk.bgRed.white(' Prod ') : '';
  return `${env.name}${prodBadge}  ${chalk.gray(`(${flagCount} flags)`)}`;
}

function flagLabel(flag: EppoFlag, inDatadog: boolean): string {
  const indicator = inDatadog ? chalk.green('✓') : ' ';
  const name = flag.name;
  const key = chalk.gray(`(${flag.key})`);
  const badge = inDatadog ? '  ' + chalk.bgGreen.black(' In Datadog ') : '';
  return `${indicator}  ${name}  ${key}${badge}`;
}

// ─── Prompt Steps ─────────────────────────────────────────────────────────────

async function selectProvider(): Promise<ProviderValue> {
  return select<ProviderValue>({
    message: 'Which feature flagging solution are you migrating from?',
    choices: PROVIDERS.map((p) => ({ name: p.name, value: p.value, short: 'short' in p ? p.short : p.name })),
  });
}

async function promptForApiKey(): Promise<string> {
  const storedKey = getEppoApiKey();

  if (storedKey) {
    const useStored = await confirm({
      message: 'Use your saved Eppo API key?',
      default: true,
    });
    if (useStored) return storedKey;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const apiKey = await password({
      message: 'Enter your Eppo API key:',
      validate: (input) => (input.trim().length > 0 ? true : 'API key cannot be empty'),
    });

    const spinner = ora('Validating API key…').start();
    const valid = await validateEppoApiKey(apiKey.trim());

    if (valid) {
      spinner.succeed('API key validated!');
      saveEppoApiKey(apiKey.trim());
      console.log(chalk.gray('  Key saved for future sessions.\n'));
      return apiKey.trim();
    } else {
      spinner.fail(chalk.red('Invalid API key. Please try again.'));
    }
  }
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
      validate: (input) => (input.trim().length > 0 ? true : 'API key cannot be empty'),
    });
    const appKey = await password({
      message: 'Enter your Datadog Application key:',
      validate: (input) => (input.trim().length > 0 ? true : 'Application key cannot be empty'),
    });

    const spinner = ora('Validating Datadog keys…').start();
    const valid = await validateDatadogKeys(apiKey.trim(), appKey.trim());

    if (valid) {
      spinner.succeed('Datadog keys validated!');
      saveDatadogKeys(apiKey.trim(), appKey.trim());
      console.log(chalk.gray('  Keys saved for future sessions.\n'));
      return { apiKey: apiKey.trim(), appKey: appKey.trim() };
    } else {
      spinner.fail(chalk.red('Invalid Datadog API keys. Please try again.'));
    }
  }
}

async function linkEnvironments(
  eppoEnvs: EppoFlagEnvironment[],
  ddEnvs: DatadogEnvironment[],
  previousMapping: Map<number, DatadogEnvironment>
): Promise<Map<number, DatadogEnvironment> | null> {
  const mapping = new Map<number, DatadogEnvironment>(previousMapping);
  let i = 0;

  while (i < eppoEnvs.length) {
    const eppoEnv = eppoEnvs[i];
    const prevChoice = mapping.get(eppoEnv.id);

    console.log();
    console.log(
      chalk.bold('Linking environment ') +
      chalk.green(`${i + 1}`) +
      chalk.bold(' of ') +
      chalk.green(`${eppoEnvs.length}`) +
      chalk.bold(':') +
      `  ${chalk.cyan(eppoEnv.name)}` +
      (eppoEnv.is_production ? '  ' + chalk.bgRed.white(' Prod ') : '')
    );
    console.log();

    type LinkChoice = DatadogEnvironment | null;

    const result = await select<LinkChoice>({
      message: 'Select the matching Datadog environment:',
      choices: [
        { name: chalk.dim('← Back'), value: null, short: 'Back' },
        ...ddEnvs.map((env) => ({ name: ddEnvLabel(env), value: env as LinkChoice, short: env.name })),
      ],
      default: prevChoice,
    });

    if (result === null) {
      if (i === 0) return null; // back to Eppo env selection
      i--;
    } else {
      mapping.set(eppoEnv.id, result);
      i++;
    }
  }

  return mapping;
}

async function selectEnvironments(
  flags: EppoFlag[],
  environments: EppoFlagEnvironment[],
  previouslySelected: EppoFlagEnvironment[] = []
): Promise<EppoFlagEnvironment[] | null> {
  const flagCount = new Map<number, number>();
  for (const flag of flags) {
    for (const env of flag.environments ?? []) {
      flagCount.set(env.id, (flagCount.get(env.id) ?? 0) + 1);
    }
  }

  const previousIds = new Set(previouslySelected.map((e) => e.id));

  console.log();
  console.log(chalk.bold(`Found ${chalk.green(String(environments.length))} environments in Eppo`));
  console.log();

  const pageSize = Math.max(3, Math.min(environments.length, (process.stdout.rows ?? 24) - 9));

  return filterableCheckbox<EppoFlagEnvironment>({
    message: 'Select environments to migrate from:',
    choices: environments.map((env) => ({
      name: envLabel(env, flagCount.get(env.id) ?? 0),
      value: env,
      checked: previousIds.has(env.id),
    })),
    pageSize,
  });
}

async function selectFlags(
  flags: EppoFlag[],
  datadogKeys: Set<string>,
  selectedEnvs: EppoFlagEnvironment[],
  previouslySelected: EppoFlag[] = []
): Promise<EppoFlag[] | null> {
  const selectedEnvIds = new Set(selectedEnvs.map((e) => e.id));
  const visibleFlags = selectedEnvIds.size > 0
    ? flags.filter((f) => f.environments?.some((e) => selectedEnvIds.has(e.id)))
    : flags;

  const inDatadogCount = visibleFlags.filter((f) => datadogKeys.has(f.key)).length;
  const previousKeys = new Set(previouslySelected.map((f) => f.key));

  console.log();
  console.log(chalk.bold(`Found ${chalk.green(String(visibleFlags.length))} feature flags in Eppo`));
  if (inDatadogCount > 0) {
    console.log(
      chalk.gray(`  ${inDatadogCount} flag(s) already exist in Datadog `) + chalk.green('✓')
    );
  }
  console.log();

  const sortedFlags = visibleFlags.slice().sort((a, b) => {
    // Flags already in Datadog float to the top
    const aDD = datadogKeys.has(a.key) ? 0 : 1;
    const bDD = datadogKeys.has(b.key) ? 0 : 1;
    if (aDD !== bDD) return aDD - bDD;
    return a.name.localeCompare(b.name);
  });

  // Reserve lines for: found header (~3), prompt message, filter line, help tip, buffer
  const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

  return filterableCheckbox<EppoFlag>({
    message: 'Select flags to migrate to Datadog:',
    choices: sortedFlags.map((flag) => ({
      name: flagLabel(flag, datadogKeys.has(flag.key)),
      value: flag,
      checked: previousKeys.has(flag.key),
    })),
    pageSize,
  });
}

type ConfirmAction = 'migrate' | 'select-more' | 'cancel';

async function confirmMigration(
  flags: EppoFlag[],
  ddApiKey: string,
  ddAppKey: string,
  envMapping: Map<number, DatadogEnvironment>,
  datadogKeys: Set<string>
): Promise<ConfirmAction> {
  if (flags.length === 0) {
    console.log(chalk.yellow('\nNo flags selected — nothing to migrate.'));
    const action = await select<'select-more' | 'cancel'>({
      message: 'What would you like to do?',
      choices: [
        { name: 'Select flags', value: 'select-more' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });
    return action;
  }

  console.log();
  console.log(chalk.bold(`You selected ${chalk.green(String(flags.length))} flag(s):`));
  flags.forEach((f) => {
    console.log(chalk.gray(`  •  ${f.name}`) + chalk.dim(`  (${f.key})`));
  });
  console.log();

  const action = await select<ConfirmAction>({
    message: dryRun ? `Simulate migration of ${flags.length} flag(s)?` : `Migrate ${flags.length} flag(s) to Datadog?`,
    choices: [
      { name: dryRun ? `Simulate ${flags.length} flag(s)` : `Migrate ${flags.length} flag(s)`, value: 'migrate' },
      { name: 'Select more flags', value: 'select-more' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });

  if (action === 'cancel') {
    console.log(chalk.yellow('\nMigration cancelled.'));
    return 'cancel';
  }

  if (action === 'select-more') {
    return 'select-more';
  }

  // Map Eppo variation_type → Datadog value_type
  function mapVariationType(eppoType: string): DatadogCreateFlagRequest['value_type'] {
    switch (eppoType.toUpperCase()) {
      case 'BOOLEAN': return 'BOOLEAN';
      case 'INTEGER': return 'INTEGER';
      case 'NUMERIC': return 'FLOAT';
      case 'JSON':    return 'JSON';
      default:        return 'STRING';
    }
  }

  // Build equal-weight allocations for each mapped DD environment where the flag is active
  function buildAllocations(flag: EppoFlag, mapping: Map<number, DatadogEnvironment>): DatadogAllocationForFlagCreation[] {
    const variants = flag.variations ?? [];
    if (variants.length === 0) return [];
    const equalWeight = 100.0 / variants.length;
    const variantWeights = variants.map((v) => ({ variant_key: v.variant_key, value: equalWeight }));
    const activeEnvIds = new Set((flag.environments ?? []).filter((e) => e.active).map((e) => e.id));
    const allocations: DatadogAllocationForFlagCreation[] = [];
    for (const [eppoEnvId, ddEnv] of mapping) {
      if (!activeEnvIds.has(eppoEnvId)) continue;
      const allocationKey = `${flag.key}-${ddEnv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      allocations.push({ environment_id: ddEnv.id, name: `${ddEnv.name}`, key: allocationKey, type: 'FEATURE_GATE', variant_weights: variantWeights });
    }
    return allocations;
  }

  if (dryRun) {
    console.log(chalk.bold.yellow('  Dry run — no flags will be created\n'));
  }
  console.log();
  let created = 0, skipped = 0, errored = 0;
  const failures: Array<{ key: string; error: string }> = [];

  for (const flag of flags) {
    const spinner = ora(`Migrating ${chalk.cyan(flag.key)}…`).start();

    if (datadogKeys.has(flag.key)) {
      spinner.succeed(`${chalk.cyan(flag.key)} — already in Datadog, skipped`);
      skipped++; continue;
    }
    if (flag.type === 'LAYER') {
      spinner.warn(`Skipped ${chalk.cyan(flag.key)} — LAYER type not supported`);
      skipped++; continue;
    }
    const variants = (flag.variations ?? []).map((v) => ({ key: v.variant_key, name: v.name, value: v.variant_key }));
    if (variants.length === 0) {
      spinner.warn(`Skipped ${chalk.cyan(flag.key)} — no variants`);
      skipped++; continue;
    }

    const allocations = buildAllocations(flag, envMapping);
    const request: DatadogCreateFlagRequest = {
      key: flag.key, name: flag.name,
      value_type: mapVariationType(flag.variation_type),
      variants,
      allocations: allocations.length > 0 ? allocations : undefined,
    };

    if (dryRun) {
      spinner.succeed(`${chalk.dim('[dry run]')} Would create ${chalk.cyan(flag.key)} (${allocations.length} allocation(s))`);
      created++;
    } else {
      try {
        await createFeatureFlag(ddApiKey, ddAppKey, request);
        spinner.succeed(`Created ${chalk.cyan(flag.key)} (${allocations.length} allocation(s))`);
        created++;
      } catch (err) {
        const msg = axios.isAxiosError(err)
          ? ((err.response?.data as { errors?: Array<{ detail?: string }> })?.errors?.[0]?.detail ?? err.message)
          : String(err);
        spinner.fail(`Failed ${chalk.cyan(flag.key)}: ${chalk.red(msg)}`);
        failures.push({ key: flag.key, error: msg }); errored++;
      }
    }
  }

  console.log();
  console.log(chalk.bold(dryRun ? 'Dry run complete!' : 'Migration complete!'));
  console.log(`  ${chalk.green(String(created))} ${dryRun ? 'would be created' : 'created'}  ${chalk.yellow(String(skipped))} skipped  ${chalk.red(String(errored))} failed`);
  if (failures.length > 0) {
    console.log();
    failures.forEach((f) => console.log(`  ${chalk.red('✗')} ${f.key}: ${f.error}`));
  }
  console.log();
  return 'migrate';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  printHeader();
  if (dryRun) {
    console.log(chalk.bold.yellow('  Dry run mode — no flags will be created\n'));
  }

  const provider = await selectProvider();

  if (provider !== 'eppo') {
    const label = provider === 'launchdarkly' ? 'LaunchDarkly' : 'Statsig';
    console.log();
    console.log(chalk.bold.yellow(`🚧  ${label} support is Coming Soon!  🚧`));
    console.log(chalk.gray(`  We're actively working on ${label} integration. Stay tuned!`));
    console.log();
    return;
  }

  console.log();
  console.log(chalk.bold('Provider: ') + chalk.green('Eppo'));
  console.log();

  const apiKey = await promptForApiKey();

  console.log();
  const { apiKey: ddApiKey, appKey: ddAppKey } = await promptForDatadogKeys();

  const spinner = ora('Loading data…').start();
  let flags: EppoFlag[] = [];
  let datadogKeys: Set<string> = new Set();
  let datadogEnvs: DatadogEnvironment[] = [];

  try {
    [flags, datadogKeys, datadogEnvs] = await Promise.all([
      fetchEppoFlags(apiKey),
      fetchDatadogFlagKeys(ddApiKey, ddAppKey),
      fetchDatadogEnvironments(ddApiKey, ddAppKey),
    ]);
    spinner.succeed(`Loaded ${flags.length} Eppo flag(s) · ${datadogEnvs.length} Datadog environment(s)`);
  } catch (err) {
    spinner.fail('Failed to load data');
    if (axios.isAxiosError(err)) {
      const msg =
        (err.response?.data as { message?: string } | undefined)?.message ?? err.message;
      console.error(chalk.red(`  ${msg}`));
    }
    process.exit(1);
  }

  const eppoEnvironments = extractEnvironments(flags);

  let prevSelectedEnvs: EppoFlagEnvironment[] = [];
  let prevEnvMapping = new Map<number, DatadogEnvironment>();
  let prevSelectedFlags: EppoFlag[] = [];

  // eslint-disable-next-line no-constant-condition
  outer: while (true) {
    let selectedEnvs: EppoFlagEnvironment[];

    if (eppoEnvironments.length > 0) {
      const envResult = await selectEnvironments(flags, eppoEnvironments, prevSelectedEnvs);
      if (envResult === null) break; // escaped → exit
      prevSelectedEnvs = envResult;
      selectedEnvs = envResult;
      // Reset flag selections if the environment selection changed
      const envIds = new Set(envResult.map((e) => e.id));
      const prevEnvIds = new Set(prevSelectedFlags.flatMap((f) => f.environments?.map((e) => e.id) ?? []));
      if ([...envIds].some((id) => !prevEnvIds.has(id))) prevSelectedFlags = [];
    } else {
      selectedEnvs = [];
    }

    // Link each selected Eppo environment to a Datadog environment
    linking: while (true) {
      const mapping = await linkEnvironments(selectedEnvs, datadogEnvs, prevEnvMapping);
      if (mapping === null) break linking; // escaped → back to Eppo env selection

      prevEnvMapping = mapping;

      while (true) {
        const flagResult = await selectFlags(flags, datadogKeys, selectedEnvs, prevSelectedFlags);
        if (flagResult === null) break; // escaped → back to linking

        prevSelectedFlags = flagResult;
        const action = await confirmMigration(prevSelectedFlags, ddApiKey, ddAppKey, prevEnvMapping, datadogKeys);
        if (action === 'cancel') break outer;
        if (action === 'migrate') break outer;
        // action === 'select-more': loop back to selectFlags
      }
    }

    if (eppoEnvironments.length === 0) break; // nothing to go back to
  }
}

main().catch((err: unknown) => {
  // Gracefully handle Ctrl+C
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.log(chalk.gray('\nBye!'));
    process.exit(0);
  }
  console.error(chalk.red('\nUnexpected error:'), err);
  process.exit(1);
});
