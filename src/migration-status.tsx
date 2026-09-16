#!/usr/bin/env node
import chalk from 'chalk';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { PermissionsError } from './components/PermissionsError.js';
import { fetchCurrentUserPermissions } from './datadog/api.js';
import { requireEnvVars } from './helpers/env.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';
import { runMigrationStatusWorkflow } from './migration-status/index.js';

const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
] as const;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage: dd-flag-migration migration-status

Interactively select a LaunchDarkly project and environments, map them to
Datadog environments, and generate a read-only migration status workbook.`);
		return;
	}
	if (args.length > 0) {
		throw new Error(
			`migration-status is interactive and does not accept options: ${args.join(' ')}`,
		);
	}

	const dd = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const ld = requireEnvVars(['LAUNCHDARKLY_API_KEY']);
	const site = await promptForDatadogSite();
	const permissions = await fetchCurrentUserPermissions(
		dd.DD_API_KEY,
		dd.DD_APP_KEY,
		site,
	);
	const missing = REQUIRED_PERMISSIONS.filter(
		(permission) => !permissions.includes(permission),
	);
	if (missing.length > 0) {
		await renderStatic(<PermissionsError missing={missing} />);
		process.exitCode = 1;
		return;
	}
	await runMigrationStatusWorkflow(
		ld.LAUNCHDARKLY_API_KEY,
		dd.DD_API_KEY,
		dd.DD_APP_KEY,
		site,
	);
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		return;
	}
	console.error(chalk.red('\nUnable to generate migration status:'), error);
	process.exitCode = 1;
});
