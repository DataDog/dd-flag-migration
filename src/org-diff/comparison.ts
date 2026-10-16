import { resolveFlagNameForSync } from '../datadog/flag-names.js';
import type {
	DatadogFlagEntry,
	DatadogStatusAllocation,
	DatadogStatusFlagDetail,
	SavedFilterSummary,
} from '../datadog/types.js';
import {
	findTargetFlag,
	liveAllocations,
	unsupportedAllocationReason,
} from '../datadog-migration/helpers/migration.js';
import { stableJson } from '../migration-status/utils.js';
import type {
	OrgDiffChangeKind,
	OrgDiffEnvironmentPair,
	OrgDiffEnvironmentResult,
	OrgDiffFlagResult,
	OrgDiffFlagStatus,
	OrgDiffInput,
	OrgDiffResult,
	OrgFlagLink,
} from './types.js';

type FlagEnvironment = DatadogStatusFlagDetail['environments'][number];

export const ORG_DIFF_LIMITATIONS = [
	'Saved-filter references are compared, but saved-filter contents are not assessed.',
	'Targeting filter keys and names are not compared; evaluation order, rules, and rollout weights are.',
	'Progressive rollouts, scheduled rollouts, and experiments reference org-specific state and are reported as Needs review.',
	'Permissions, restriction policies, and approval settings are not assessed.',
	'Differences do not identify which org changed.',
];

// ─── Linking ──────────────────────────────────────────────────────────────────

/**
 * Pair every non-archived flag in either org with its counterpart, using the
 * same rule as Datadog-to-Datadog migration: migration metadata first, then
 * the flag key. Unpaired flags exist in only one org.
 */
export function linkOrgFlags(
	sourceFlags: DatadogFlagEntry[],
	targetFlags: DatadogFlagEntry[],
): OrgFlagLink[] {
	const linkedTargetIds = new Set<string>();
	const links: OrgFlagLink[] = [];
	for (const source of sourceFlags) {
		const target = findTargetFlag(
			targetFlags.filter((flag) => !linkedTargetIds.has(flag.id)),
			source,
		);
		if (target) linkedTargetIds.add(target.id);
		links.push({ key: source.key, source, ...(target ? { target } : {}) });
	}
	for (const target of targetFlags) {
		if (!linkedTargetIds.has(target.id))
			links.push({ key: target.key, target });
	}
	return links;
}

/**
 * Link saved filters across orgs: metadata written by a Datadog-to-Datadog
 * migration in either direction first, then a name that is unique on both
 * sides. Returns source saved filter UUID → target saved filter UUID.
 */
export function linkSavedFilters(
	sourceFilters: SavedFilterSummary[],
	targetFilters: SavedFilterSummary[],
): Map<string, string> {
	const links = new Map<string, string>();
	const linkedTargets = new Set<string>();
	const link = (sourceId: string, targetId: string) => {
		if (links.has(sourceId) || linkedTargets.has(targetId)) return;
		links.set(sourceId, targetId);
		linkedTargets.add(targetId);
	};

	const sourceIds = new Set(sourceFilters.map((filter) => filter.id));
	const targetIds = new Set(targetFilters.map((filter) => filter.id));
	for (const target of targetFilters) {
		const metadata = target.migration_metadata;
		if (metadata?.provider === 'datadog' && sourceIds.has(metadata.source_id)) {
			link(metadata.source_id, target.id);
		}
	}
	for (const source of sourceFilters) {
		const metadata = source.migration_metadata;
		if (metadata?.provider === 'datadog' && targetIds.has(metadata.source_id)) {
			link(source.id, metadata.source_id);
		}
	}

	const countNames = (filters: SavedFilterSummary[]) => {
		const counts = new Map<string, number>();
		for (const filter of filters) {
			counts.set(filter.name, (counts.get(filter.name) ?? 0) + 1);
		}
		return counts;
	};
	const sourceNameCounts = countNames(sourceFilters);
	const targetByName = new Map(
		targetFilters.map((filter) => [filter.name, filter]),
	);
	const targetNameCounts = countNames(targetFilters);
	for (const source of sourceFilters) {
		if (sourceNameCounts.get(source.name) !== 1) continue;
		if (targetNameCounts.get(source.name) !== 1) continue;
		const target = targetByName.get(source.name);
		if (target) link(source.id, target.id);
	}
	return links;
}

