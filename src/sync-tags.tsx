#!/usr/bin/env node
import chalk from 'chalk';
import {
	ArgParseError,
	type MigrateTagsArgs,
	type ProviderValue,
	parseMigrateTagsArgs,
} from './args.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { PermissionsError } from './components/PermissionsError.js';
import { select } from './components/Select.js';
import { fetchCurrentUserPermissions } from './datadog/api.js';
import { requireEnvVars } from './helpers/env.js';
import { withConsoleLogToStderr } from './helpers/output.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Only read permissions are checked upfront — write permissions can't be probed
// safely, so the tag sync surfaces missing write scopes at runtime.
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

function parseArgs(): MigrateTagsArgs {
	try {
		return parseMigrateTagsArgs(process.argv.slice(2));
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
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.migrateTags} />);
}

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

// ─── Prompt Steps ─────────────────────────────────────────────────────────────

async function selectProvider(): Promise<ProviderValue> {
	return select<ProviderValue>({
		message: 'Which feature flagging solution are you migrating tags from?',
		choices: PROVIDERS.map((p) => ({
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs();

	// Validate Datadog env vars up front. Provider-specific env vars are
	// validated after the provider is known so that, e.g., a LaunchDarkly tag
	// sync doesn't require EPPO_API_KEY to be set.
	const ddEnv = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const ddApiKey = ddEnv.DD_API_KEY;
	const ddAppKey = ddEnv.DD_APP_KEY;

	if (!args.interactive) {
		const ni = args.nonInteractive;
		// biome-ignore lint/style/noNonNullAssertion: present in non-interactive mode
		const niArgs = ni!;
		await withConsoleLogToStderr(async () => {
			if (niArgs.provider === 'eppo') {
				requireEnvVars(['EPPO_API_KEY']);
			} else {
				requireEnvVars(['LAUNCHDARKLY_API_KEY']);
			}
			// Already validated upstream.
			// biome-ignore lint/style/noNonNullAssertion: validated in parseMigrateTagsArgs
			const ddSite = args.datadogSite!;
			await checkRequiredPermissions(ddApiKey, ddAppKey, ddSite);

			if (niArgs.provider === 'launchdarkly') {
				const { runLaunchDarklyTagMigration } = await import(
					'./launchdarkly/sync-tags.js'
				);
				await runLaunchDarklyTagMigration(
					ddApiKey,
					ddAppKey,
					ddSite,
					args.dryRun,
					{
						nonInteractive: {
							// biome-ignore lint/style/noNonNullAssertion: validated for LD
							projectKey: niArgs.projectKey!,
							flagKeys: niArgs.flagKeys,
							tagMode: niArgs.tagMode,
						},
					},
				);
			} else {
				const { runEppoTagMigration } = await import('./eppo/sync-tags.js');
				await runEppoTagMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
					nonInteractive: {
						flagKeys: niArgs.flagKeys,
						tagMode: niArgs.tagMode,
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
			chalk.bold.yellow('  Dry run mode — no tags will be changed\n'),
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
		const { runLaunchDarklyTagMigration } = await import(
			'./launchdarkly/sync-tags.js'
		);
		await runLaunchDarklyTagMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
			tagMode: args.tagMode,
		});
	} else {
		const { runEppoTagMigration } = await import('./eppo/sync-tags.js');
		await runEppoTagMigration(ddApiKey, ddAppKey, ddSite, args.dryRun, {
			tagMode: args.tagMode,
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
