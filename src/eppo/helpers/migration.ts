import {
	type BucketingMode,
	type DatadogAllocationForFlagCreation,
	type DatadogCondition,
	type DatadogCreateFlagRequest,
	type DatadogEnvironment,
	type DatadogExposureScheduleRequest,
	type DatadogFlagEntry,
	type DatadogTargetingRule,
	type DatadogVariantWeightRequest,
	type EnvironmentMappingInput,
	mappedDatadogEnvironments,
	type SourceVariant,
} from '../../datadog/types.js';
import type {
	EppoAllocation,
	EppoFlag,
	EppoVariationWeight,
} from '../types.js';

export function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'default'
	);
}

function uniqueVariantKey(preferredKey: string, usedKeys: Set<string>): string {
	let key = preferredKey;
	let suffix = 1;
	while (usedKeys.has(key)) {
		key = `${preferredKey}-${suffix}`;
		suffix++;
	}
	usedKeys.add(key);
	return key;
}

// Datadog requires JSON variant values to be objects. Eppo sometimes stores JSON
// arrays as variant_key values, so wrap them.
export function normalizeJsonVariantValue(raw: string): string {
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return JSON.stringify({ value: parsed });
	} catch {
		// not valid JSON — pass through as-is
	}
	return raw;
}

export function buildVariationIdToKey(flag: EppoFlag): Map<number, string> {
	const usedKeys = new Set<string>();
	const variationIdToKey = new Map<number, string>();
	for (const v of flag.variations ?? []) {
		variationIdToKey.set(v.id, uniqueVariantKey(slugify(v.name), usedKeys));
	}
	return variationIdToKey;
}

export function buildVariants(flag: EppoFlag): SourceVariant[] {
	const isJsonFlag = flag.variation_type === 'JSON';
	const variationIdToKey = buildVariationIdToKey(flag);
	return (flag.variations ?? []).map((v) => ({
		key: variationIdToKey.get(v.id) ?? slugify(v.name),
		name: v.name,
		value: isJsonFlag
			? normalizeJsonVariantValue(v.variant_key)
			: v.variant_key,
		// EppoFlagVariation.id is the stable identifier — survives renames.
		sourceId: String(v.id),
	}));
}

/** Variants for the create-flag request, stamped with their Eppo provenance. */
export function toCreateFlagVariants(
	variants: SourceVariant[],
): DatadogCreateFlagRequest['variants'] {
	return variants.map(({ key, name, value, sourceId }) => ({
		key,
		name,
		value,
		migration_metadata: {
			provider: 'eppo',
			source_id: sourceId,
			source_key: key,
		},
	}));
}

// MAJOR.MINOR.PATCH with optional pre-release and build metadata; no leading zeros
const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;

function isValidSemver(value: string): boolean {
	return SEMVER_RE.test(value);
}

// Map Eppo variation_type → Datadog value_type
export function mapVariationType(
	eppoType: string,
): DatadogCreateFlagRequest['value_type'] {
	switch (eppoType.toUpperCase()) {
		case 'BOOLEAN':
			return 'BOOLEAN';
		case 'INTEGER':
			return 'INTEGER';
		case 'NUMERIC':
			return 'NUMERIC';
		case 'JSON':
			return 'JSON';
		default:
			return 'STRING';
	}
}

// Map Eppo condition operator → Datadog condition operator.
// For LT/LTE/GT/GTE, emits SEMVER_* when every value is a valid semver string;
// otherwise falls back to the plain numeric operator.
export function mapOperator(eppoOp: string, values?: string[]): string {
	const op = eppoOp.toUpperCase();
	const semverMap: Record<string, string> = {
		LT: 'SEMVER_LT',
		LTE: 'SEMVER_LTE',
		GT: 'SEMVER_GT',
		GTE: 'SEMVER_GTE',
	};
	if (
		op in semverMap &&
		values &&
		values.length > 0 &&
		values.every(isValidSemver)
	) {
		return semverMap[op];
	}
	const mapping: Record<string, string> = {
		LT: 'LT',
		LTE: 'LTE',
		GT: 'GT',
		GTE: 'GTE',
		MATCHES: 'MATCHES',
		ONE_OF: 'ONE_OF',
		NOT_ONE_OF: 'NOT_ONE_OF',
		IS_NULL: 'IS_NULL',
	};
	return mapping[op] ?? op;
}

