import { updateFlagTags } from '../datadog/api.js';
import type { DatadogTeam } from '../datadog/types.js';
import type { PermissionOperation } from './types.js';

export interface TeamTagUpdatePlan {
	tags: string[];
	changedTeamIds: string[];
	unchangedTeamIds: string[];
}

export function teamTagForTeam(team: DatadogTeam): string {
	return `team:${team.handle}`;
}

export function planTeamTagUpdate(
	existingTags: string[],
	teams: DatadogTeam[],
	operation: PermissionOperation,
): TeamTagUpdatePlan {
	const selectedTags = new Map(
		teams.map((team) => [team.id, teamTagForTeam(team)]),
	);
	const existingTagSet = new Set(existingTags);
	const changedTeamIds = teams
		.filter((team) =>
			operation === 'add'
				? !existingTagSet.has(selectedTags.get(team.id) as string)
				: existingTagSet.has(selectedTags.get(team.id) as string),
		)
		.map((team) => team.id);
	const changedTeamIdSet = new Set(changedTeamIds);
	const unchangedTeamIds = teams
		.filter((team) => !changedTeamIdSet.has(team.id))
		.map((team) => team.id);

	if (operation === 'add') {
		return {
			tags: [
				...existingTags,
				...teams
					.filter((team) => changedTeamIdSet.has(team.id))
					.map(teamTagForTeam),
			],
			changedTeamIds,
			unchangedTeamIds,
		};
	}

	const tagsToRemove = new Set(selectedTags.values());
	return {
		tags: existingTags.filter((tag) => !tagsToRemove.has(tag)),
		changedTeamIds,
		unchangedTeamIds,
	};
}

/** Add or remove matching team:<handle> tags while preserving unrelated tags. */
export async function syncFlagTeamTags(
	apiKey: string,
	appKey: string,
	flagId: string,
	existingTags: string[],
	teams: DatadogTeam[],
	operation: PermissionOperation,
	site = 'datadoghq.com',
): Promise<TeamTagUpdatePlan> {
	const plan = planTeamTagUpdate(existingTags, teams, operation);
	if (plan.changedTeamIds.length > 0) {
		await updateFlagTags(apiKey, appKey, flagId, plan.tags, site);
	}
	return plan;
}
