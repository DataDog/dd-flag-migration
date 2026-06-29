import type { DatadogEnvironment } from '../types.js';
import type { EppoFlag, EppoFlagEnvironment } from './types.js';

// Resolves --env-map CLI pairs (source,target) against the actually-available
// Eppo and Datadog environments. Throws with a helpful message if either side
// of a pair doesn't exist.
export function resolveEppoEnvMap(
	pairs: Array<[string, string]>,
	eppoEnvs: EppoFlagEnvironment[],
	datadogEnvs: DatadogEnvironment[],
): {
	envMapping: Map<number, DatadogEnvironment>;
	selectedEnvs: EppoFlagEnvironment[];
} {
	const envMapping = new Map<number, DatadogEnvironment>();
	const selectedEnvs: EppoFlagEnvironment[] = [];
	const ddByName = new Map(datadogEnvs.map((e) => [e.name, e]));
	for (const [src, dst] of pairs) {
		const eppoEnv = eppoEnvs.find((e) => e.name === src);
		if (!eppoEnv) {
			const available = eppoEnvs.map((e) => e.name).join(', ');
			throw new Error(
				`Eppo environment not found: "${src}". Available: ${available}`,
			);
		}
		const ddEnv = ddByName.get(dst);
		if (!ddEnv) {
			const available = datadogEnvs.map((e) => e.name).join(', ');
			throw new Error(
				`Datadog environment not found: "${dst}". Available: ${available}`,
			);
		}
		envMapping.set(eppoEnv.id, ddEnv);
		selectedEnvs.push(eppoEnv);
	}
	return { envMapping, selectedEnvs };
}

// Resolves --feature-flag CLI keys against the available Eppo flags. Optionally
// requires each flag to be present in at least one mapped Eppo environment.
export function resolveEppoFlags(
	keys: string[],
	allFlags: EppoFlag[],
	selectedEnvIds?: Set<number>,
): EppoFlag[] {
	const byKey = new Map(allFlags.map((f) => [f.key, f]));
	const selected: EppoFlag[] = [];
	const missing: string[] = [];
	for (const key of keys) {
		const f = byKey.get(key);
		if (f) selected.push(f);
		else missing.push(key);
	}
	if (missing.length > 0) {
		throw new Error(`Flag(s) not found in Eppo: ${missing.join(', ')}`);
	}
	if (selectedEnvIds && selectedEnvIds.size > 0) {
		const noEnv = selected.filter(
			(f) => !f.environments?.some((e) => selectedEnvIds.has(e.id)),
		);
		if (noEnv.length > 0) {
			throw new Error(
				`Flag(s) not present in any mapped Eppo environment: ${noEnv.map((f) => f.key).join(', ')}`,
			);
		}
	}
	return selected;
}
