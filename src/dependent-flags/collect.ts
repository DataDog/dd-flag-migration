import {
	fetchAllProjectEnvironments,
	fetchFlagsForEnvironment,
	type LDProject,
} from '../launchdarkly/api.js';
import type { LDEnvironment } from '../launchdarkly/types.js';
import {
	buildDependentFlagRows,
	compareDependentFlagRows,
	type DependentFlagReportRow,
} from './report.js';

export interface DependentFlagCollectionProgress {
	project: LDProject;
	environment: LDEnvironment;
	completed: number;
	total: number;
}

async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const item = items[nextIndex++];
				await run(item);
			}
		},
	);
	await Promise.all(workers);
}

export async function collectDependentFlagRows(
	apiKey: string,
	projects: LDProject[],
	datadogOrg: string,
	onProgress?: (progress: DependentFlagCollectionProgress) => void,
): Promise<DependentFlagReportRow[]> {
	const rows: DependentFlagReportRow[] = [];

	for (const project of projects) {
		const environments = (
			await fetchAllProjectEnvironments(apiKey, project.key)
		).filter((environment) => !environment.archived);
		let completed = 0;

		await mapWithConcurrency(environments, 3, async (environment) => {
			const flags = await fetchFlagsForEnvironment(
				apiKey,
				project.key,
				environment.key,
			);
			rows.push(
				...buildDependentFlagRows(project, environment, flags, datadogOrg),
			);
			completed++;
			onProgress?.({
				project,
				environment,
				completed,
				total: environments.length,
			});
		});
	}

	return rows.sort(compareDependentFlagRows);
}
