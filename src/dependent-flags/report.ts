import type { LDProject } from '../launchdarkly/api.js';
import type { LDEnvironment, LDFlag } from '../launchdarkly/types.js';

export interface DependentFlagReportRow {
	projectKey: string;
	datadogOrg: string;
	environmentName: string;
	environmentKey: string;
	dependentFlagName: string;
	dependentFlagKey: string;
	prerequisiteFlagName: string;
	prerequisiteFlagKey: string;
	requiredVariationIndex: number;
	requiredVariationName: string;
	requiredVariationValue: unknown;
	owner: string;
	unresolved: boolean;
}

export function formatLaunchDarklyOwner(flag: LDFlag): string {
	if (flag._maintainerTeam) return flag._maintainerTeam.name;
	if (flag.maintainerTeamKey) return flag.maintainerTeamKey;
	if (flag._maintainer) {
		const displayName = [flag._maintainer.firstName, flag._maintainer.lastName]
			.filter(Boolean)
			.join(' ');
		return displayName || flag._maintainer.email;
	}
	return flag.maintainerId ?? '';
}

export function buildDependentFlagRows(
	project: LDProject,
	environment: LDEnvironment,
	flags: LDFlag[],
	datadogOrg: string,
): DependentFlagReportRow[] {
	const flagsByKey = new Map(flags.map((flag) => [flag.key, flag]));
	const rows: DependentFlagReportRow[] = [];

	for (const dependentFlag of flags) {
		if (dependentFlag.archived) continue;
		const prerequisites =
			dependentFlag.environments?.[environment.key]?.prerequisites ?? [];

		for (const prerequisite of prerequisites) {
			const prerequisiteFlag = flagsByKey.get(prerequisite.key);
			const requiredVariation =
				prerequisiteFlag?.variations[prerequisite.variation];

			rows.push({
				projectKey: project.key,
				datadogOrg,
				environmentName: environment.name,
				environmentKey: environment.key,
				dependentFlagName: dependentFlag.name,
				dependentFlagKey: dependentFlag.key,
				prerequisiteFlagName: prerequisiteFlag?.name ?? '',
				prerequisiteFlagKey: prerequisite.key,
				requiredVariationIndex: prerequisite.variation,
				requiredVariationName: requiredVariation?.name ?? '',
				requiredVariationValue:
					requiredVariation === undefined ? '' : requiredVariation.value,
				owner: formatLaunchDarklyOwner(dependentFlag),
				unresolved:
					prerequisiteFlag === undefined || requiredVariation === undefined,
			});
		}
	}

	return rows.sort(compareDependentFlagRows);
}

export function compareDependentFlagRows(
	a: DependentFlagReportRow,
	b: DependentFlagReportRow,
): number {
	return (
		a.projectKey.localeCompare(b.projectKey) ||
		a.environmentName.localeCompare(b.environmentName) ||
		a.dependentFlagName.localeCompare(b.dependentFlagName) ||
		a.prerequisiteFlagName.localeCompare(b.prerequisiteFlagName) ||
		a.prerequisiteFlagKey.localeCompare(b.prerequisiteFlagKey)
	);
}
