#!/usr/bin/env node
import chalk from 'chalk';
import { ArgParseError, parseCleanTargetingAttributesArgs } from './args.js';
import {
	applyTargetingAttributePlans,
	planTargetingAttributeCleanup,
	type TargetingAttributeFlagPlan,
	targetingAttributeChangeCount,
} from './clean-targeting-attributes/process.js';
import { buildFlagInspectionChoices } from './clean-targeting-attributes/selection.js';
import { exportTargetingAttributeCleanupToXlsx } from './clean-targeting-attributes/xlsx.js';
import { confirm } from './components/Confirm.js';
import { filterableCheckbox } from './components/FilterableCheckbox.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { spinner } from './components/Spinner.js';
import {
	fetchCurrentOrganizationName,
	fetchDatadogFlags,
	fetchFlagAllocations,
	overwriteFlagAllocationsForEnvironment,
} from './datadog/api.js';
import type { DatadogFlagEntry } from './datadog/types.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { checkRequiredPermissions } from './helpers/permissions.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';

const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
] as const;

function parseArgs() {
	try {
		return parseCleanTargetingAttributesArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof ArgParseError) {
			process.stderr.write(chalk.red(`\n${error.message}\n\n`));
			process.exit(1);
		}
		throw error;
	}
}

function choiceLabel(plan: TargetingAttributeFlagPlan): string {
	const attributes = [
		...new Set(
			plan.environments.flatMap((environment) =>
				environment.changes.map(
					(change) =>
						`${change.previousAttribute} → ${change.updatedAttribute}`,
				),
			),
		),
	];
	const displayedAttributes = attributes.slice(0, 3).join(', ');
	const remaining =
		attributes.length > 3 ? `, +${attributes.length - 3} more` : '';
	const count = targetingAttributeChangeCount(plan);
	return `${plan.flag.key}${chalk.gray(
		`  (${count} match${count === 1 ? '' : 'es'} in ${plan.environments.length} environment${plan.environments.length === 1 ? '' : 's'}: ${displayedAttributes}${remaining})`,
	)}`;
}

async function selectFlagsToInspect(
	flags: DatadogFlagEntry[],
): Promise<DatadogFlagEntry[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox({
		message: 'Select active flags to inspect for targeting attribute cleanup:',
		choices: buildFlagInspectionChoices(flags),
		pageSize,
	});
}

async function selectPlans(
	plans: TargetingAttributeFlagPlan[],
): Promise<TargetingAttributeFlagPlan[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox({
		message: 'Select flags whose targeting attributes should be cleaned:',
		choices: plans.map((plan) => ({
			name: choiceLabel(plan),
			value: plan,
			searchTerms: [
				plan.flag.key,
				...plan.environments.map((environment) => environment.environmentName),
				...plan.environments.flatMap((environment) =>
					environment.changes.flatMap((change) => [
						change.previousAttribute,
						change.updatedAttribute,
					]),
				),
			],
		})),
		pageSize,
	});
}

function printPreview(plans: TargetingAttributeFlagPlan[]): void {
	console.log(chalk.bold('\nTargeting attribute changes:'));
	for (const plan of plans) {
		console.log(chalk.cyan(`\n${plan.flag.key}`));
		for (const environment of plan.environments) {
			console.log(chalk.bold(`  ${environment.environmentName}`));
			for (const change of environment.changes) {
				console.log(
					`    ${change.allocationName} (${change.allocationKey}): ` +
						`${chalk.red(change.previousAttribute)} → ${chalk.green(
							change.updatedAttribute,
						)}`,
				);
			}
		}
	}
	console.log();
}

