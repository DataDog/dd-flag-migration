#!/usr/bin/env node
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
	getDatadogKeys,
	getDatadogSite,
	saveDatadogKeys,
	saveDatadogSite,
} from './config.js';
import { validateDatadogKeys } from './datadog.js';

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

async function promptForDatadogKeys(): Promise<{
	apiKey: string;
	appKey: string;
}> {
	const { confirm, password } = await import('@inquirer/prompts');
	const ora = (await import('ora')).default;
	const stored = getDatadogKeys();

	if (stored.apiKey && stored.appKey) {
		const useStored = await confirm({
			message: 'Use your saved Datadog keys?',
			default: true,
		});
		if (useStored) return { apiKey: stored.apiKey, appKey: stored.appKey };
	}

	// eslint-disable-next-line no-constant-condition
	while (true) {
		console.log(
			chalk.gray(
				'  Your Application key needs these scopes: feature_flag_config_read,\n' +
					'  feature_flag_config_write, feature_flag_environment_config_read,\n' +
					'  feature_flag_environment_config_write, restriction_policies_read,\n' +
					'  restriction_policies_write, teams_read',
			),
		);
		const apiKey = await password({
			message: 'Enter your Datadog API key:',
			validate: (input) =>
				input.trim().length > 0 ? true : 'API key cannot be empty',
		});
		const appKey = await password({
			message: 'Enter your Datadog Application key:',
			validate: (input) =>
				input.trim().length > 0 ? true : 'Application key cannot be empty',
		});

		const spinner = ora('Validating Datadog keys…').start();
		const valid = await validateDatadogKeys(
			apiKey.trim(),
			appKey.trim(),
			getDatadogSite() ?? 'datadoghq.com',
		);

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

// ─── Main ─────────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
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

	const ddSite = await promptForDatadogSite();
	const { apiKey: ddApiKey, appKey: ddAppKey } = await promptForDatadogKeys();

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
