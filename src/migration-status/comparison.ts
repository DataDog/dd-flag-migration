import type {
	DatadogAllocationForFlagCreation,
	DatadogStatusAllocation,
	DatadogStatusFlagDetail,
	DatadogVariantDetail,
} from '../datadog/types.js';
import {
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	buildVariants,
	remapAllocationKeys,
	resolveDatadogFlagName,
	shouldSkipFlag,
} from '../launchdarkly/helpers/migration.js';
import type { LDFlag } from '../launchdarkly/types.js';
import type {
	ChangeKind,
	EnvironmentStatusResult,
	FlagMigrationStatus,
	FlagStatusResult,
	LinkedFlag,
	MigrationStatusComparisonInput,
	MigrationStatusResult,
} from './types.js';
import { stableJson } from './utils.js';

export function linkLaunchDarklyFlags(
	sourceFlags: LDFlag[],
	datadogFlags: MigrationStatusComparisonInput['datadogFlags'],
	projectKey: string,
): LinkedFlag[] {
	return sourceFlags.map((source) => {
		const metadataMatches = datadogFlags.filter(
			(candidate) =>
				candidate.migration_metadata?.project_key === projectKey &&
				candidate.migration_metadata.flag_key === source.key,
		);
		if (metadataMatches.length === 1) {
			return { source, datadog: metadataMatches[0] };
		}
		if (metadataMatches.length > 1) {
			return {
				source,
				identityProblem:
					'Multiple Datadog flags have matching migration metadata.',
			};
		}

		const sameKeyMatches = datadogFlags.filter(
			(candidate) => candidate.key === source.key,
		);
		if (sameKeyMatches.length > 0) {
			return {
				source,
				datadog: sameKeyMatches[0],
				identityProblem:
					'A same-key Datadog flag exists without matching migration metadata.',
			};
		}
		return { source };
	});
}

export function compareMigrationStatus(
	input: MigrationStatusComparisonInput,
): MigrationStatusResult {
	const mappings = input.selectedSourceEnvironments.flatMap((source) =>
		(input.environmentMapping.get(source.key) ?? []).map((datadog) => ({
			sourceEnvironmentKey: source.key,
			sourceEnvironmentName: source.name,
			datadogEnvironmentId: datadog.id,
			datadogEnvironmentName: datadog.name,
		})),
	);
	const links = linkLaunchDarklyFlags(
		input.sourceFlags,
		input.datadogFlags,
		input.projectKey,
	);
	const flags = links.map((link) => compareFlag(link, input));
	return {
		projectKey: input.projectKey,
		projectName: input.projectName,
		generatedAt: new Date(),
		mappings,
		flags,
		limitations: [
			'Tags, permissions, and restriction policies are not assessed.',
			'Saved-filter references are compared, but saved-filter contents are not assessed.',
			'Current differences do not establish which platform changed after migration.',
		],
	};
}

