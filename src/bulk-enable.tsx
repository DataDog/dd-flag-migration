#!/usr/bin/env node
import chalk from 'chalk';
import {
	BULK_ENABLE_FILTER_CATEGORIES,
	flagEnablementCategories,
} from './bulk-enable/filtering.js';
import { processBulkEnablePairs } from './bulk-enable/process.js';
import { exportBulkEnableChangesToXlsx } from './bulk-enable/xlsx.js';
import { confirm } from './components/Confirm.js';
import { filterableCheckbox } from './components/FilterableCheckbox.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { spinner } from './components/Spinner.js';
import {
	enableFeatureFlagEnvironmentWithOutcome,
	fetchDatadogEnvironments,
	fetchFeatureFlagEnvironmentStatuses,
} from './datadog/api.js';
import type { DatadogEnvironment, DatadogFlagEntry } from './datadog/types.js';
import {
	loadMigratedFlagsWithTags,
	selectMigratedFlags,
} from './helpers/bulk-flags.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { checkRequiredPermissions } from './helpers/permissions.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';

// Only read permissions are checked upfront — write permissions cannot be
// probed safely, so missing write scope is surfaced by the enable request.
const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
] as const;

async function selectEnvironments(
	environments: DatadogEnvironment[],
): Promise<DatadogEnvironment[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox<DatadogEnvironment>({
		message: 'Select environments to enable flags in:',
		choices: environments
			.slice()
			.sort((a, b) => {
				if (a.is_production !== b.is_production) {
					return a.is_production ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			})
			.map((environment) => ({
				name:
					environment.name +
					(environment.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : ''),
				value: environment,
				searchTerms: [environment.name],
			})),
		pageSize,
	});
}

async function main(): Promise<void> {
	const env = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const apiKey = env.DD_API_KEY;
	const appKey = env.DD_APP_KEY;

	process.stdout.write('\x1Bc');
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.bulkEnable} />);
	const site = await promptForDatadogSite();
	await checkRequiredPermissions(apiKey, appKey, site, REQUIRED_PERMISSIONS);

	const loading = spinner(
		'Fetching migrated flags and Datadog environments…',
	).start();
	let flags: DatadogFlagEntry[];
	let environments: DatadogEnvironment[];
	try {
		[flags, environments] = await Promise.all([
			loadMigratedFlagsWithTags(apiKey, appKey, site),
			fetchDatadogEnvironments(apiKey, appKey, site),
		]);
		loading.succeed(
			`Found ${flags.length} migrated flag(s) and ${environments.length} environment(s)`,
		);
	} catch (error) {
		loading.fail('Could not load flags and environments');
		throw error;
	}

	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo migrated Datadog flags were found.'));
		return;
	}
	if (environments.length === 0) {
		console.log(chalk.yellow('\nNo Datadog environments were found.'));
		return;
	}

	const selectedEnvironments = await selectEnvironments(environments);
	if (selectedEnvironments === null) throw new PromptCancelledError();
	if (selectedEnvironments.length === 0) {
		console.log(
			chalk.yellow('\nNo environments selected — nothing to enable.'),
		);
		return;
	}

	const selectedFlags = await selectMigratedFlags(flags, {
		filterCategories: BULK_ENABLE_FILTER_CATEGORIES,
		categoriesForFlag: (flag) =>
			flagEnablementCategories(flag, selectedEnvironments),
	});
	if (selectedFlags === null) throw new PromptCancelledError();
	if (selectedFlags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to enable.'));
		return;
	}

	const pairCount = selectedFlags.length * selectedEnvironments.length;
	const includesProduction = selectedEnvironments.some(
		(environment) => environment.is_production,
	);
	const shouldContinue = await confirm({
		message: `Enable ${selectedFlags.length} flag(s) in ${selectedEnvironments.length} environment(s) (${pairCount} flag/environment change(s))${includesProduction ? ', including production' : ''}?`,
		default: !includesProduction,
	});
	if (!shouldContinue) {
		console.log(chalk.yellow('\nEnvironment enable update cancelled.'));
		return;
	}

	const progress = spinner().start();
	const results = await processBulkEnablePairs(
		selectedFlags,
		selectedEnvironments,
		{
			fetchStatuses: (flag) =>
				fetchFeatureFlagEnvironmentStatuses(apiKey, appKey, flag.id, site),
			enable: (flag, environment) =>
				enableFeatureFlagEnvironmentWithOutcome(
					apiKey,
					appKey,
					flag.id,
					environment.id,
					site,
				),
			onProgress: ({ flag, environment, index, total }) => {
				progress.text = `Enabling ${flag.key} in ${environment.name} (${index}/${total})…`;
			},
		},
	);

	const enabledCount = results.filter(
		(result) => result.status === 'Enabled',
	).length;
	const unknownPriorStatusEnabledCount = results.filter(
		(result) => result.status === 'Enabled (prior status unknown)',
	).length;
	const alreadyEnabledCount = results.filter(
		(result) => result.status === 'Already enabled',
	).length;
	const approvalCount = results.filter(
		(result) => result.status === 'Approval requested',
	).length;
	const unknownPriorStatusApprovalCount = results.filter(
		(result) => result.status === 'Approval requested (prior status unknown)',
	).length;
	const failedCount = results.filter(
		(result) => result.status === 'Failed',
	).length;
	const summaryParts = [
		`${enabledCount} enabled`,
		...(unknownPriorStatusEnabledCount > 0
			? [`${unknownPriorStatusEnabledCount} enabled with prior status unknown`]
			: []),
		`${alreadyEnabledCount} already enabled`,
		...(approvalCount > 0 ? [`${approvalCount} approval requested`] : []),
		...(unknownPriorStatusApprovalCount > 0
			? [
					`${unknownPriorStatusApprovalCount} approval requested with prior status unknown`,
				]
			: []),
	];
	const summary = summaryParts.join(', ');
	if (failedCount > 0) {
		progress.warn(
			`Bulk enable finished with ${failedCount} failed result(s): ${summary}`,
		);
	} else {
		progress.succeed(`Bulk enable complete: ${summary}`);
	}

	await exportBulkEnableChangesToXlsx(results);
	if (failedCount > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
