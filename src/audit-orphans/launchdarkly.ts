import type { DatadogFlagEntry } from '../datadog/types.js';
import type { LDFlag } from '../launchdarkly/types.js';

export interface LaunchDarklyFlagComparison {
	datadogExclusiveKeys: string[];
	launchDarklyExclusiveKeys: string[];
}

function findMatchingLaunchDarklyKey(
	flag: DatadogFlagEntry,
	launchDarklyKeys: Set<string>,
	projectKey: string,
): string | undefined {
	if (launchDarklyKeys.has(flag.key)) {
		return flag.key;
	}

	const metadata = flag.migration_metadata;
	if (
		metadata?.project_key === projectKey &&
		metadata.flag_key &&
		launchDarklyKeys.has(metadata.flag_key)
	) {
		return metadata.flag_key;
	}

	return undefined;
}

/**
 * Compare active Datadog flags with one LaunchDarkly project.
 *
 * A Datadog flag matches by its own key or by LaunchDarkly migration metadata.
 * The metadata fallback prevents a deliberately renamed Datadog flag from
 * appearing as exclusive on both sides.
 */
export function compareLaunchDarklyFlagKeys(
	datadogFlags: DatadogFlagEntry[],
	launchDarklyFlags: LDFlag[],
	projectKey: string,
): LaunchDarklyFlagComparison {
	const launchDarklyKeys = new Set(launchDarklyFlags.map((flag) => flag.key));
	const matchedLaunchDarklyKeys = new Set<string>();
	const datadogExclusiveKeys: string[] = [];

	for (const flag of datadogFlags) {
		const matchingLaunchDarklyKey = findMatchingLaunchDarklyKey(
			flag,
			launchDarklyKeys,
			projectKey,
		);

		if (matchingLaunchDarklyKey) {
			matchedLaunchDarklyKeys.add(matchingLaunchDarklyKey);
		} else {
			datadogExclusiveKeys.push(flag.key);
		}
	}

	return {
		datadogExclusiveKeys: datadogExclusiveKeys.sort((a, b) =>
			a.localeCompare(b),
		),
		launchDarklyExclusiveKeys: [...launchDarklyKeys]
			.filter((key) => !matchedLaunchDarklyKeys.has(key))
			.sort((a, b) => a.localeCompare(b)),
	};
}
