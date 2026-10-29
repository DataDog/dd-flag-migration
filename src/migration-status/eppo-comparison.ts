import { resolveFlagNameForSync } from '../datadog/flag-names.js';
import type {
	BucketingMode,
	DatadogAllocationForFlagCreation,
	DatadogFlagEntry,
	DatadogStatusAllocation,
	DatadogStatusFlagDetail,
} from '../datadog/types.js';
import {
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	buildVariants,
	findEppoMigrationBlockers,
} from '../eppo/helpers/migration.js';
import type { EppoFlag } from '../eppo/types.js';
import {
	canonicalCondition,
	compareSourceVariants,
	overallStatus,
	sourceVariantAliases,
} from './comparison.js';
import type {
	ChangeKind,
	EnvironmentStatusResult,
	EppoMigrationStatusComparisonInput,
	FlagStatusResult,
	LinkedEppoFlag,
	MigrationStatusResult,
} from './types.js';
import { stableJson } from './utils.js';

export function linkEppoFlags(
	sourceFlags: EppoFlag[],
	datadogFlags: DatadogFlagEntry[],
): LinkedEppoFlag[] {
	return sourceFlags.map((source) => {
		const matches = datadogFlags.filter(
			(flag) =>
				flag.migration_metadata?.provider === 'eppo' &&
				flag.migration_metadata.source_id === String(source.id),
		);
		if (matches.length > 1) {
			return {
				source,
				identityProblem:
					'Multiple Datadog flags have matching Eppo migration metadata.',
			};
		}
		if (matches.length === 1) {
			const datadog = matches[0];
			return {
				source,
				datadog,
				...(datadog.key !== source.key
					? {
							identityProblem:
								'The linked Datadog flag key differs from Eppo. Eppo bucketing requires identical flag keys; re-migration cannot change the Datadog key.',
						}
					: {}),
			};
		}
		const sameKey = datadogFlags.find((flag) => flag.key === source.key);
		return {
			source,
			...(sameKey
				? {
						datadog: sameKey,
						identityProblem:
							'A same-key Datadog flag exists without matching Eppo migration metadata.',
					}
				: {}),
		};
	});
}

export function compareEppoMigrationStatus(
	input: EppoMigrationStatusComparisonInput,
): MigrationStatusResult {
	return {
		sourceProvider: 'eppo',
		projectKey: 'eppo',
		projectName: 'Eppo',
		generatedAt: new Date(),
		mappings: input.selectedSourceEnvironments.flatMap((source) =>
			(input.environmentMapping.get(source.id) ?? []).map((target) => ({
				sourceEnvironmentKey: String(source.id),
				sourceEnvironmentName: source.name,
				datadogEnvironmentId: target.id,
				datadogEnvironmentName: target.name,
			})),
		),
		flags: linkEppoFlags(input.sourceFlags, input.datadogFlags).map((link) =>
			compareFlag(link, input),
		),
		limitations: [
			'Tags, permissions, restriction policies, and JSON schemas are not assessed.',
			'Saved-filter references are compared, but saved-filter contents are not assessed.',
			'Legacy migrations retain Datadog bucketing: matching configuration does not guarantee identical subject assignments in splits or partial rollouts.',
			'Datadog cannot clear an existing default. A removed Eppo default is reported as a difference even though re-migration retains it.',
			'Current differences do not establish which platform changed after migration.',
		],
	};
}