function compareFlag(
	link: LinkedFlag,
	input: MigrationStatusComparisonInput,
): FlagStatusResult {
	const source = link.source;
	if (link.identityProblem && !link.datadog) {
		return baseFlagResult(source, 'needs-review', {
			details: link.identityProblem,
			flagWideChanges: ['identity'],
			flagWideDetails: [link.identityProblem],
		});
	}
	if (!link.datadog) {
		return baseFlagResult(source, 'not-yet-migrated', {
			details: 'No linked Datadog flag was found.',
		});
	}

	const sourceError = input.sourceDetailErrors.get(source.key);
	if (sourceError) {
		return baseFlagResult(source, 'needs-review', {
			datadogFlagKey: link.datadog.key,
			details: sourceError,
			flagWideChanges: ['collection'],
			flagWideDetails: [sourceError],
		});
	}
	const datadogError = input.datadogDetailErrors.get(link.datadog.id);
	if (datadogError) {
		return baseFlagResult(source, 'needs-review', {
			datadogFlagKey: link.datadog.key,
			details: datadogError,
			flagWideChanges: ['collection'],
			flagWideDetails: [datadogError],
		});
	}
	const actual = input.datadogDetails.get(link.datadog.id);
	if (!actual) {
		return baseFlagResult(source, 'needs-review', {
			datadogFlagKey: link.datadog.key,
			details: 'The linked Datadog flag detail was not available.',
			flagWideChanges: ['collection'],
			flagWideDetails: ['The linked Datadog flag detail was not available.'],
		});
	}

	const flagWideChanges: ChangeKind[] = [];
	const flagWideDetails: string[] = [];
	if (link.identityProblem) {
		flagWideChanges.push('identity');
	}
	const expectedName = resolveDatadogFlagName(
		source.name,
		source.key,
		actual.key,
	);
	if (expectedName !== actual.name) {
		flagWideChanges.push('name');
		flagWideDetails.push('Flag name differs.');
	}
	const variantDetails = compareVariants(source, actual);
	if (variantDetails.length > 0) {
		flagWideChanges.push('variants');
		flagWideDetails.push(...variantDetails);
	}

	const variantAliases = sourceVariantAliases(source, actual.variants);
	const environments = compareEnvironments(
		source,
		actual,
		input,
		variantAliases,
	);
	const status = overallStatus(flagWideChanges, environments);
	return {
		flagKey: source.key,
		flagName: source.name,
		datadogFlagKey: actual.key,
		status,
		flagWideChanges,
		flagWideDetails,
		environments,
	};
}

function baseFlagResult(
	source: LDFlag,
	status: FlagMigrationStatus,
	overrides: Partial<FlagStatusResult>,
): FlagStatusResult {
	return {
		flagKey: source.key,
		flagName: source.name,
		status,
		flagWideChanges: [],
		flagWideDetails: [],
		environments: [],
		...overrides,
	};
}

