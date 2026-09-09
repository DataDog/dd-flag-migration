#!/usr/bin/env node
import chalk from 'chalk';
import {
	ArgParseError,
	parseSyncDistributionChannelArgs,
	type SyncDistributionChannelArgs,
} from './args.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { checkRequiredPermissions } from './helpers/permissions.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';
import { runLaunchDarklyDistributionChannelSync } from './launchdarkly/sync-distribution-channel.js';

const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
] as const;

async function main(): Promise<void> {
	let args: SyncDistributionChannelArgs;
	try {
		args = parseSyncDistributionChannelArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof ArgParseError) {
			console.error(chalk.red(`\n${error.message}\n`));
			process.exit(1);
		}
		throw error;
	}

	const env = requireEnvVars([
		'DD_API_KEY',
		'DD_APP_KEY',
		'LAUNCHDARKLY_API_KEY',
	]);
	process.stdout.write('\x1Bc');
	await renderStatic(
		<Header subtitle={HEADER_SUBTITLES.distributionChannel} />,
	);
	if (args.dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be changed\n'),
		);
	}
	const site = await promptForDatadogSite(args.datadogSite);
	await checkRequiredPermissions(
		env.DD_API_KEY,
		env.DD_APP_KEY,
		site,
		REQUIRED_PERMISSIONS,
	);
	await runLaunchDarklyDistributionChannelSync(
		env.DD_API_KEY,
		env.DD_APP_KEY,
		site,
		args.dryRun,
	);
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
