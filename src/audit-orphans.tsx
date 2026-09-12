#!/usr/bin/env node
import chalk from 'chalk';
import { parseAuditOrphansArgs } from './args.js';
import { compareLaunchDarklyFlagKeys } from './audit-orphans/launchdarkly.js';
import { exportFlagComparisonToXlsx } from './audit-orphans/xlsx.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { renderStatic } from './components/mount.js';
import { spinner } from './components/Spinner.js';
import { fetchDatadogFlags } from './datadog/api.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { checkRequiredPermissions } from './helpers/permissions.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';
import { fetchFlags } from './launchdarkly/api.js';

const REQUIRED_PERMISSIONS = ['feature_flag_config_read'] as const;

async function main(): Promise<void> {
	const args = parseAuditOrphansArgs(process.argv.slice(2));
	const env = requireEnvVars([
		'DD_API_KEY',
		'DD_APP_KEY',
		'LAUNCHDARKLY_API_KEY',
	]);

	process.stdout.write('\x1Bc');
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.auditOrphans} />);

	const site = await promptForDatadogSite(args.datadogSite);
	await checkRequiredPermissions(
		env.DD_API_KEY,
		env.DD_APP_KEY,
		site,
		REQUIRED_PERMISSIONS,
	);

	const loading = spinner(
		`Comparing Datadog with LaunchDarkly project "${args.projectKey}"…`,
	).start();
	try {
		const [datadogFlags, launchDarklyFlags] = await Promise.all([
			fetchDatadogFlags(env.DD_API_KEY, env.DD_APP_KEY, site),
			fetchFlags(env.LAUNCHDARKLY_API_KEY, args.projectKey),
		]);
		const comparison = compareLaunchDarklyFlagKeys(
			datadogFlags,
			launchDarklyFlags,
			args.projectKey,
		);

		loading.succeed(
			`Compared ${datadogFlags.length} Datadog flag(s) with ${launchDarklyFlags.length} LaunchDarkly flag(s)`,
		);
		await exportFlagComparisonToXlsx({
			comparison,
			projectKey: args.projectKey,
			datadogSite: site,
			datadogFlagCount: datadogFlags.length,
			launchDarklyFlagCount: launchDarklyFlags.length,
			runAt: new Date(),
		});
	} catch (error) {
		loading.fail('Could not complete the orphan audit');
		throw error;
	}
}

main().catch((error: unknown) => {
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
