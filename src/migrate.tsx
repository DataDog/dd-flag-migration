#!/usr/bin/env node
import chalk from 'chalk';
import {
	ArgParseError,
	type MigrateArgs,
	type ProviderValue,
	parseMigrateArgs,
} from './args.js';
import { confirm } from './components/Confirm.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { input } from './components/Input.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { PermissionsError } from './components/PermissionsError.js';
import { select } from './components/Select.js';
import { fetchCurrentUserPermissions } from './datadog/api.js';
import { getDatadogSite, saveDatadogSite } from './helpers/config.js';
import { requireEnvVars } from './helpers/env.js';
import { withConsoleLogToStderr } from './helpers/output.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Only read permissions are checked upfront — write permissions can't be probed
// safely, so the migration surfaces missing write scopes at runtime.
const ALL_REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
	'teams_read',
] as const;

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

async function printHeader(): Promise<void> {
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.migrate} />);
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

// ─── Permission Check ─────────────────────────────────────────────────────────

async function checkRequiredPermissions(
	apiKey: string,
	appKey: string,
	site: string,
): Promise<void> {
	let actual: string[];
	try {
		actual = await fetchCurrentUserPermissions(apiKey, appKey, site);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(
			chalk.red(`\nFailed to verify Datadog permissions: ${detail}\n`),
		);
		process.exit(1);
	}
	const missing = ALL_REQUIRED_PERMISSIONS.filter((p) => !actual.includes(p));
	if (missing.length > 0) {
		await renderStatic(<PermissionsError missing={missing} />);
		process.exit(1);
	}
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
		const ni = args.nonInteractive;
		await withConsoleLogToStderr(async () => {
			// Non-interactive: skip UI, prompts, and saved-site lookup.
			if (ni.provider === 'eppo') {
				requireEnvVars(['EPPO_API_KEY']);
			} else {
				requireEnvVars(['LAUNCHDARKLY_API_KEY']);
			}
			// Already validated upstream.
			// biome-ignore lint/style/noNonNullAssertion: validated in parseMigrateArgs
			const ddSite = args.datadogSite!;
			await checkRequiredPermissions(ddApiKey, ddAppKey, ddSite);

			if (ni.provider === 'launchdarkly') {
				const { runLaunchDarklyMigration } = await import(
					'./launchdarkly/migrate.js'
				);
				await runLaunchDarklyMigration(
					ddApiKey,
					ddAppKey,
					ddSite,
					args.dryRun,
					{
						doExport: args.doExport,
						nonInteractive: {
							// biome-ignore lint/style/noNonNullAssertion: validated for LD
							projectKey: ni.projectKey!,
							envMap: ni.envMap,
							flagKeys: ni.flagKeys,
						},
					},
				);
			} else {
				const { runEppoMigration } = await import('./eppo/migrate.js');
				await runEppoMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
					doExport: args.doExport,
					nonInteractive: {
						envMap: ni.envMap,
						flagKeys: ni.flagKeys,
					},
				});
			}
		});
		return;
	}

	clearScreen();
	await printHeader();
	if (args.dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	const ddSite = await promptForDatadogSite(args.datadogSite);
	await checkRequiredPermissions(ddApiKey, ddAppKey, ddSite);

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

	if (provider === 'launchdarkly') {
		const { runLaunchDarklyMigration } = await import(
			'./launchdarkly/migrate.js'
		);
		await runLaunchDarklyMigration(ddApiKey, ddAppKey, ddSite, args.dryRun);
	} else {
		const { runEppoMigration } = await import('./eppo/migrate.js');
		await runEppoMigration(ddApiKey, ddAppKey, ddSite, args.dryRun);
	}
}

main().catch((err: unknown) => {
	// Gracefully handle Ctrl+C / escape
	if (err instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), err);
	process.exit(1);
});