function compareFlag(
	link: LinkedEppoFlag,
	input: EppoMigrationStatusComparisonInput,
): FlagStatusResult {
	const source = link.source;
	const result: FlagStatusResult = {
		flagKey: source.key,
		flagName: source.name,
		datadogFlagKey: link.datadog?.key,
		status: 'not-yet-migrated',
		flagWideChanges: [],
		flagWideDetails: [],
		environments: [],
	};
	const review = (change: ChangeKind, detail: string): FlagStatusResult => ({
		...result,
		status: 'needs-review',
		flagWideChanges: [change],
		flagWideDetails: [detail],
		details: detail,
	});
	if (link.identityProblem) return review('identity', link.identityProblem);
	if (!link.datadog)
		return { ...result, details: 'No linked Datadog flag was found.' };
	const error =
		input.sourceDetailErrors.get(source.key) ??
		input.datadogDetailErrors.get(link.datadog.id);
	if (error) return review('collection', error);
	if (
		!source.variations?.length ||
		!source.environments ||
		!source.allocations
	) {
		return review(
			'collection',
			'Eppo did not return complete flag configuration.',
		);
	}
	const actual = input.datadogDetails.get(link.datadog.id);
	if (!actual)
		return review(
			'collection',
			'The linked Datadog flag detail was not available.',
		);
	if (actual.key !== source.key)
		return review(
			'identity',
			'The Datadog flag key differs from Eppo; identical keys are required for Eppo bucketing.',
		);
	if (resolveFlagNameForSync(source.name, actual.name) !== actual.name) {
		result.flagWideChanges.push('name');
		result.flagWideDetails.push('Flag name differs.');
	}
	const variants = buildVariants(source);
	const variantDetails = compareSourceVariants(variants, actual);
	if (variantDetails.length) {
		result.flagWideChanges.push('variants');
		result.flagWideDetails.push(...variantDetails);
	}
	const mode = actual.bucketingMode ?? link.datadog.bucketing_mode ?? 'DATADOG';
	result.environments = compareEnvironments(
		source,
		actual,
		input,
		sourceVariantAliases(variants, actual.variants),
		mode,
	);
	result.status = overallStatus(result.flagWideChanges, result.environments);
	return result;
}