// ─── Audience Fingerprinting ─────────────────────────────────────────────────

/**
 * Create a stable fingerprint from a set of conditions.
 * Used to detect allocation targeting rules that came from an Eppo audience,
 * since the API expands audience conditions inline without exposing audience_id.
 */
export function fingerprintConditions(
	conditions: Array<{ operator: string; attribute: string; values?: string[] }>,
): string {
	const normalized = conditions
		.map((c) => ({
			op: c.operator.toUpperCase(),
			attr: c.attribute,
			vals: [...(c.values ?? [])].sort(),
		}))
		.sort((a, b) => {
			const attrCmp = a.attr.localeCompare(b.attr);
			if (attrCmp !== 0) return attrCmp;
			return a.op.localeCompare(b.op);
		});
	return JSON.stringify(normalized);
}

/** Returns true if any variation value is a top-level JSON array (wrapped as { value: [...] } on migration). */
export function hasJsonArrayVariants(flag: EppoFlag): boolean {
	return (flag.variations ?? []).some((v) => {
		try {
			return Array.isArray(JSON.parse(v.variant_key));
		} catch {
			return false;
		}
	});
}

// Returns true if any allocation contains at least one SEMVER_* condition.
// Datadog requires distribution_channel = 'CLIENT' when SEMVER operators are present.
export function hasSemverConditions(
	allocations: DatadogAllocationForFlagCreation[],
): boolean {
	return allocations.some(
		(alloc) =>
			alloc.targeting_rules?.some((rule) =>
				rule.conditions.some((cond) => cond.operator?.startsWith('SEMVER_')),
			) ?? false,
	);
}

/**
 * Convert Eppo targeting rules → Datadog targeting rules.
 *
 * Two mechanisms resolve audience references:
 * 1. savedFilterLookup (audienceId → savedFilterId): used when the Eppo API
 *    returns explicit audience references in allocation.audiences (preferred).
 * 2. fingerprintLookup (conditionFingerprint → savedFilterId): fallback for
 *    older API responses that expand audience conditions inline.
 *
 * Duplicate saved filter IDs within the same allocation are deduplicated.
 */
export function buildTargetingRules(
	eppoAlloc: EppoAllocation,
	fingerprintLookup?: Map<string, string>,
	savedFilterLookup?: Map<number, string>,
): DatadogTargetingRule[] {
	const rules: DatadogTargetingRule[] = [];
	const usedSavedFilterIds = new Set<string>();

	// Explicit audience references (preferred path — requires updated Eppo API).
	if (
		savedFilterLookup &&
		eppoAlloc.audiences &&
		eppoAlloc.audiences.length > 0
	) {
		for (const audienceRef of eppoAlloc.audiences) {
			const savedFilterId = savedFilterLookup.get(audienceRef.audience_id);
			if (
				savedFilterId !== undefined &&
				!usedSavedFilterIds.has(savedFilterId)
			) {
				usedSavedFilterIds.add(savedFilterId);
				rules.push({ conditions: [{ saved_filter_id: savedFilterId }] });
			}
		}
	}

	for (const rule of eppoAlloc.targeting_rules ?? []) {
		const conditions = rule.conditions ?? [];
		if (conditions.length === 0) continue;

		if (fingerprintLookup) {
			const fp = fingerprintConditions(conditions);
			const savedFilterId = fingerprintLookup.get(fp);
			if (savedFilterId !== undefined) {
				if (!usedSavedFilterIds.has(savedFilterId)) {
					usedSavedFilterIds.add(savedFilterId);
					rules.push({ conditions: [{ saved_filter_id: savedFilterId }] });
				}
				continue;
			}
		}

		const inlineConditions: DatadogCondition[] = conditions.map((cond) => ({
			operator: mapOperator(cond.operator, cond.values),
			attribute: cond.attribute,
			value: cond.values ?? [],
		}));
		rules.push({ conditions: inlineConditions });
	}

	return rules;
}

