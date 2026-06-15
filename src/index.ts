#!/usr/bin/env node
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
	ArgParseError,
	type MigrateArgs,
	type ProviderValue,
	parseMigrateArgs,
} from './args.js';
import { getDatadogSite, saveDatadogSite } from './config.js';
import { requireEnvVars } from './env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDERS = [
	{ name: 'Eppo', value: 'eppo' },
	{ name: 'LaunchDarkly', value: 'launchdarkly' },
] as const;

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

function parseArgs(): MigrateArgs {
	try {
		return parseMigrateArgs(process.argv.slice(2));
	} catch (err) {
		if (err instanceof ArgParseError) {
			process.stderr.write(chalk.red(`\n${err.message}\n\n`));
			process.exit(1);
		}
		throw err;
	}
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

async function promptForDatadogSite(
	datadogSiteArg: string | undefined,
): Promise<string> {
	const { confirm, input } = await import('@inquirer/prompts');

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs();

	// Validate Datadog env vars up front. Provider-specific env vars are
	// validated after the provider is known so that, e.g., a LaunchDarkly
	// migration doesn't require EPPO_API_KEY to be set.
	const ddEnv = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const ddApiKey = ddEnv.DD_API_KEY;
	const ddAppKey = ddEnv.DD_APP_KEY;

	if (!args.interactive && args.nonInteractive) {
		// Non-interactive: skip UI, prompts, and saved-site lookup.
		const ni = args.nonInteractive;
		if (ni.provider === 'eppo') {
			requireEnvVars(['EPPO_API_KEY']);
		} else {
			requireEnvVars(['LAUNCHDARKLY_API_KEY']);
		}
		// Already validated upstream.
		// biome-ignore lint/style/noNonNullAssertion: validated in parseMigrateArgs
		const ddSite = args.datadogSite!;

		if (ni.provider === 'launchdarkly') {
			const { runLaunchDarklyMigration } = await import(
				'./launchdarkly/index.js'
			);
			await runLaunchDarklyMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
				doExport: args.doExport,
				nonInteractive: {
					// biome-ignore lint/style/noNonNullAssertion: validated for LD
					projectKey: ni.projectKey!,
					envMap: ni.envMap,
					flagKeys: ni.flagKeys,
				},
			});
		} else {
			const { runEppoMigration } = await import('./eppo/index.js');
			await runEppoMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
				doExport: args.doExport,
				nonInteractive: {
					envMap: ni.envMap,
					flagKeys: ni.flagKeys,
				},
			});
		}
		return;
	}

	clearScreen();
	printHeader();
	if (args.dryRun) {
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

	const ddSite = await promptForDatadogSite(args.datadogSite);

	if (provider === 'launchdarkly') {
		const { runLaunchDarklyMigration } = await import(
			'./launchdarkly/index.js'
		);
		await runLaunchDarklyMigration(ddApiKey, ddAppKey, ddSite, args.dryRun);
	} else {
		const { runEppoMigration } = await import('./eppo/index.js');
		await runEppoMigration(ddApiKey, ddAppKey, ddSite, args.dryRun);
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