function compareEnvironments(
	source: EppoFlag,
	actual: DatadogStatusFlagDetail,
	input: EppoMigrationStatusComparisonInput,
	aliases: ReadonlyMap<string, string>,
	mode: BucketingMode,
): EnvironmentStatusResult[] {
	const output: EnvironmentStatusResult[] = [];
	const variantKeys = new Map(
		actual.variants.map((variant) => [variant.id, variant.key]),
	);
	for (const environment of input.selectedSourceEnvironments) {
		const targets = input.environmentMapping.get(environment.id) ?? [];
		// Keep all targets when translating: Eppo allocation keys are suffixed
		// when a source environment maps to more than one Datadog environment.
		const mapping = new Map([[environment.id, targets]]);
		const defaults = buildDefaultVariantKeyPerEnv(source, mapping);
		const expected = buildAllocations(
			source,
			mapping,
			new Map(input.fingerprintLookup ?? []),
			new Map(input.savedFilterLookup ?? []),
			defaults,
			mode,
		);
		const configuration = source.environments?.find(
			(env) => env.id === environment.id,
		);
		const scopedSource = {
			...source,
			environments: configuration ? [configuration] : [],
		};
		const blockers = findEppoMigrationBlockers(
			scopedSource,
			mapping,
			expected,
			mode,
		);
		const served = (source.allocations ?? []).filter(
			(allocation) =>
				allocation.environment_id === environment.id &&
				allocation.enabled !== false &&
				allocation.percent_exposure > 0,
		);
		const hasTargeting = served.some(
			(allocation) =>
				(allocation.audiences?.length ?? 0) > 0 ||
				(allocation.targeting_rules?.length ?? 0) > 0,
		);
		const unresolvedAudience = served.some((allocation) =>
			allocation.audiences?.some(
				(reference) =>
					reference.type !== 'IS_IN' ||
					!input.savedFilterLookup?.has(reference.audience_id),
			),
		);
		for (const target of targets) {
			const base = {
				sourceEnvironmentKey: String(environment.id),
				sourceEnvironmentName: environment.name,
				datadogEnvironmentId: target.id,
				datadogEnvironmentName: target.name,
			};
			const unverifiable = !configuration
				? 'Eppo did not return configuration for this environment.'
				: hasTargeting && input.audienceCollectionError
					? input.audienceCollectionError
					: unresolvedAudience
						? 'An Eppo audience reference is missing, ambiguous, or uses unsupported negation.'
						: blockers.join(' ');
			if (unverifiable) {
				output.push({
					...base,
					status: 'could-not-verify',
					changes: ['collection'],
					details: unverifiable,
				});
				continue;
			}
			const actualEnv = actual.environments.find(
				(env) => env.environmentId === target.id,
			);
			if (!actualEnv) {
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
			if (configuration?.active !== (actualEnv.status === 'ENABLED')) {
				changes.push('enablement');
				details.push('Environment enablement differs.');
			}
			const defaultKey = defaults.get(target.id);
			const expectedDefault =
				defaultKey === undefined
					? undefined
					: (aliases.get(defaultKey) ?? defaultKey);
			if (expectedDefault !== actualEnv.defaultVariantKey) {
				changes.push('default');
				details.push(
					expectedDefault === undefined
						? 'Eppo has no default, but Datadog has one. Datadog cannot clear it during re-migration.'
						: 'Default variant differs.',
				);
			}
			const expectedAllocations = expected.filter(
				(allocation) => allocation.environment_id === target.id,
			);
			const actualAllocations = actualEnv.allocations ?? [];
			if (
				actualAllocations.some(
					(allocation) =>
						exposureRatio(allocation.exposure_schedule) === undefined,
				)
			) {
				output.push({
					...base,
					status: 'could-not-verify',
					changes: [...changes, 'targeting'],
					details: [
						...details,
						'Datadog has an exposure schedule that cannot be compared safely.',
					].join(' '),
				});
				continue;
			}
			if (
				actualEnv.overrideVariantKey !== undefined ||
				canonicalTargeting(expectedAllocations, aliases, mode) !==
					canonicalTargeting(actualAllocations, variantKeys, mode)
			) {
				changes.push('targeting');
				details.push(
					'Targeting filters, rollout weights, exposure, or Eppo bucketing IDs differ.',
				);
			}
			output.push({
				...base,
				status: changes.length ? 'out-of-sync' : 'in-sync',
				changes,
				details: details.join(' ') || 'Configuration matches.',
			});
		}
	}
	return output;
}

/** Ignore server-generated schedule IDs and timestamps, but never approximate a progressive rollout. */
function exposureRatio(schedule: unknown): number | undefined {
	if (schedule == null) return 1;
	if (typeof schedule !== 'object') return undefined;
	const value = schedule as {
		absolute_start_time?: string | null;
		guardrail_triggered_action?: string | null;
		rollout_options?: { strategy?: string };
		rollout_steps?: Array<{
			exposure_ratio?: number;
			is_pause_record?: boolean;
		}>;
	};
	if (
		value.rollout_options?.strategy !== 'NO_ROLLOUT' ||
		!Array.isArray(value.rollout_steps) ||
		value.rollout_steps.length !== 1 ||
		value.rollout_steps[0]?.is_pause_record ||
		value.guardrail_triggered_action ||
		(value.absolute_start_time &&
			!(Date.parse(value.absolute_start_time) <= Date.now()))
	)
		return undefined;
	const ratio = value.rollout_steps[0]?.exposure_ratio;
	return typeof ratio === 'number' && ratio >= 0 && ratio <= 1
		? ratio
		: undefined;
}

function canonicalTargeting(
	allocations: Array<
		DatadogStatusAllocation | DatadogAllocationForFlagCreation
	>,
	variantKeys: ReadonlyMap<string, string>,
	mode: BucketingMode,
): string {
	return stableJson(
		allocations.map((allocation) => ({
			// Imported Eppo salts use IDs, not allocation keys (which may have been
			// suffixed by an earlier one-to-many migration).
			identity:
				mode === 'EPPO' ? allocation.eppo_allocation_id : allocation.key,
			type: allocation.type ?? 'FEATURE_GATE',
			rules: (allocation.targeting_rules ?? []).map((rule) =>
				(rule.conditions ?? []).map(canonicalCondition),
			),
			exposure: exposureRatio(allocation.exposure_schedule),
			weights: (allocation.variant_weights ?? [])
				.map((weight) => {
					const key =
						weight.variant_key ??
						('variant_id' in weight ? weight.variant_id : undefined);
					return {
						variant:
							key === undefined ? undefined : (variantKeys.get(key) ?? key),
						value: weight.value,
						...(mode === 'EPPO'
							? { eppoId: weight.eppo_variant_weight_id }
							: {}),
					};
				})
				.sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
		})),
	);
}