// Returns true when an allocation is a pure default: no audiences, no targeting rules,
// and is_default=true. These map to default_variant_key rather than a targeting rule.
function isPureDefaultAllocation(alloc: EppoAllocation): boolean {
	return (
		alloc.is_default === true &&
		(alloc.audiences ?? []).length === 0 &&
		(alloc.targeting_rules ?? []).length === 0
	);
}

// ─── Eppo Source Data ────────────────────────────────────────────────────────
//
// Eppo serves only enabled allocations and splits them across active
// variations. Fields missing from older Eppo API responses are treated as
// enabled / active.

function activeVariationIds(flag: EppoFlag): Set<number> {
	return new Set(
		(flag.variations ?? [])
			.filter((v) => v.is_active !== false)
			.map((v) => v.id),
	);
}

function servedAllocations(
	flag: EppoFlag,
	eppoEnvId: number,
): EppoAllocation[] {
	return (flag.allocations ?? []).filter(
		(a) => a.environment_id === eppoEnvId && a.enabled !== false,
	);
}

// The weights Eppo splits on: those of active variations the flag still has.
// Inactive and unknown variations are dropped before any total is computed.
// The Eppo API returns weights in split order (by weight ID).
function activeWeights(
	alloc: EppoAllocation,
	activeIds: ReadonlySet<number>,
): EppoVariationWeight[] {
	return (alloc.variation_weight ?? []).filter((w) =>
		activeIds.has(w.variation_id),
	);
}

/**
 * Eppo exposes an allocation to `percent_exposure` (0–1) of the subjects it
 * matches. Partial exposure maps to a single-step schedule that starts
 * immediately, so the allocation serves the same share as soon as it exists.
 */
export function buildExposureSchedule(
	percentExposure: number,
): DatadogExposureScheduleRequest | undefined {
	if (!(percentExposure > 0 && percentExposure < 1)) return undefined;
	return {
		rollout_options: { strategy: 'NO_ROLLOUT', scheduled_start: 'now' },
		rollout_steps: [
			{
				exposure_ratio: percentExposure,
				interval_ms: null,
				is_pause_record: false,
				grouped_step_index: 0,
			},
		],
	};
}

// ─── Default Variants ────────────────────────────────────────────────────────

const NO_DEFAULT_REASON =
	'Eppo serves no default; unmatched subjects receive the SDK fallback value, which Datadog cannot represent.';

type EnvironmentDefault =
	/** A pure default serving one variation: it becomes default_variant_key. */
	| { kind: 'single'; variantKey: string }
	/**
	 * A pure default split across variations: it stays as a catch-all targeting
	 * filter, so the environment's default variant is never reached.
	 */
	| { kind: 'split'; variantKey: string; weights: EppoVariationWeight[] }
	| { kind: 'missing'; reason: string };

function resolveEnvironmentDefault(
	flag: EppoFlag,
	eppoEnvId: number,
	variationIdToKey: ReadonlyMap<number, string>,
	activeIds: ReadonlySet<number>,
): EnvironmentDefault {
	const defaultAlloc = servedAllocations(flag, eppoEnvId).find(
		isPureDefaultAllocation,
	);
	if (!defaultAlloc || defaultAlloc.percent_exposure <= 0) {
		return { kind: 'missing', reason: NO_DEFAULT_REASON };
	}
	if (defaultAlloc.percent_exposure < 1) {
		const percent = Math.round(defaultAlloc.percent_exposure * 10000) / 100;
		return {
			kind: 'missing',
			reason: `Eppo's default serves only ${percent}% of subjects; the rest receive the SDK fallback value, which Datadog cannot represent.`,
		};
	}
	const weights = activeWeights(defaultAlloc, activeIds);
	const nonZero = weights.filter((w) => w.weight > 0);
	const firstKey = variationIdToKey.get(nonZero[0]?.variation_id ?? -1);
	if (firstKey === undefined) {
		return { kind: 'missing', reason: NO_DEFAULT_REASON };
	}
	return nonZero.length === 1
		? { kind: 'single', variantKey: firstKey }
		: { kind: 'split', variantKey: firstKey, weights };
}

