#!/usr/bin/env node
import chalk from 'chalk';
import {
	ArgParseError,
	type MigrateArgs,
	type MigrateProviderValue,
	parseMigrateArgs,
	resolveMigrationDefaults,
} from './args.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { PermissionsError } from './components/PermissionsError.js';
import { select } from './components/Select.js';
import { fetchCurrentUserPermissions } from './datadog/api.js';
import { getDatadogCredentials } from './datadog/auth.js';
import { checkDatadogOrgPermissions } from './datadog/org-permissions.js';
import {
	assertDistinctDatadogOrgs,
	type DatadogOrgPair,
	requireDatadogOrgPair,
} from './datadog/orgs.js';
import { requireEnvVars } from './helpers/env.js';
import { withConsoleLogToStderr } from './helpers/output.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';
import { MIGRATION_PROVIDERS } from './helpers/providers.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Only read permissions are checked upfront — write permissions can't be probed
// safely, so the migration surfaces missing write scopes at runtime.
const ALL_REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
	'teams_read',
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

function providerLabel(provider: MigrateProviderValue): string {
	return (
		MIGRATION_PROVIDERS.find((p) => p.value === provider)?.name ?? provider
	);
}

async function selectProvider(): Promise<MigrateProviderValue> {
	return select<MigrateProviderValue>({
		message: 'Which migration would you like to run?',
		choices: MIGRATION_PROVIDERS.map((p) => ({
			name: p.name,
			value: p.value,
			short: p.name,
		})),
	});
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

/**
 * Datadog-to-Datadog migrations read both orgs from SOURCE_DD_* and
 * TARGET_DD_* instead of DD_API_KEY / DD_APP_KEY / DD_SITE.
 */
async function prepareDatadogOrgPair(): Promise<DatadogOrgPair> {
	const pair = requireDatadogOrgPair();
	try {
		await assertDistinctDatadogOrgs(pair);
		if (!(await checkDatadogOrgPermissions(pair))) process.exit(1);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(chalk.red(`\n${detail}\n`));
		process.exit(1);
	}
	return pair;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = resolveMigrationDefaults(parseArgs());

	if (!args.interactive && args.nonInteractive?.provider === 'datadog') {
		const ni = args.nonInteractive;
		await withConsoleLogToStderr(async () => {
			const pair = await prepareDatadogOrgPair();
			const { runDatadogMigration } = await import(
				'./datadog-migration/migrate.js'
			);
			await runDatadogMigration(pair, args.dryRun, {
				doExport: args.doExport,
				tagMode: args.tagMode,
				nonInteractive: { envMap: ni.envMap, flagKeys: ni.flagKeys },
			});
		});
		return;
	}

	if (!args.interactive && args.nonInteractive) {
		const ni = args.nonInteractive;
		// Validate Datadog env vars up front. Provider-specific env vars are
		// validated next so that, e.g., a LaunchDarkly migration doesn't require
		// EPPO_API_KEY to be set.
		const { apiKey: ddApiKey, appKey: ddAppKey } = getDatadogCredentials();
		await withConsoleLogToStderr(async () => {
			// Non-interactive: skip UI, prompts, and saved-site lookup.
			if (ni.provider === 'eppo') {
				requireEnvVars(['EPPO_API_KEY']);
			} else {
				requireEnvVars(['LAUNCHDARKLY_API_KEY']);
			}
			// An explicit CLI value takes precedence; DD_SITE keeps automated jobs
			// from needing to duplicate their standard Datadog configuration.
			const ddSite = args.datadogSite ?? requireEnvVars(['DD_SITE']).DD_SITE;
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
						tagMode: args.tagMode,
						distributionChannelMode: args.distributionChannelMode,
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
					tagMode: args.tagMode,
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

	// The provider decides which credentials apply, so it is chosen first.
	const provider = await selectProvider();

	console.log();
	console.log(chalk.bold('Migration: ') + chalk.green(providerLabel(provider)));
	console.log();

	if (provider === 'datadog') {
		if (args.datadogSite !== undefined) {
			console.error(
				chalk.red(
					'\n--datadog-site is not supported for Datadog-to-Datadog migrations; set SOURCE_DD_SITE and TARGET_DD_SITE instead.\n',
				),
			);
			process.exit(1);
		}
		if (args.distributionChannelMode !== undefined) {
			console.error(
				chalk.red(
					'\n--distribution-channel is only supported for LaunchDarkly migrations.\n',
				),
			);
			process.exit(1);
		}
		const pair = await prepareDatadogOrgPair();
		const { runDatadogMigration } = await import(
			'./datadog-migration/migrate.js'
		);
		await runDatadogMigration(pair, args.dryRun, {
			tagMode: args.tagMode,
			doExport: args.doExport,
		});
		return;
	}

	const { apiKey: ddApiKey, appKey: ddAppKey } = getDatadogCredentials();
	const ddSite = await promptForDatadogSite(args.datadogSite);
	await checkRequiredPermissions(ddApiKey, ddAppKey, ddSite);

	if (provider === 'eppo') {
		requireEnvVars(['EPPO_API_KEY']);
	} else {
		requireEnvVars(['LAUNCHDARKLY_API_KEY']);
	}

	if (provider === 'launchdarkly') {
		const { runLaunchDarklyMigration } = await import(
			'./launchdarkly/migrate.js'
		);
		await runLaunchDarklyMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
			distributionChannelMode: args.distributionChannelMode,
			tagMode: args.tagMode,
			doExport: args.doExport,
		});
	} else {
		const { runEppoMigration } = await import('./eppo/migrate.js');
		await runEppoMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
			tagMode: args.tagMode,
			doExport: args.doExport,
		});
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
