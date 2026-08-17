#!/usr/bin/env node
import chalk from 'chalk';
import { syncFlagTeamTags } from './bulk-permissions/team-tags.js';
import type {
	PermissionChangeResult,
	PermissionOperation,
	TagSyncResult,
} from './bulk-permissions/types.js';
import { exportBulkPermissionChangesToXlsx } from './bulk-permissions/xlsx.js';
import { confirm } from './components/Confirm.js';
import { filterableCheckbox } from './components/FilterableCheckbox.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { PermissionsError } from './components/PermissionsError.js';
import { select } from './components/Select.js';
import { spinner } from './components/Spinner.js';
import {
	fetchCurrentUserIdentity,
	fetchCurrentUserPermissions,
	fetchDatadogFlags,
	fetchDatadogTeams,
	fetchFlagTags,
	RestrictionPolicyTeamUpdateError,
	updateRestrictionPolicyTeams,
} from './datadog/api.js';
import type { DatadogFlagEntry, DatadogTeam } from './datadog/types.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';

const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'teams_read',
	'restriction_policies_read',
] as const;

const OPERATIONS = [
	{ name: 'Add teams to flags', value: 'add' },
	{ name: 'Remove teams from flags', value: 'remove' },
] as const;

async function checkRequiredPermissions(
	apiKey: string,
	appKey: string,
	site: string,
): Promise<void> {
	const actual = await fetchCurrentUserPermissions(apiKey, appKey, site);
	const missing = REQUIRED_PERMISSIONS.filter(
		(permission) => !actual.includes(permission),
	);
	if (missing.length > 0) {
		await renderStatic(<PermissionsError missing={missing} />);
		process.exit(1);
	}
}

function isMigratedFlag(flag: DatadogFlagEntry): boolean {
	return flag.migration_metadata !== undefined;
}

async function loadMigratedFlagsWithTags(
	apiKey: string,
	appKey: string,
	site: string,
): Promise<DatadogFlagEntry[]> {
	const flags = (await fetchDatadogFlags(apiKey, appKey, site)).filter(
		isMigratedFlag,
	);
	for (const flag of flags) {
		if (flag.tags === undefined) {
			flag.tags = await fetchFlagTags(apiKey, appKey, flag.id, site);
		}
	}
	return flags.sort((a, b) => a.key.localeCompare(b.key));
}

async function selectFlags(
	flags: DatadogFlagEntry[],
): Promise<DatadogFlagEntry[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox<DatadogFlagEntry>({
		message: 'Select migrated flags to update:',
		choices: flags.map((flag) => {
			const tags = flag.tags ?? [];
			return {
				name:
					flag.key +
					(tags.length > 0 ? chalk.gray(`  (${tags.join(', ')})`) : ''),
				value: flag,
				searchTerms: [flag.key, ...tags],
			};
		}),
		pageSize,
	});
}

async function selectTeams(
	teams: DatadogTeam[],
): Promise<DatadogTeam[] | null> {
	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);
	return filterableCheckbox<DatadogTeam>({
		message: 'Select teams:',
		choices: teams
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((team) => ({
				name: `${team.name}  ${chalk.gray(`(${team.handle})`)}`,
				value: team,
				searchTerms: [team.name, team.handle],
			})),
		pageSize,
	});
}

function resultForTeam(
	flag: DatadogFlagEntry,
	team: DatadogTeam,
	operation: PermissionOperation,
	changed: boolean,
	error?: string,
): PermissionChangeResult {
	return {
		flagId: flag.id,
		flagKey: flag.key,
		flagTags: flag.tags ?? [],
		teamId: team.id,
		teamName: team.name,
		teamHandle: team.handle,
		operation,
		status: error
			? 'Failed'
			: operation === 'add'
				? changed
					? 'Added'
					: 'Already present'
				: changed
					? 'Removed'
					: 'Not present',
		...(error ? { error } : {}),
	};
}