/**
 * Build a per-environment map of default variant keys.
 *
 * Every mapped Eppo environment whose pure default (is_default=true, no
 * audiences, no targeting rules, fully exposed) serves exactly one active
 * variation maps ddEnvId → variantKey; that allocation is then omitted by
 * buildAllocations. A split default maps to its first variation in split
 * order: the split itself stays as a catch-all targeting filter, so this
 * default is never reached and only gives the environment an explicit one.
 * Environments without a usable default get `chosenDefaultVariantKey` (the
 * variant the user chose when production has none), or are omitted.
 */
export function buildDefaultVariantKeyPerEnv(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
	chosenDefaultVariantKey?: string,
): Map<string, string> {
	const variationIdToKey = buildVariationIdToKey(flag);
	const activeIds = activeVariationIds(flag);

	const result = new Map<string, string>();
	for (const [eppoEnvId, mappedEnvironments] of mapping) {
		const resolved = resolveEnvironmentDefault(
			flag,
			eppoEnvId,
			variationIdToKey,
			activeIds,
		);
		const variantKey =
			resolved.kind === 'missing'
				? chosenDefaultVariantKey
				: resolved.variantKey;
		if (variantKey === undefined) continue;
		for (const ddEnv of mappedDatadogEnvironments(mappedEnvironments)) {
			result.set(ddEnv.id, variantKey);
		}
	}
	return result;
}

function productionDefaults(
	flag: EppoFlag,
): Array<{ envName: string; resolved: EnvironmentDefault }> {
	const variationIdToKey = buildVariationIdToKey(flag);
	const activeIds = activeVariationIds(flag);
	return (flag.environments ?? [])
		.filter((env) => env.is_production)
		.map((env) => ({
			envName: env.name,
			resolved: resolveEnvironmentDefault(
				flag,
				env.id,
				variationIdToKey,
				activeIds,
			),
		}));
}

/**
 * Names of the Eppo production environments with no usable default, whether
 * or not they are mapped: production's default becomes the flag's default, so
 * a migration must not invent one. Empty when every production environment
 * has a default, or when the flag has no production environment.
 */
export function productionEnvironmentsWithoutDefault(flag: EppoFlag): string[] {
	return productionDefaults(flag)
		.filter(({ resolved }) => resolved.kind === 'missing')
		.map(({ envName }) => envName);
}

/**
 * Names of the mapped, active Eppo environments with no usable default — the
 * environments a variant chosen for a missing production default also covers.
 */
export function activeEnvironmentsWithoutDefault(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
): string[] {
	const variationIdToKey = buildVariationIdToKey(flag);
	const activeIds = activeVariationIds(flag);
	return (flag.environments ?? [])
		.filter(
			(env) =>
				env.active &&
				mapping.has(env.id) &&
				resolveEnvironmentDefault(flag, env.id, variationIdToKey, activeIds)
					.kind === 'missing',
		)
		.map((env) => env.name);
}

/**
 * The flag-level default_variant_key sent when creating an `EPPO` flag, which
 * Datadog applies to every environment. Environments whose Eppo default
 * differs are corrected afterwards by the allocation sync.
 *
 * Uses the Eppo production environment's default, mapped or not, then the
 * variant chosen because production has none. Flags without a production
 * environment fall back to a production Datadog environment's default, then
 * an active environment's, then any mapped environment's, then the first
 * variant (findEppoMigrationBlockers only lets that happen when every mapped
 * environment is inactive, so nothing is served).
 */
