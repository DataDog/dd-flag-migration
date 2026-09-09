import axios from 'axios';
import chalk from 'chalk';
import { confirm } from '../components/Confirm.js';
import { filterableCheckbox } from '../components/FilterableCheckbox.js';
import { HEADER_SUBTITLES, Header } from '../components/Header.js';
import { renderStatic } from '../components/mount.js';
import { select } from '../components/Select.js';
import { spinner } from '../components/Spinner.js';
import { fetchDatadogFlags } from '../datadog/api.js';
import type {
	DatadogDistributionChannel,
	DatadogFlagEntry,
} from '../datadog/types.js';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import {
	type DistributionChannelSyncItem,
	type DistributionChannelSyncOutcome,
	executeDistributionChannelSync,
} from '../helpers/sync-distribution-channel.js';
import { exportDistributionChannelSyncToXlsx } from '../sync-distribution-channel/xlsx.js';
import { fetchFlags, fetchProjects, type LDProject } from './api.js';
import { classifyConflict, selectProject } from './migrate.js';
import type { LDFlag } from './types.js';

export function resolveDistributionChannelItems(
	flags: LDFlag[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
): DistributionChannelSyncItem[] {
	const items: DistributionChannelSyncItem[] = [];
	for (const flag of flags) {
		const conflict = classifyConflict(datadogFlags, projectKey, flag.key);
		if (
			(conflict.type === 'same_project' || conflict.type === 'manual') &&
			conflict.existingFlag
		) {
			items.push({
				sourceKey: flag.key,
				datadogKey: conflict.existingFlag.key,
				datadogFlagId: conflict.existingFlag.id,
				currentChannel: conflict.existingFlag.distributionChannel,
			});
		}
	}
	return items.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

async function selectMatchedFlags(
	items: DistributionChannelSyncItem[],
): Promise<DistributionChannelSyncItem[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox<DistributionChannelSyncItem>({
		message: 'Select flags to update:',
		choices: items.map((item) => ({
			name: `${item.sourceKey}  ${chalk.gray(`(${item.currentChannel ?? 'channel unknown'})`)}`,
			value: item,
			searchTerms: [
				item.sourceKey,
				item.datadogKey,
				item.currentChannel ?? 'unknown',
			],
		})),
		pageSize,
	});
}

async function selectTargetChannel(): Promise<DatadogDistributionChannel> {
	return select<DatadogDistributionChannel>({
		message: 'What should the distribution channel be changed to?',
		choices: [
			{ name: 'Client', value: 'CLIENT' },
			{ name: 'Server', value: 'SERVER' },
			{ name: 'Both', value: 'ALL' },
		],
	});
}

function formatSyncStatus(
	outcome: DistributionChannelSyncOutcome,
	dryRun: boolean,
): string {
	if (outcome.status === 'failed') return `${chalk.red('✗')} Failed`;
	if (outcome.status === 'unchanged') return `${chalk.gray('•')} Unchanged`;
	if (dryRun) return `${chalk.dim('[dry run]')} Would update`;
	return `${chalk.green('✓')} Updated`;
}

async function loadData(
	ldApiKey: string,
	project: LDProject,
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
): Promise<{
	flags: LDFlag[];
	datadogFlags: DatadogFlagEntry[];
}> {
	const loading = spinner('Fetching LaunchDarkly and Datadog flags…').start();
	try {
		const [flags, datadogFlags] = await Promise.all([
			fetchFlags(ldApiKey, project.key),
			fetchDatadogFlags(ddApiKey, ddAppKey, ddSite),
		]);
		loading.succeed(
			`Loaded ${flags.length} LaunchDarkly flag(s) and ${datadogFlags.length} Datadog flag(s)`,
		);
		return { flags, datadogFlags };
	} catch (error) {
		loading.fail('Failed to load flags');
		throw error;
	}
}

export async function runLaunchDarklyDistributionChannelSync(
	ddApiKey: string,
	ddAppKey: string,
	ddSite: string,
	dryRun: boolean,
): Promise<void> {
	// LAUNCHDARKLY_API_KEY is validated by the command entrypoint.
	// biome-ignore lint/style/noNonNullAssertion: validated before this function
	const ldApiKey = process.env.LAUNCHDARKLY_API_KEY!.trim();
	const projectLoading = spinner('Fetching LaunchDarkly projects…').start();
	let projects: LDProject[];
	try {
		projects = await fetchProjects(ldApiKey);
		projectLoading.succeed(`Found ${projects.length} LaunchDarkly project(s)`);
	} catch (error) {
		projectLoading.fail('Failed to fetch LaunchDarkly projects');
		if (axios.isAxiosError(error)) {
			console.error(chalk.red(`  ${formatAxiosError(error)}`));
		}
		return;
	}

	if (projects.length === 0) {
		console.log(chalk.yellow('\nNo LaunchDarkly projects found.'));
		return;
	}
	const project = await selectProject(projects);
	if (!project) return;

	const { flags, datadogFlags } = await loadData(
		ldApiKey,
		project,
		ddApiKey,
		ddAppKey,
		ddSite,
	);
	const matchedItems = resolveDistributionChannelItems(
		flags,
		datadogFlags,
		project.key,
	);
	if (matchedItems.length === 0) {
		console.log(
			chalk.yellow(
				'\nNo safely matched Datadog flags were found for this project.',
			),
		);
		return;
	}

	while (true) {
		process.stdout.write('\x1Bc');
		await renderStatic(
			<Header subtitle={HEADER_SUBTITLES.distributionChannel} />,
		);
		console.log(
			`${chalk.bold('Project:')} ${chalk.green(project.name)} ${chalk.gray(`(${project.key})`)}`,
		);
		if (dryRun) {
			console.log(chalk.bold.yellow('Dry run mode — no flags will be changed'));
		}
		console.log();

		const selectedItems = await selectMatchedFlags(matchedItems);
		if (selectedItems === null) return;
		if (selectedItems.length === 0) {
			console.log(chalk.yellow('\nNo flags selected — nothing to update.'));
			continue;
		}
		const targetChannel = await selectTargetChannel();
		const shouldContinue = await confirm({
			message: `${dryRun ? 'Preview' : 'Set'} ${selectedItems.length} flag(s) to ${targetChannel}? This flag-level setting applies across all environments.`,
			default: true,
		});
		if (!shouldContinue) continue;

		const progress = spinner().start();
		const summary = await executeDistributionChannelSync(
			selectedItems,
			targetChannel,
			ddApiKey,
			ddAppKey,
			ddSite,
			dryRun,
			{
				onProgress: (index, total, item) => {
					progress.text = `${dryRun ? 'Previewing' : 'Updating'} ${item.sourceKey} (${index}/${total})…`;
				},
			},
		);
		if (summary.failed > 0) {
			progress.warn(
				`Channel sync finished with ${summary.failed} failed: ${summary.updated} ${dryRun ? 'would update' : 'updated'}, ${summary.unchanged} unchanged`,
			);
			process.exitCode = 1;
		} else {
			progress.succeed(
				`Channel sync complete: ${summary.updated} ${dryRun ? 'would update' : 'updated'}, ${summary.unchanged} unchanged`,
			);
		}
		for (const result of summary.results) {
			const status = formatSyncStatus(result, dryRun);
			const transition = `${result.currentChannel ?? 'Unknown'} → ${result.targetChannel}`;
			console.log(
				`  ${status} ${chalk.cyan(result.sourceKey)} — ${transition}${result.error ? chalk.red(`: ${result.error}`) : ''}`,
			);
		}
		await exportDistributionChannelSyncToXlsx(summary);

		if (!dryRun) {
			for (const result of summary.results) {
				if (result.status === 'updated') {
					const item = matchedItems.find(
						(candidate) => candidate.datadogFlagId === result.datadogFlagId,
					);
					if (item) item.currentChannel = targetChannel;
				}
			}
		}
		const action = await select<'update-more' | 'done'>({
			message: 'What would you like to do?',
			choices: [
				{ name: 'Select more flags', value: 'update-more' },
				{ name: 'Done', value: 'done' },
			],
		});
		if (action === 'done') return;
	}
}