async function main(): Promise<void> {
	const env = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const apiKey = env.DD_API_KEY;
	const appKey = env.DD_APP_KEY;

	process.stdout.write('\x1Bc');
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.bulkPermissions} />);
	const site = await promptForDatadogSite();
	await checkRequiredPermissions(apiKey, appKey, site);

	const operation = await select<PermissionOperation>({
		message: 'What would you like to do?',
		choices: OPERATIONS.map((item) => ({
			name: item.name,
			value: item.value,
		})),
	});

	const loading = spinner('Fetching migrated flags and Datadog teams…').start();
	let flags: DatadogFlagEntry[];
	let teams: DatadogTeam[];
	let userId = '';
	let orgId = '';
	try {
		[flags, teams] = await Promise.all([
			loadMigratedFlagsWithTags(apiKey, appKey, site),
			fetchDatadogTeams(apiKey, appKey, site),
		]);
		if (operation === 'add') {
			({ userId, orgId } = await fetchCurrentUserIdentity(
				apiKey,
				appKey,
				site,
			));
		}
		loading.succeed(
			`Found ${flags.length} migrated flag(s) and ${teams.length} team(s)`,
		);
	} catch (error) {
		loading.fail('Could not load flags and teams');
		throw error;
	}

	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo migrated Datadog flags were found.'));
		return;
	}
	if (teams.length === 0) {
		console.log(chalk.yellow('\nNo Datadog teams were found.'));
		return;
	}

	const selectedFlags = await selectFlags(flags);
	if (selectedFlags === null) throw new PromptCancelledError();
	if (selectedFlags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to update.'));
		return;
	}

	const selectedTeams = await selectTeams(teams);
	if (selectedTeams === null) throw new PromptCancelledError();
	if (selectedTeams.length === 0) {
		console.log(chalk.yellow('\nNo teams selected — nothing to update.'));
		return;
	}

	const syncTeamTags = await confirm({
		message: `${operation === 'add' ? 'Add' : 'Remove'} matching team:<handle> tags too?`,
		default: true,
	});

	const pairCount = selectedFlags.length * selectedTeams.length;
	const shouldContinue = await confirm({
		message: `${operation === 'add' ? 'Add' : 'Remove'} ${selectedTeams.length} team(s) ${operation === 'add' ? 'to' : 'from'} ${selectedFlags.length} flag(s) (${pairCount} flag/team change(s))${syncTeamTags ? ' and sync team tags' : ''}?`,
		default: operation === 'add',
	});
	if (!shouldContinue) {
		console.log(chalk.yellow('\nPermission update cancelled.'));
		return;
	}

	const results: PermissionChangeResult[] = [];
	const tagSyncResults: TagSyncResult[] = [];
	const targetedTeamTags = selectedTeams.map((team) => `team:${team.handle}`);
	let tagUpdatedFlagCount = 0;
	const progress = spinner().start();
	for (let index = 0; index < selectedFlags.length; index++) {
		const flag = selectedFlags[index];
		progress.text = `${operation === 'add' ? 'Adding' : 'Removing'} teams${syncTeamTags ? ' and syncing tags' : ''} for ${flag.key} (${index + 1}/${selectedFlags.length})…`;
		try {
			const update = await updateRestrictionPolicyTeams(
				apiKey,
				appKey,
				flag.id,
				selectedTeams.map((team) => team.id),
				operation,
				userId,
				orgId,
				site,
			);
			const changedIds = new Set(update.changedTeamIds);
			const permissionResults = selectedTeams.map((team) =>
				resultForTeam(flag, team, operation, changedIds.has(team.id)),
			);
			results.push(...permissionResults);

			if (syncTeamTags) {
				try {
					const tagUpdate = await syncFlagTeamTags(
						apiKey,
						appKey,
						flag.id,
						flag.tags ?? [],
						selectedTeams,
						operation,
						site,
					);
					flag.tags = tagUpdate.tags;
					for (const result of permissionResults) {
						result.flagTags = tagUpdate.tags;
					}
					const changed = tagUpdate.changedTeamIds.length > 0;
					if (changed) tagUpdatedFlagCount++;
					tagSyncResults.push({
						flagId: flag.id,
						flagKey: flag.key,
						targetedTags: targetedTeamTags,
						operation,
						status: changed ? 'Updated' : 'Already synced',
					});
				} catch (error) {
					tagSyncResults.push({
						flagId: flag.id,
						flagKey: flag.key,
						targetedTags: targetedTeamTags,
						operation,
						status: 'Failed',
						error: formatAxiosError(error),
					});
				}
			}
		} catch (error) {
			const failedUpdate =
				error instanceof RestrictionPolicyTeamUpdateError ? error : undefined;
			const unchangedIds = new Set(
				failedUpdate?.updateResult.unchangedTeamIds ?? [],
			);
			const message = formatAxiosError(failedUpdate?.originalError ?? error);
			for (const team of selectedTeams) {
				results.push(
					unchangedIds.has(team.id)
						? resultForTeam(flag, team, operation, false)
						: resultForTeam(flag, team, operation, false, message),
				);
			}
		}
	}

	const changedCount = results.filter(
		(result) => result.status === 'Added' || result.status === 'Removed',
	).length;
	const unchangedCount = results.filter(
		(result) =>
			result.status === 'Already present' || result.status === 'Not present',
	).length;
	const permissionFailedCount = results.filter(
		(result) => result.status === 'Failed',
	).length;
	const tagFailedCount = tagSyncResults.filter(
		(result) => result.status === 'Failed',
	).length;
	if (permissionFailedCount > 0 || tagFailedCount > 0) {
		const failures = [
			...(permissionFailedCount > 0
				? [`${permissionFailedCount} failed permission result(s)`]
				: []),
			...(tagFailedCount > 0
				? [`${tagFailedCount} failed team-tag sync(s)`]
				: []),
		];
		progress.warn(`Bulk update finished with ${failures.join(' and ')}`);
	} else {
		progress.succeed(
			`Permission update complete: ${changedCount} changed, ${unchangedCount} unchanged${syncTeamTags ? `; team tags synced on ${tagUpdatedFlagCount} flag(s)` : ''}`,
		);
	}

	await exportBulkPermissionChangesToXlsx(results, operation, tagSyncResults);
	if (permissionFailedCount > 0 || tagFailedCount > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