export function resolveFlagDefaultVariantKey(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
	defaultVariantKeyPerEnv: ReadonlyMap<string, string>,
	variants: SourceVariant[],
	chosenDefaultVariantKey?: string,
): string | undefined {
	for (const { resolved } of productionDefaults(flag)) {
		if (resolved.kind !== 'missing') return resolved.variantKey;
	}
	if (chosenDefaultVariantKey !== undefined) return chosenDefaultVariantKey;

	const activeEnvIds = new Set(
		(flag.environments ?? []).filter((e) => e.active).map((e) => e.id),
	);
	const candidates = [...mapping].flatMap(([eppoEnvId, mappedEnvironments]) =>
		mappedDatadogEnvironments(mappedEnvironments).map((ddEnv) => ({
			ddEnv,
			active: activeEnvIds.has(eppoEnvId),
		})),
	);
	const rank = (c: { ddEnv: DatadogEnvironment; active: boolean }) =>
		c.ddEnv.is_production ? 0 : c.active ? 1 : 2;
	for (const { ddEnv } of [...candidates].sort((a, b) => rank(a) - rank(b))) {
		const key = defaultVariantKeyPerEnv.get(ddEnv.id);
		if (key !== undefined) return key;
	}
	return variants[0]?.key;
}

// ─── Allocations ─────────────────────────────────────────────────────────────

function allocationKey(
	flag: EppoFlag,
	eppoAlloc: EppoAllocation,
	ddEnv: DatadogEnvironment,
	suffixWithEnvironment: boolean,
): string {
	const envSlug = ddEnv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	if (!eppoAlloc.key) return `${flag.key}-${envSlug}-${eppoAlloc.id}`;
	return suffixWithEnvironment ? `${eppoAlloc.key}-${envSlug}` : eppoAlloc.key;
}

/**
 * Build allocations from Eppo's actual allocation data for each mapped DD environment.
 *
 * Pure-default allocations that serve a single variation are omitted for
 * environments present in defaultVariantKeyPerEnv — those are handled via
 * default_variant_key on the allocations-sync endpoint instead.
 *
 * Weights are Eppo's raw weights, zero weights included: Datadog divides by
 * the total, so renormalizing would only add float drift, and Eppo counts zero
 * weights when deciding which split ends the range.
 *
 * With `EPPO` bucketing, each allocation also carries the Eppo allocation and
 * variation weight IDs, from which Datadog derives Eppo's salts and split
 * order, so weights are sent in any order. Allocation keys are unique per
 * Datadog org but no longer feed the salts, so they are suffixed with the
 * environment when one Eppo environment maps to several Datadog environments.
 *
 * With `DATADOG` bucketing (flags migrated before Eppo bucketing), no Eppo IDs
 * are sent — Datadog rejects them — and allocation keys are never changed,
 * because they are part of those flags' salts.
 */
export function buildAllocations(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
	fingerprintLookup?: Map<string, string>,
	savedFilterLookup?: Map<number, string>,
	defaultVariantKeyPerEnv?: Map<string, string>,
	bucketingMode: BucketingMode = 'DATADOG',
): DatadogAllocationForFlagCreation[] {
	const variations = flag.variations ?? [];
	if (variations.length === 0) return [];

	const variationIdToKey = buildVariationIdToKey(flag);
	const activeIds = activeVariationIds(flag);
	const eppoBucketing = bucketingMode === 'EPPO';
	const allocations: DatadogAllocationForFlagCreation[] = [];

	for (const [eppoEnvId, mappedEnvironments] of mapping) {
		// No served Eppo allocations — the flag will serve its default value
		const envAllocs = servedAllocations(flag, eppoEnvId);
		const ddEnvs = mappedDatadogEnvironments(mappedEnvironments);
		const suffixKeys = eppoBucketing && ddEnvs.length > 1;

		for (const ddEnv of ddEnvs) {
			for (const eppoAlloc of envAllocs) {
				// A zero-exposure allocation is a pure passthrough in Eppo — no users are
				// ever served from it. Datadog has no passthrough concept, so skip it.
				if (eppoAlloc.percent_exposure === 0) continue;

				const weights = activeWeights(eppoAlloc, activeIds);
				if (weights.length === 0) continue;

				// Only a fully exposed default that serves one variation becomes the
				// environment's default; any other default stays a targeting filter.
				if (
					defaultVariantKeyPerEnv?.has(ddEnv.id) &&
					isPureDefaultAllocation(eppoAlloc) &&
					eppoAlloc.percent_exposure >= 1 &&
					weights.filter((w) => w.weight > 0).length === 1
				)
					continue;

				const variantWeights: DatadogVariantWeightRequest[] = weights.map(
					(w) => ({
						variant_key: variationIdToKey.get(w.variation_id) ?? '',
						value: w.weight,
						...(eppoBucketing && w.id !== undefined
							? { eppo_variant_weight_id: w.id }
							: {}),
					}),
				);

				// Map targeting rules
				const targetingRules = buildTargetingRules(
					eppoAlloc,
					fingerprintLookup,
					savedFilterLookup,
				);
				const exposureSchedule = buildExposureSchedule(
					eppoAlloc.percent_exposure,
				);

				allocations.push({
					environment_id: ddEnv.id,
					name: eppoAlloc.name || ddEnv.name,
					key: allocationKey(flag, eppoAlloc, ddEnv, suffixKeys),
					type: 'FEATURE_GATE',
					variant_weights: variantWeights,
					...(targetingRules.length > 0
						? { targeting_rules: targetingRules }
						: {}),
					...(exposureSchedule !== undefined
						? { exposure_schedule: exposureSchedule }
						: {}),
					...(eppoBucketing ? { eppo_allocation_id: eppoAlloc.id } : {}),
				});
			}
		}
	}

	return allocations;
}