async function main(): Promise<void> {
	const args = parseArgs();
	const env = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const apiKey = env.DD_API_KEY;
	const appKey = env.DD_APP_KEY;

	process.stdout.write('\x1Bc');
	await renderStatic(
		<Header subtitle={HEADER_SUBTITLES.cleanTargetingAttributes} />,
	);
	const site = await promptForDatadogSite(args.datadogSite);
	await checkRequiredPermissions(apiKey, appKey, site, REQUIRED_PERMISSIONS);

	const loading = spinner('Fetching active Datadog flags…').start();
	const [flags, organizationName] = await Promise.all([
		fetchDatadogFlags(apiKey, appKey, site),
		fetchCurrentOrganizationName(apiKey, appKey, site),
	]);
	loading.succeed(`Found ${flags.length} active flag(s)`);
	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo active Datadog flags were found.'));
		return;
	}

	const flagsToInspect = await selectFlagsToInspect(flags);
	if (flagsToInspect === null) throw new PromptCancelledError();
	if (flagsToInspect.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to inspect.'));
		return;
	}

	const discovery = spinner('Inspecting selected flags…').start();
	const plans: TargetingAttributeFlagPlan[] = [];
	const discoveryFailures: Array<{
		flagId: string;
		flagKey: string;
		error: unknown;
	}> = [];

	for (let index = 0; index < flagsToInspect.length; index++) {
		const flag = flagsToInspect[index];
		discovery.text = `Inspecting ${flag.key} (${index + 1}/${flagsToInspect.length})…`;
		try {
			const environments = await fetchFlagAllocations(
				apiKey,
				appKey,
				flag.id,
				site,
			);
			const plan = planTargetingAttributeCleanup(flag, environments);
			if (plan !== null) plans.push(plan);
		} catch (error) {
			discoveryFailures.push({
				flagId: flag.id,
				flagKey: flag.key,
				error,
			});
		}
	}

	plans.sort((a, b) => a.flag.key.localeCompare(b.flag.key));
	if (discoveryFailures.length > 0) {
		discovery.warn(
			`Found ${plans.length} matching flag(s); ${discoveryFailures.length} flag(s) could not be inspected`,
		);
		for (const failure of discoveryFailures) {
			console.error(
				chalk.red(`  ${failure.flagKey}: ${formatAxiosError(failure.error)}`),
			);
		}
		process.exitCode = 1;
	} else {
		discovery.succeed(`Found ${plans.length} flag(s) with matching attributes`);
	}

	if (plans.length === 0) {
		console.log(
			chalk.yellow('\nNo active flags have slashes in inline attributes.'),
		);
		return;
	}

	const selectedPlans = await selectPlans(plans);
	if (selectedPlans === null) throw new PromptCancelledError();
	if (selectedPlans.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to change.'));
		return;
	}

	printPreview(selectedPlans);
	if (args.dryRun) {
		console.log(chalk.yellow('Dry run complete — no changes were written.'));
		return;
	}

	const environmentCount = selectedPlans.reduce(
		(total, plan) => total + plan.environments.length,
		0,
	);
	const changeCount = selectedPlans.reduce(
		(total, plan) => total + targetingAttributeChangeCount(plan),
		0,
	);
	const shouldApply = await confirm({
		message: `Apply ${changeCount} attribute change(s) across ${selectedPlans.length} flag(s) and ${environmentCount} environment(s)?`,
		default: false,
	});
	if (!shouldApply) {
		console.log(chalk.yellow('\nTargeting attribute cleanup cancelled.'));
		return;
	}

	const progress = spinner().start();
	const result = await applyTargetingAttributePlans(
		selectedPlans,
		(plan, environment) =>
			overwriteFlagAllocationsForEnvironment(
				apiKey,
				appKey,
				plan.flag.id,
				environment.environmentId,
				environment.allocations,
				site,
			),
		(plan, environment, index, total) => {
			progress.text = `Updating ${plan.flag.key} in ${environment.environmentName} (${index}/${total})…`;
		},
	);

	try {
		for (const failure of result.failures) {
			console.error(
				chalk.red(
					`\n${failure.flagKey} / ${failure.environmentName}: ${formatAxiosError(failure.error)}`,
				),
			);
		}

		const summary = `${result.updated} updated, ${result.approvalRequested} approval requested, ${result.failures.length} failed`;
		if (result.failures.length > 0) {
			progress.warn(`Targeting attribute cleanup completed: ${summary}`);
			process.exitCode = 1;
		} else {
			progress.succeed(`Targeting attribute cleanup completed: ${summary}`);
		}
	} finally {
		await exportTargetingAttributeCleanupToXlsx(
			result.environmentResults,
			organizationName,
			discoveryFailures,
		);
	}
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
