#!/usr/bin/env node
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getDatadogSite, saveDatadogSite } from './config.js';
import { requireEnvVars } from './env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDERS = [
	{ name: 'Eppo', value: 'eppo' },
	{ name: 'LaunchDarkly', value: 'launchdarkly' },
] as const;

type ProviderValue = (typeof PROVIDERS)[number]['value'];

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
			chalk.hex('#632CA6')('            Migrate to Datadog            ') +
			purple('║'),
	);
	console.log(purple('╚══════════════════════════════════════════╝'));
	console.log();
}

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

// ─── Prompt Steps ─────────────────────────────────────────────────────────────

async function selectProvider(): Promise<ProviderValue> {
	return select<ProviderValue>({
		message: 'Which feature flagging solution are you migrating from?',
		choices: PROVIDERS.map((p) => ({
			name: p.name,
			value: p.value,
			short: p.name,
		})),
	});
}

async function promptForDatadogSite(): Promise<string> {
	const { confirm, input } = await import('@inquirer/prompts');
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

// ─── Main ─────────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
	// Validate Datadog env vars up front. Provider-specific env vars are
	// validated after the user picks a provider so that, e.g., a LaunchDarkly
	// migration doesn't require EPPO_API_KEY to be set.
	const ddEnv = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const ddApiKey = ddEnv.DD_API_KEY;
	const ddAppKey = ddEnv.DD_APP_KEY;

	clearScreen();
	printHeader();
	if (dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	const provider = await selectProvider();

	console.log();
	console.log(
		chalk.bold('Provider: ') +
			chalk.green(provider === 'eppo' ? 'Eppo' : 'LaunchDarkly'),
	);
	console.log();

	if (provider === 'eppo') {
		requireEnvVars(['EPPO_API_KEY']);
	} else {
		requireEnvVars(['LAUNCHDARKLY_API_KEY']);
	}

	const ddSite = await promptForDatadogSite();

	if (provider === 'launchdarkly') {
		const { runLaunchDarklyMigration } = await import(
			'./launchdarkly/index.js'
		);
		await runLaunchDarklyMigration(ddApiKey, ddAppKey, ddSite, dryRun);
	} else {
		const { runEppoMigration } = await import('./eppo/index.js');
		await runEppoMigration(ddApiKey, ddAppKey, ddSite, dryRun);
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