// ─── Eppo Migration Preflight ────────────────────────────────────────────────

const MISSING_WEIGHT_IDS_REASON =
	'Eppo did not return variation weight IDs, which set the split order. Update to an Eppo API version that returns them and re-run the migration.';

function hasMissingWeightIds(weights: EppoVariationWeight[]): boolean {
	return (
		weights.filter((w) => w.weight > 0).length > 1 &&
		weights.some((w) => w.id === undefined)
	);
}

/**
 * Report what prevents a flag from being migrated. Datadog cannot reproduce
 * these, so the flag fails with a reason instead of being approximated. The
 * same rules apply to new flags and to re-migrations, including flags migrated
 * before Eppo bucketing:
 *
 * - a production environment, mapped or not, whose Eppo default does not serve
 *   every unmatched subject (no default, a targeted default, or one below 100%
 *   exposure): production's default becomes the flag's default;
 * - an active environment in the same state. Disabled environments serve
 *   nothing in either system, so they only need some default, which the
 *   flag-level default provides.
 *
 *   Neither applies when `coveredDefaults` is set: the user chose a variant
 *   for every environment without a default, or an existing `EPPO` flag keeps
 *   the defaults chosen when it was created;
 * - a split whose active weights are all zero (Eppo's range math is undefined);
 * - with `EPPO` bucketing, a split without variation weight IDs (the split
 *   order is unknown);
 * - allocation keys that collide in Datadog, where they are unique per org.
 */
