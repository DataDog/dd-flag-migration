#!/usr/bin/env node
import chalk from 'chalk';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { PermissionsError } from './components/PermissionsError.js';
import { select } from './components/Select.js';
import { fetchCurrentUserPermissions } from './datadog/api.js';
import { checkDatadogOrgPermissions } from './datadog/org-permissions.js';
import {
	assertDistinctDatadogOrgs,
	requireDatadogOrgPair,
} from './datadog/orgs.js';
import { requireEnvVars } from './helpers/env.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';
import { runMigrationStatusWorkflow } from './migration-status/index.js';
import { runOrgDiffWorkflow } from './org-diff/index.js';

const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
] as const;

type StatusProvider = 'eppo' | 'datadog' | 'launchdarkly';

const PROVIDERS: Array<{
	name: string;
	value: StatusProvider;
	disabled?: boolean;
}> = [
	{ name: 'Eppo → Datadog (coming soon)', value: 'eppo', disabled: true },
	{ name: 'Datadog → Datadog', value: 'datadog' },
	{ name: 'LaunchDarkly → Datadog', value: 'launchdarkly' },
];

async function selectProvider(): Promise<StatusProvider> {
	return select<StatusProvider>({
		message: 'Which migration would you like to check?',
		choices: PROVIDERS.map((p) => ({ ...p, short: p.name })),
	});
}

async function runDatadogStatus(): Promise<void> {
	const pair = requireDatadogOrgPair();
	await assertDistinctDatadogOrgs(pair);
	if (!(await checkDatadogOrgPermissions(pair))) {
		process.exitCode = 1;
		return;
	}
	await runOrgDiffWorkflow(pair);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage: dd-flag-migration migration-status

Choose a migration to check, then generate a read-only status workbook.

  LaunchDarkly → Datadog  Select a LaunchDarkly project and environments, map
                          them to Datadog environments, and compare.
  Datadog → Datadog       Map environments between the SOURCE_DD_* and
                          TARGET_DD_* orgs and compare them (same report as
                          org-diff).
  Eppo → Datadog          Coming soon.`);
		return;
	}
	if (args.length > 0) {
		throw new Error(
			`migration-status is interactive and does not accept options: ${args.join(' ')}`,
		);
	}

	process.stdout.write('\x1Bc');
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.migrationStatus} />);
	// The provider decides which credentials apply, so it is chosen first.
	const provider = await selectProvider();
	if (provider === 'datadog') {
		await runDatadogStatus();
		return;
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