/** Whether any paired environment in the given details references a saved filter. */
export function hasSavedFilterReferences(
	details: Iterable<DatadogStatusFlagDetail>,
	environmentIds: ReadonlySet<string>,
): boolean {
	for (const detail of details) {
		for (const environment of detail.environments) {
			if (!environmentIds.has(environment.environmentId)) continue;
			for (const allocation of liveAllocations(environment)) {
				for (const rule of allocation.targeting_rules ?? []) {
					if ((rule.conditions ?? []).some((c) => c.saved_filter_id)) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

// ─── Canonical Forms ──────────────────────────────────────────────────────────

function normalizeVariantValue(value: string): string {
	try {
		return stableJson(JSON.parse(value));
	} catch {
		return value;
	}
}

function canonicalCondition(
	condition: NonNullable<
		NonNullable<
			DatadogStatusAllocation['targeting_rules']
		>[number]['conditions']
	>[number],
	savedFilterToken: (id: string) => string,
): string {
	if (condition.saved_filter_id) {
		return stableJson({
			savedFilter: savedFilterToken(condition.saved_filter_id),
		});
	}
	const values = Array.isArray(condition.value)
		? condition.value.map((value) => String(value)).sort()
		: condition.value;
	return stableJson({
		operator: condition.operator,
		attribute: condition.attribute,
		value: values,
	});
}

interface CanonicalAllocation {
	type: string;
	rules: string[];
	weights: Array<{ variantKey: string; value: number }>;
}

/**
 * Evaluation-equivalent form of an environment's targeting. Keys and names
 * are dropped; conditions (AND) and rules (OR) are order-insensitive; zero
 * weights are dropped; filters after an unconditional filter are unreachable;
 * and a trailing unconditional 100% filter that serves the default variant is
 * the same as having no filter at all.
 */
export function canonicalEnvironmentTargeting(
	environment: FlagEnvironment,
	variantKeysById: ReadonlyMap<string, string>,
	savedFilterToken: (id: string) => string,
): string {
	const canonical: CanonicalAllocation[] = [];
	for (const allocation of liveAllocations(environment)) {
		const rules = (allocation.targeting_rules ?? [])
			.map((rule) =>
				stableJson(
					(rule.conditions ?? [])
						.map((condition) => canonicalCondition(condition, savedFilterToken))
						.sort(),
				),
			)
			.sort();
		const weights = (allocation.variant_weights ?? [])
			.filter((weight) => weight.value > 0)
			.map((weight) => ({
				variantKey:
					weight.variant_key ??
					(weight.variant_id
						? (variantKeysById.get(weight.variant_id) ?? weight.variant_id)
						: ''),
				value: weight.value,
			}))
			.sort(
				(a, b) => a.variantKey.localeCompare(b.variantKey) || a.value - b.value,
			);
		canonical.push({
			type: allocation.type ?? 'FEATURE_GATE',
			rules,
			weights,
		});
		if (rules.length === 0) break;
	}
	const last = canonical.at(-1);
	if (
		last &&
		last.rules.length === 0 &&
		last.type === 'FEATURE_GATE' &&
		last.weights.length === 1 &&
		last.weights[0].value === 100 &&
		last.weights[0].variantKey === environment.defaultVariantKey
	) {
		canonical.pop();
	}
	return stableJson(canonical);
}

// ─── Flag Comparison ──────────────────────────────────────────────────────────

/** Names match, allowing either org's numbered collision suffix ("Flag (1)"). */
export function flagNamesMatch(
	sourceName: string,
	targetName: string,
): boolean {
	return (
		resolveFlagNameForSync(sourceName, targetName) === targetName ||
		resolveFlagNameForSync(targetName, sourceName) === sourceName
	);
}

function compareFlagAttributes(
	source: DatadogStatusFlagDetail,
	target: DatadogStatusFlagDetail,
): { changes: OrgDiffChangeKind[]; details: string[] } {
	const changes: OrgDiffChangeKind[] = [];
	const details: string[] = [];
	if (!flagNamesMatch(source.name, target.name)) {
		changes.push('name');
		details.push('Flag name differs.');
	}
	if ((source.description ?? '') !== (target.description ?? '')) {
		changes.push('description');
		details.push('Description differs.');
	}
	if (source.valueType !== target.valueType) {
		changes.push('value-type');
		details.push('Value type differs.');
	}
	if (source.distributionChannel !== target.distributionChannel) {
		changes.push('distribution-channel');
		details.push('Distribution channel differs.');
	}
	const sourceTags = [...new Set(source.tags ?? [])].sort();
	const targetTags = [...new Set(target.tags ?? [])].sort();
	if (stableJson(sourceTags) !== stableJson(targetTags)) {
		changes.push('tags');
		details.push('Tags differ.');
	}

	const variantDetails: string[] = [];
	const targetVariants = new Map(
		target.variants.map((variant) => [variant.key, variant]),
	);
	const sourceKeys = new Set<string>();
	for (const variant of source.variants) {
		sourceKeys.add(variant.key);
		const counterpart = targetVariants.get(variant.key);
		if (!counterpart) {
			variantDetails.push(
				`Variant "${variant.key}" exists only in the source org.`,
			);
			continue;
		}
		if (
			counterpart.name !== variant.name ||
			normalizeVariantValue(counterpart.value) !==
				normalizeVariantValue(variant.value)
		) {
			variantDetails.push(`Variant "${variant.key}" differs.`);
		}
	}
	for (const variant of target.variants) {
		if (!sourceKeys.has(variant.key)) {
			variantDetails.push(
				`Variant "${variant.key}" exists only in the target org.`,
			);
		}
	}
	if (variantDetails.length > 0) {
		changes.push('variants');
		details.push(...variantDetails);
	}
	return { changes, details };
}

function unverifiableReason(environment: FlagEnvironment): string | undefined {
	for (const allocation of liveAllocations(environment)) {
		const reason = unsupportedAllocationReason(allocation);
		if (reason) {
			return `Targeting filter "${allocation.name ?? allocation.key}" ${reason}.`;
		}
	}
	return undefined;
}

function compareEnvironment(
	pair: OrgDiffEnvironmentPair,
	source: DatadogStatusFlagDetail,
	target: DatadogStatusFlagDetail,
	savedFilterLinks: ReadonlyMap<string, string>,
): OrgDiffEnvironmentResult {
	const sourceEnvironment = source.environments.find(
		(environment) => environment.environmentId === pair.sourceEnvironmentId,
	);
	const targetEnvironment = target.environments.find(
		(environment) => environment.environmentId === pair.targetEnvironmentId,
	);
	if (!sourceEnvironment || !targetEnvironment) {
		const missing = !sourceEnvironment ? 'source' : 'target';
		return {
			...pair,
			status: 'could-not-verify',
			changes: ['collection'],
			details: `The ${missing} org did not return configuration for this environment.`,
		};
	}

	const changes: OrgDiffChangeKind[] = [];
	const details: string[] = [];
	const sourceEnabled = sourceEnvironment.status === 'ENABLED';
	const targetEnabled = targetEnvironment.status === 'ENABLED';
	if (sourceEnabled !== targetEnabled) {
		changes.push('enablement');
		details.push(
			`The source org is ${sourceEnabled ? 'enabled' : 'disabled'} while the target org is ${targetEnabled ? 'enabled' : 'disabled'}.`,
		);
	}
	// Disabled environments are not served, and migration only rewrites
	// targeting where the flag is enabled, so there is nothing to compare.
	if (!sourceEnabled && !targetEnabled) {
		return {
			...pair,
			status: 'in-sync',
			changes,
			details: 'Disabled in both orgs; targeting was not compared.',
		};
	}

	if (
		sourceEnvironment.overrideVariantKey !==
		targetEnvironment.overrideVariantKey
	) {
		changes.push('override');
		details.push('Environment override differs.');
	}
	const unverifiable =
		unverifiableReason(sourceEnvironment) ??
		unverifiableReason(targetEnvironment);
	if (unverifiable) {
		return {
			...pair,
			status: changes.length > 0 ? 'differs' : 'could-not-verify',
			changes: changes.length > 0 ? changes : ['targeting'],
			details: [...details, unverifiable].join(' '),
		};
	}
	if (
		sourceEnvironment.defaultVariantKey !== targetEnvironment.defaultVariantKey
	) {
		changes.push('default');
		details.push('Default variant differs.');
	}

	const targetToSource = new Map(
		[...savedFilterLinks].map(([sourceId, targetId]) => [targetId, sourceId]),
	);
	const sourceTargeting = canonicalEnvironmentTargeting(
		sourceEnvironment,
		new Map(source.variants.map((variant) => [variant.id, variant.key])),
		(id) => `linked:${id}`,
	);
	const targetTargeting = canonicalEnvironmentTargeting(
		targetEnvironment,
		new Map(target.variants.map((variant) => [variant.id, variant.key])),
		(id) => {
			const sourceId = targetToSource.get(id);
			return sourceId !== undefined
				? `linked:${sourceId}`
				: `target-only:${id}`;
		},
	);
	if (sourceTargeting !== targetTargeting) {
		changes.push('targeting');
		details.push('Targeting filters or rollout weights differ.');
	}

	return {
		...pair,
		status: changes.length > 0 ? 'differs' : 'in-sync',
		changes,
		details: details.join(' ') || 'Configuration matches.',
	};
}

function baseResult(
	link: OrgFlagLink,
	status: OrgDiffFlagStatus,
	overrides: Partial<OrgDiffFlagResult> = {},
): OrgDiffFlagResult {
	const flag = link.source ?? link.target;
	return {
		flagKey: link.key,
		flagName: flag?.name ?? link.key,
		...(link.source ? { sourceFlagId: link.source.id } : {}),
		...(link.target ? { targetFlagId: link.target.id } : {}),
		status,
		flagWideChanges: [],
		flagWideDetails: [],
		environments: [],
		...overrides,
	};
}

function overallStatus(
	flagWideChanges: OrgDiffChangeKind[],
	environments: OrgDiffEnvironmentResult[],
): OrgDiffFlagStatus {
	if (
		flagWideChanges.length > 0 ||
		environments.some((environment) => environment.status === 'differs')
	) {
		return 'differs';
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

function compareLinkedFlag(
	link: OrgFlagLink,
	input: OrgDiffInput,
): OrgDiffFlagResult {
	if (!link.target) {
		return baseResult(link, 'only-in-source', {
			details: 'No flag with this key exists in the target org.',
		});
	}
	if (!link.source) {
		return baseResult(link, 'only-in-target', {
			details: 'No flag with this key exists in the source org.',
		});
	}
	const errors = [
		input.sourceDetailErrors.get(link.source.id),
		input.targetDetailErrors.get(link.target.id),
	].filter((error): error is string => error !== undefined);
	const source = input.sourceDetails.get(link.source.id);
	const target = input.targetDetails.get(link.target.id);
	if (errors.length > 0 || !source || !target) {
		const message =
			errors.join(' ') || 'Flag details were not available for both orgs.';
		return baseResult(link, 'needs-review', {
			details: message,
			flagWideChanges: ['collection'],
			flagWideDetails: [message],
		});
	}

	const { changes, details } = compareFlagAttributes(source, target);
	const environments = input.environmentPairs.map((pair) =>
		compareEnvironment(
			pair,
			source,
			target,
			input.savedFilterLinks ?? new Map(),
		),
	);
	return baseResult(link, overallStatus(changes, environments), {
		flagName: source.name,
		flagWideChanges: changes,
		flagWideDetails: details,
		environments,
	});
}

/** Compare flag configuration between two Datadog orgs. Neither org is preferred. */
export function compareOrgs(input: OrgDiffInput): OrgDiffResult {
	const links = linkOrgFlags(input.sourceFlags, input.targetFlags);
	return {
		sourceSite: input.sourceSite,
		targetSite: input.targetSite,
		generatedAt: new Date(),
		environmentPairs: input.environmentPairs,
		flags: links
			.map((link) => compareLinkedFlag(link, input))
			.sort((a, b) => a.flagKey.localeCompare(b.flagKey)),
		limitations: ORG_DIFF_LIMITATIONS,
	};
}