export function findEppoMigrationBlockers(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
	allocations: DatadogAllocationForFlagCreation[],
	bucketingMode: BucketingMode,
	{ coveredDefaults = false }: { coveredDefaults?: boolean } = {},
): string[] {
	const eppoBucketing = bucketingMode === 'EPPO';
	const variationIdToKey = buildVariationIdToKey(flag);
	const activeIds = activeVariationIds(flag);
	const environments = new Map(
		(flag.environments ?? []).map((env) => [env.id, env]),
	);
	const blockers: string[] = [];
	const report = (envName: string | undefined, reason: string) => {
		const scope = envName === undefined ? '' : ` (${envName})`;
		blockers.push(`Flag "${flag.key}"${scope}: ${reason}`);
	};

	if (!coveredDefaults) {
		for (const { envName, resolved } of productionDefaults(flag)) {
			if (resolved.kind !== 'missing') continue;
			report(
				envName,
				`${resolved.reason} Set a default variation in Eppo, or run the migration interactively to choose one, and re-run the migration.`,
			);
		}
	}

	for (const [eppoEnvId] of mapping) {
		const environment = environments.get(eppoEnvId);
		const envName = environment?.name ?? String(eppoEnvId);
		const reasons = new Set<string>();

		for (const alloc of servedAllocations(flag, eppoEnvId)) {
			if (alloc.percent_exposure === 0 || isPureDefaultAllocation(alloc)) {
				continue;
			}
			const weights = activeWeights(alloc, activeIds);
			if (weights.length > 0 && weights.every((w) => w.weight <= 0)) {
				reasons.add(
					`targeting filter "${alloc.name || alloc.key}" has no non-zero weights on active variations. Give one variation a weight in Eppo and re-run the migration.`,
				);
			}
			if (eppoBucketing && hasMissingWeightIds(weights)) {
				reasons.add(MISSING_WEIGHT_IDS_REASON);
			}
		}

		const resolved = resolveEnvironmentDefault(
			flag,
			eppoEnvId,
			variationIdToKey,
			activeIds,
		);
		// Production environments were checked above, mapped or not.
		if (
			!coveredDefaults &&
			resolved.kind === 'missing' &&
			environment?.active &&
			!environment.is_production
		) {
			reasons.add(
				`${resolved.reason} Set a default variation in Eppo and re-run the migration.`,
			);
		}
		if (
			eppoBucketing &&
			resolved.kind === 'split' &&
			hasMissingWeightIds(resolved.weights)
		) {
			reasons.add(MISSING_WEIGHT_IDS_REASON);
		}

		for (const reason of reasons) report(envName, reason);
	}

	const seenKeys = new Set<string>();
	const duplicateKeys = new Set<string>();
	for (const allocation of allocations) {
		if (seenKeys.has(allocation.key)) duplicateKeys.add(allocation.key);
		seenKeys.add(allocation.key);
	}
	if (duplicateKeys.size > 0) {
		report(
			undefined,
			`targeting filter key(s) ${[...duplicateKeys].map((key) => `"${key}"`).join(', ')} would be used more than once, but Datadog requires them to be unique. Rename the Eppo allocations and re-run the migration.`,
		);
	}
	return blockers;
}

// ─── Existing Datadog Flags ──────────────────────────────────────────────────

/**
 * How a migration treats a Datadog flag that already exists for an Eppo flag:
 *
 * - `eppo`: created with `EPPO` bucketing — re-migrate with Eppo IDs.
 * - `legacy`: migrated from Eppo before Eppo bucketing — keep its `DATADOG`
 *   bucketing (converting would reassign subjects a second time) and send no
 *   Eppo IDs. Otherwise it follows the same rules as an `eppo` flag.
 * - `native`: created in Datadog — never overwritten.
 */
export type ExistingFlagKind = 'eppo' | 'legacy' | 'native';

export function classifyExistingFlag(
	existing: DatadogFlagEntry,
): ExistingFlagKind {
	if (existing.bucketing_mode === 'EPPO') return 'eppo';
	if (existing.migration_metadata?.provider === 'eppo') return 'legacy';
	return 'native';
}

// Determine which DD environments should be enabled for a flag
export function getEnvsToEnable(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
): DatadogEnvironment[] {
	const activeEnvIds = new Set(
		(flag.environments ?? []).filter((e) => e.active).map((e) => e.id),
	);
	const envsToEnable: DatadogEnvironment[] = [];
	for (const [eppoEnvId, mappedEnvironments] of mapping) {
		if (activeEnvIds.has(eppoEnvId)) {
			envsToEnable.push(...mappedDatadogEnvironments(mappedEnvironments));
		}
	}
	return envsToEnable;
}

// Determine which DD environments should be disabled for a flag
export function getEnvsToDisable(
	flag: EppoFlag,
	mapping: EnvironmentMappingInput<number>,
): DatadogEnvironment[] {
	const activeEnvIds = new Set(
		(flag.environments ?? []).filter((e) => e.active).map((e) => e.id),
	);
	const envsToDisable: DatadogEnvironment[] = [];
	for (const [eppoEnvId, mappedEnvironments] of mapping) {
		if (!activeEnvIds.has(eppoEnvId)) {
			envsToDisable.push(...mappedDatadogEnvironments(mappedEnvironments));
		}
	}
	return envsToDisable;
}
