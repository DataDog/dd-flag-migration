#!/usr/bin/env node
import chalk from 'chalk';
import type {
	PermissionChangeResult,
	PermissionOperation,
} from './advanced-permissions/types.js';
import { exportAdvancedPermissionChangesToXlsx } from './advanced-permissions/xlsx.js';
import { confirm } from './components/Confirm.js';
import { filterableCheckbox } from './components/FilterableCheckbox.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { input } from './components/Input.js';
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
import { getDatadogSite, saveDatadogSite } from './helpers/config.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';

const REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'teams_read',
	'restriction_policies_read',
] as const;

const OPERATIONS = [
	{ name: 'Add teams to flags', value: 'add' },
	{ name: 'Remove teams from flags', value: 'remove' },
] as const;

async function promptForDatadogSite(): Promise<string> {
	const stored = getDatadogSite();
	if (stored) {
		const useStored = await confirm({
			message: `Use your saved Datadog site (${stored})?`,
			default: true,
		});
		if (useStored) return stored;
	}

	console.log(
		chalk.gray('  (e.g. "datadoghq.com", "datadoghq.eu", "us5.datadoghq.com")'),
	);
	const site = await input({
		message: 'Which Datadog site does your org use?',
		default: 'datadoghq.com',
		validate: (value) =>
			value.trim().length > 0 ? true : 'Site cannot be empty',
	});
	const trimmed = site.trim();
	saveDatadogSite(trimmed);
	console.log(chalk.gray('  Site saved for future sessions.\n'));
	return trimmed;
}

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
	await renderStatic(
		<Header subtitle={HEADER_SUBTITLES.advancedPermissions} />,
	);
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

	const pairCount = selectedFlags.length * selectedTeams.length;
	const shouldContinue = await confirm({
		message: `${operation === 'add' ? 'Add' : 'Remove'} ${selectedTeams.length} team(s) ${operation === 'add' ? 'to' : 'from'} ${selectedFlags.length} flag(s) (${pairCount} flag/team change(s))?`,
		default: operation === 'add',
	});
	if (!shouldContinue) {
		console.log(chalk.yellow('\nPermission update cancelled.'));
		return;
	}

	const results: PermissionChangeResult[] = [];
	const progress = spinner().start();
	for (let index = 0; index < selectedFlags.length; index++) {
		const flag = selectedFlags[index];
		progress.text = `${operation === 'add' ? 'Adding' : 'Removing'} teams for ${flag.key} (${index + 1}/${selectedFlags.length})…`;
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
			for (const team of selectedTeams) {
				results.push(
					resultForTeam(flag, team, operation, changedIds.has(team.id)),
				);
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
	const failedCount = results.filter(
		(result) => result.status === 'Failed',
	).length;
	if (failedCount > 0) {
		progress.warn(
			`Permission update finished with ${failedCount} failed flag/team result(s)`,
		);
	} else {
		progress.succeed(
			`Permission update complete: ${changedCount} changed, ${unchangedCount} unchanged`,
		);
	}

	await exportAdvancedPermissionChangesToXlsx(results, operation);
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
