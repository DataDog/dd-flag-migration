import type { DatadogEnvironment } from '../types.js';
import type { LDEnvironment } from './types.js';

// Resolves --env-map CLI pairs (source,target) against the project's LD
// environments and the org's Datadog environments. LD env matching prefers
// `key` (the API identifier) and falls back to `name` (display label).
export function resolveLDEnvMap(
	pairs: Array<[string, string]>,
	ldEnvironments: LDEnvironment[],
	datadogEnvs: DatadogEnvironment[],
): { envMapping: Map<string, DatadogEnvironment>; selectedEnvKeys: string[] } {
	const envMapping = new Map<string, DatadogEnvironment>();
	const selectedEnvKeys: string[] = [];
	const ddByName = new Map(datadogEnvs.map((e) => [e.name, e]));
	for (const [src, dst] of pairs) {
		const ldEnv =
			ldEnvironments.find((e) => e.key === src) ??
			ldEnvironments.find((e) => e.name === src);
		if (!ldEnv) {
			const available = ldEnvironments
				.filter((e) => !e.archived)
				.map((e) => (e.key === e.name ? e.key : `${e.key} (${e.name})`))
				.join(', ');
			throw new Error(
				`LaunchDarkly environment not found: "${src}". Available: ${available}`,
			);
		}
		if (ldEnv.archived) {
			throw new Error(
				`LaunchDarkly environment "${ldEnv.key}" is archived and cannot be migrated`,
			);
		}
		const ddEnv = ddByName.get(dst);
		if (!ddEnv) {
			const available = datadogEnvs.map((e) => e.name).join(', ');
			throw new Error(
				`Datadog environment not found: "${dst}". Available: ${available}`,
			);
		}
		envMapping.set(ldEnv.key, ddEnv);
		selectedEnvKeys.push(ldEnv.key);
	}
	return { envMapping, selectedEnvKeys };
}