function compareEnvironments(
	source: LDFlag,
	actual: DatadogStatusFlagDetail,
	input: MigrationStatusComparisonInput,
	variantAliases: ReadonlyMap<string, string>,
): EnvironmentStatusResult[] {
	const output: EnvironmentStatusResult[] = [];
	const actualVariantsById = new Map(
		actual.variants.map((variant) => [variant.id, variant.key]),
	);
	for (const sourceEnvironment of input.selectedSourceEnvironments) {
		const targets = input.environmentMapping.get(sourceEnvironment.key) ?? [];
		const sourceConfiguration = source.environments?.[sourceEnvironment.key];
		for (const datadogEnvironment of targets) {
			const base = {
				sourceEnvironmentKey: sourceEnvironment.key,
				sourceEnvironmentName: sourceEnvironment.name,
				datadogEnvironmentId: datadogEnvironment.id,
				datadogEnvironmentName: datadogEnvironment.name,
			};
			if (!sourceConfiguration) {
				output.push({
					...base,
					status: 'could-not-verify',
					changes: ['collection'],
					details:
						'LaunchDarkly did not return configuration for this environment.',
				});
				continue;
			}
			const actualEnvironment = actual.environments.find(
				(environment) => environment.environmentId === datadogEnvironment.id,
			);
			if (!actualEnvironment) {
				output.push({
					...base,
					status: 'not-migrated',
					changes: ['targeting'],
					details:
						'No Datadog configuration exists for this environment mapping.',
				});
				continue;
			}

			const changes: ChangeKind[] = [];
			const details: string[] = [];
			const expectedEnabled = sourceConfiguration.on;
			const actualEnabled = actualEnvironment.status === 'ENABLED';
			if (expectedEnabled !== actualEnabled) {
				changes.push('enablement');
				details.push(
					`LaunchDarkly is ${expectedEnabled ? 'on' : 'off'} while Datadog is ${actualEnabled ? 'enabled' : 'disabled'}.`,
				);
			}

			// Disabled configurations are reconciled by enablement. Targeting and
			// fallthrough behavior cannot affect evaluation while both sides are off.
			if (!expectedEnabled) {
				output.push({
					...base,
					status: changes.length > 0 ? 'out-of-sync' : 'in-sync',
					changes,
					details:
						details.join(' ') || 'Enablement matches for this environment.',
				});
				continue;
			}
			const skip = shouldSkipFlag(source, [sourceEnvironment.key]);
			if (skip.skip || skip.hasProgressiveRollout) {
				const reason =
					skip.reason ??
					'Progressive rollout state could not be compared safely.';
				output.push({
					...base,
					status: changes.length > 0 ? 'out-of-sync' : 'could-not-verify',
					changes:
						changes.length > 0 ? changes : (['targeting'] as ChangeKind[]),
					details: [...details, reason].join(' '),
				});
				continue;
			}
			// Prerequisites are not enforced in Datadog, but they do not block
			// targeting comparison. Surface the warning and continue.
			if (skip.warn) {
				details.push(skip.warn);
			}

			const singleMapping = new Map([
				[sourceEnvironment.key, [datadogEnvironment]],
			]);
			const defaults = buildDefaultVariantKeyPerEnv(source, singleMapping);
			const allocations = buildAllocations(
				source,
				singleMapping,
				new Map(input.savedFilterLookup ?? []),
				new Map(),
				defaults,
			);
			if ('flagSkip' in allocations) {
				output.push({
					...base,
					status: changes.length > 0 ? 'out-of-sync' : 'could-not-verify',
					changes:
						changes.length > 0 ? changes : (['targeting'] as ChangeKind[]),
					details: [...details, allocations.flagSkip].join(' '),
				});
				continue;
			}

			const expectedDefaultSource = defaults.get(datadogEnvironment.id);
			const expectedDefault = expectedDefaultSource
				? (variantAliases.get(expectedDefaultSource) ?? expectedDefaultSource)
				: undefined;
			if (expectedDefault !== actualEnvironment.defaultVariantKey) {
				changes.push('default');
				details.push('Default variant differs.');
			}

			const remapped = remapAllocationKeys(allocations, source.key, actual.key);
			const expectedTargeting = canonicalExpectedTargeting(
				remapped,
				variantAliases,
			);
			// Datadog returns null when an environment has no explicit targeting
			// filters. The environment itself still exists and may have a default.
			const actualTargeting = canonicalActualTargeting(
				actualEnvironment.allocations ?? [],
				actualVariantsById,
				expectedDefault,
			);
			if (expectedTargeting !== actualTargeting) {
				changes.push('targeting');
				details.push('Targeting filters or rollout weights differ.');
			}

			output.push({
				...base,
				status: changes.length > 0 ? 'out-of-sync' : 'in-sync',
				changes,
				details: details.join(' ') || 'Configuration matches.',
			});
		}
	}
	return output;
}

function sourceVariantAliases(
	source: LDFlag,
	actual: DatadogVariantDetail[],
): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const expected of buildVariants(source)) {
		const bySourceId = actual.find(
			(variant) => variant.migration_metadata?.source_id === expected.sourceId,
		);
		const match =
			bySourceId ?? actual.find((variant) => variant.key === expected.key);
		if (match) aliases.set(expected.key, match.key);
	}
	return aliases;
}

function compareVariants(
	source: LDFlag,
	actual: DatadogStatusFlagDetail,
): string[] {
	const expected = buildVariants(source);
	const unmatched = [...actual.variants];
	const details: string[] = [];
	for (const variant of expected) {
		let index = unmatched.findIndex(
			(candidate) =>
				candidate.migration_metadata?.source_id === variant.sourceId,
		);
		if (index === -1) {
			index = unmatched.findIndex(
				(candidate) =>
					candidate.key === variant.key &&
					candidate.migration_metadata?.source_id === undefined,
			);
		}
		if (index === -1) {
			details.push(`Variant "${variant.name}" is missing from Datadog.`);
			continue;
		}
		const candidate = unmatched[index];
		if (
			candidate.name !== variant.name ||
			normalizeVariantValue(candidate.value) !==
				normalizeVariantValue(variant.value)
		) {
			details.push(`Variant "${variant.name}" differs.`);
		}
		unmatched.splice(index, 1);
	}
	for (const variant of unmatched) {
		details.push(`Datadog has an extra variant "${variant.name}".`);
	}
	return details;
}

function normalizeVariantValue(value: string): string {
	try {
		return stableJson(JSON.parse(value));
	} catch {
		return value;
	}
}

function canonicalExpectedTargeting(
	allocations: DatadogAllocationForFlagCreation[],
	variantAliases: ReadonlyMap<string, string>,
): string {
	return stableJson(
		allocations.map((allocation) => ({
			key: allocation.key,
			rules: (allocation.targeting_rules ?? []).map((rule) =>
				rule.conditions.map(canonicalCondition),
			),
			weights: allocation.variant_weights
				.map((weight) => ({
					variantKey:
						variantAliases.get(weight.variant_key) ?? weight.variant_key,
					value: weight.value,
				}))
				.sort(compareWeights),
		})),
	);
}

function canonicalActualTargeting(
	allocations: DatadogStatusAllocation[],
	variantKeysById: ReadonlyMap<string, string>,
	expectedDefault: string | undefined,
): string {
	return stableJson(
		allocations
			.filter(
				(allocation) =>
					!isEquivalentDefaultFallthrough(
						allocation,
						variantKeysById,
						expectedDefault,
					),
			)
			.map((allocation) => ({
				key: allocation.key,
				rules: (allocation.targeting_rules ?? []).map((rule) =>
					(rule.conditions ?? []).map(canonicalCondition),
				),
				weights: (allocation.variant_weights ?? [])
					.map((weight) => ({
						variantKey:
							weight.variant_key ??
							(weight.variant_id
								? (variantKeysById.get(weight.variant_id) ?? weight.variant_id)
								: undefined),
						value: weight.value,
					}))
					.sort(compareWeights),
			})),
	);
}

function canonicalCondition(condition: {
	operator?: string;
	attribute?: string;
	value?: unknown;
	saved_filter_id?: string;
}): Record<string, unknown> {
	return {
		operator: condition.operator,
		attribute: condition.attribute,
		value: condition.value,
		savedFilterId: condition.saved_filter_id,
	};
}

function compareWeights(
	a: { variantKey?: string; value: number },
	b: { variantKey?: string; value: number },
): number {
	return `${a.variantKey}:${a.value}`.localeCompare(
		`${b.variantKey}:${b.value}`,
	);
}

function isEquivalentDefaultFallthrough(
	allocation: DatadogStatusAllocation,
	variantKeysById: ReadonlyMap<string, string>,
	expectedDefault: string | undefined,
): boolean {
	if (!expectedDefault || !allocation.key.endsWith('-fallthrough'))
		return false;
	if ((allocation.targeting_rules?.length ?? 0) > 0) return false;
	if (allocation.variant_weights?.length !== 1) return false;
	const weight = allocation.variant_weights[0];
	if (!weight || weight.value !== 100) return false;
	const key =
		weight.variant_key ??
		(weight.variant_id ? variantKeysById.get(weight.variant_id) : undefined);
	return key === expectedDefault;
}

function overallStatus(
	flagWideChanges: ChangeKind[],
	environments: EnvironmentStatusResult[],
): FlagMigrationStatus {
	if (
		environments.some((environment) => environment.status === 'not-migrated')
	) {
		return 'partially-migrated';
	}
	if (
		flagWideChanges.some((change) => change !== 'identity') ||
		environments.some((environment) => environment.status === 'out-of-sync')
	) {
		return 'out-of-sync';
	}
	if (
		environments.some(
			(environment) => environment.status === 'could-not-verify',
		)
	) {
		return 'needs-review';
	}
	return 'in-sync';
}
