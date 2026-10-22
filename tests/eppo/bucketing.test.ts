/**
 * Eppo-compatible bucketing: the source data, IDs, exposure and defaults the
 * migration sends so Datadog assigns subjects exactly as Eppo does.
 */
import { describe, expect, it } from '@jest/globals';
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
} from '../../src/datadog/types.js';
import {
	activeEnvironmentsWithoutDefault,
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	buildExposureSchedule,
	buildVariants,
	classifyExistingFlag,
	findEppoMigrationBlockers,
	productionEnvironmentsWithoutDefault,
	resolveFlagDefaultVariantKey,
	toCreateFlagVariants,
} from '../../src/eppo/helpers/migration.js';
import type { EppoAllocation, EppoFlag } from '../../src/eppo/types.js';
import {
	ddDev,
	ddProd,
	ddStaging,
	makeAllocation,
	makeFlag,
} from './helpers.js';

const PROD_ENV_ID = 10;
const STAGING_ENV_ID = 20;

function splitFlag(overrides: Partial<EppoFlag> = {}): EppoFlag {
	return makeFlag({
		id: 1,
		key: 'checkout-redesign',
		variation_type: 'STRING',
		variations: [
			{ id: 100, name: 'Control', variant_key: 'control', is_active: true },
			{ id: 200, name: 'Treatment', variant_key: 'treatment', is_active: true },
			{ id: 300, name: 'Legacy', variant_key: 'legacy', is_active: false },
		],
		environments: [
			{
				id: PROD_ENV_ID,
				name: 'production',
				active: true,
				is_production: true,
			},
			{
				id: STAGING_ENV_ID,
				name: 'staging',
				active: false,
				is_production: false,
			},
		],
		...overrides,
	});
}

function experiment(overrides: Partial<EppoAllocation> = {}): EppoAllocation {
	return makeAllocation({
		id: 7001,
		key: 'experiment-alloc',
		name: 'Experiment',
		environment_id: PROD_ENV_ID,
		enabled: true,
		variation_weight: [
			{ id: 901, variation_id: 200, weight: 1 },
			{ id: 902, variation_id: 100, weight: 2 },
		],
		targeting_rules: [
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
				],
			},
		],
		...overrides,
	});
}

function pureDefault(overrides: Partial<EppoAllocation> = {}): EppoAllocation {
	return makeAllocation({
		id: 7002,
		key: 'default-alloc',
		name: 'Default',
		environment_id: PROD_ENV_ID,
		enabled: true,
		is_default: true,
		variation_weight: [{ id: 903, variation_id: 100, weight: 100 }],
		...overrides,
	});
}

const prodOnly = new Map<number, DatadogEnvironment>([[PROD_ENV_ID, ddProd]]);

describe('buildAllocations with EPPO bucketing', () => {
	it('sends raw weights, Eppo allocation and weight IDs', () => {
		const flag = splitFlag({ allocations: [experiment(), pureDefault()] });
		const dvk = buildDefaultVariantKeyPerEnv(flag, prodOnly);
		const allocations = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			dvk,
			'EPPO',
		);

		expect(allocations).toEqual([
			{
				environment_id: 'dd-prod',
				name: 'Experiment',
				key: 'experiment-alloc',
				type: 'FEATURE_GATE',
				variant_weights: [
					{ variant_key: 'treatment', value: 1, eppo_variant_weight_id: 901 },
					{ variant_key: 'control', value: 2, eppo_variant_weight_id: 902 },
				],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'country', value: ['US'] },
						],
					},
				],
				eppo_allocation_id: 7001,
			},
		]);
	});

	it('keeps zero weights, which Eppo counts when ending the last split', () => {
		const flag = splitFlag({
			allocations: [
				experiment({
					variation_weight: [
						{ id: 901, variation_id: 200, weight: 50 },
						{ id: 902, variation_id: 100, weight: 50 },
						{ id: 905, variation_id: 100, weight: 0 },
					],
				}),
			],
		});
		const [allocation] = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			undefined,
			'EPPO',
		);

		expect(allocation.variant_weights.map((w) => w.value)).toEqual([50, 50, 0]);
	});

	it('drops weights of deactivated and unknown variations before totals', () => {
		const flag = splitFlag({
			allocations: [
				experiment({
					variation_weight: [
						{ id: 901, variation_id: 200, weight: 1 },
						{ id: 902, variation_id: 100, weight: 1 },
						{ id: 903, variation_id: 300, weight: 2 },
						{ id: 904, variation_id: 999, weight: 4 },
					],
				}),
			],
		});

		const [eppo] = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			undefined,
			'EPPO',
		);
		expect(eppo.variant_weights.map((w) => w.variant_key)).toEqual([
			'treatment',
			'control',
		]);

		// Flags migrated before Eppo bucketing get the same raw weights, without IDs.
		const [legacy] = buildAllocations(flag, prodOnly);
		expect(legacy.variant_weights).toEqual([
			{ variant_key: 'treatment', value: 1 },
			{ variant_key: 'control', value: 1 },
		]);
		expect('eppo_allocation_id' in legacy).toBe(false);
	});

	it('treats variations without is_active as active', () => {
		const flag = splitFlag({
			variations: [
				{ id: 100, name: 'Control', variant_key: 'control' },
				{ id: 200, name: 'Treatment', variant_key: 'treatment' },
			],
			allocations: [experiment()],
		});
		const [allocation] = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			undefined,
			'EPPO',
		);
		expect(allocation.variant_weights).toHaveLength(2);
	});

	it('skips disabled allocations', () => {
		const flag = splitFlag({
			allocations: [
				experiment({ enabled: false }),
				experiment({ id: 7003, key: 'served', enabled: undefined }),
			],
		});
		const allocations = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			undefined,
			'EPPO',
		);
		expect(allocations.map((a) => a.key)).toEqual(['served']);
	});

	it.each([
		'EPPO',
		'DATADOG',
	] as const)('maps partial exposure to a pre-started schedule (%s)', (mode) => {
		const flag = splitFlag({
			allocations: [
				experiment({ percent_exposure: 0.3333 }),
				experiment({ id: 7003, key: 'full', percent_exposure: 1 }),
				experiment({ id: 7004, key: 'none', percent_exposure: 0 }),
			],
		});
		const allocations = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			undefined,
			mode,
		);

		expect(allocations.map((a) => a.key)).toEqual(['experiment-alloc', 'full']);
		expect(allocations[0].exposure_schedule).toEqual({
			rollout_options: { strategy: 'NO_ROLLOUT', scheduled_start: 'now' },
			rollout_steps: [
				{
					exposure_ratio: 0.3333,
					interval_ms: null,
					is_pause_record: false,
					grouped_step_index: 0,
				},
			],
		});
		expect(allocations[1].exposure_schedule).toBeUndefined();
	});

	it('suffixes keys with the environment when one Eppo environment maps to several', () => {
		const flag = splitFlag({ allocations: [experiment()] });
		const oneToMany = new Map([[PROD_ENV_ID, [ddProd, ddStaging]]]);

		const eppo = buildAllocations(
			flag,
			oneToMany,
			undefined,
			undefined,
			undefined,
			'EPPO',
		);
		expect(
			eppo.map((a) => [a.environment_id, a.key, a.eppo_allocation_id]),
		).toEqual([
			['dd-prod', 'experiment-alloc-production', 7001],
			['dd-staging', 'experiment-alloc-staging', 7001],
		]);

		// Legacy flags salt on the key, so their keys never change.
		const legacy = buildAllocations(flag, oneToMany);
		expect(legacy.map((a) => a.key)).toEqual([
			'experiment-alloc',
			'experiment-alloc',
		]);
	});

	it('keeps a split default as a catch-all targeting filter with its own Eppo IDs', () => {
		const flag = splitFlag({
			allocations: [
				pureDefault({
					variation_weight: [
						{ id: 911, variation_id: 200, weight: 1 },
						{ id: 912, variation_id: 100, weight: 1 },
					],
				}),
			],
		});
		const dvk = buildDefaultVariantKeyPerEnv(flag, prodOnly);
		const allocations = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			dvk,
			'EPPO',
		);

		expect(dvk.get('dd-prod')).toBe('treatment');
		expect(allocations).toHaveLength(1);
		expect(allocations[0]).toMatchObject({
			key: 'default-alloc',
			eppo_allocation_id: 7002,
			variant_weights: [
				{ variant_key: 'treatment', eppo_variant_weight_id: 911 },
				{ variant_key: 'control', eppo_variant_weight_id: 912 },
			],
		});
		expect(allocations[0].targeting_rules).toBeUndefined();
	});
});

describe('buildDefaultVariantKeyPerEnv', () => {
	it('maps a single-variation default and omits its allocation', () => {
		const flag = splitFlag({ allocations: [pureDefault()] });
		const dvk = buildDefaultVariantKeyPerEnv(flag, prodOnly);
		expect(dvk).toEqual(new Map([['dd-prod', 'control']]));
		expect(
			buildAllocations(flag, prodOnly, undefined, undefined, dvk, 'EPPO'),
		).toEqual([]);
	});

	it('maps a split default to its first variation in split order', () => {
		const flag = splitFlag({
			allocations: [
				pureDefault({
					variation_weight: [
						{ id: 911, variation_id: 200, weight: 1 },
						{ id: 912, variation_id: 100, weight: 1 },
					],
				}),
			],
		});
		expect(buildDefaultVariantKeyPerEnv(flag, prodOnly)).toEqual(
			new Map([['dd-prod', 'treatment']]),
		);
	});

	it('ignores disabled, partially exposed and deactivated defaults', () => {
		for (const allocation of [
			pureDefault({ enabled: false }),
			pureDefault({ percent_exposure: 0.5 }),
			pureDefault({
				variation_weight: [{ id: 903, variation_id: 300, weight: 100 }],
			}),
		]) {
			const flag = splitFlag({ allocations: [allocation] });
			expect(buildDefaultVariantKeyPerEnv(flag, prodOnly).size).toBe(0);
		}
	});

	it('keeps a partially exposed default as a targeting filter', () => {
		const flag = splitFlag({
			allocations: [pureDefault({ percent_exposure: 0.5 })],
		});
		const dvk = buildDefaultVariantKeyPerEnv(flag, prodOnly);
		const allocations = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			dvk,
			'EPPO',
		);
		expect(allocations).toHaveLength(1);
		expect(
			allocations[0].exposure_schedule?.rollout_steps[0].exposure_ratio,
		).toBe(0.5);
	});

	it('gives environments without a default the chosen variant', () => {
		const flag = splitFlag({
			allocations: [
				experiment(),
				experiment({
					id: 8001,
					key: 'staging-exp',
					environment_id: STAGING_ENV_ID,
				}),
			],
		});
		const mapping = new Map<number, DatadogEnvironment>([
			[PROD_ENV_ID, ddProd],
			[STAGING_ENV_ID, ddStaging],
		]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping, 'treatment')).toEqual(
			new Map([
				['dd-prod', 'treatment'],
				['dd-staging', 'treatment'],
			]),
		);
	});

	it('keeps a partially exposed default as a targeting filter when the environment gets a chosen default', () => {
		const flag = splitFlag({
			allocations: [pureDefault({ percent_exposure: 0.5 })],
		});
		const dvk = buildDefaultVariantKeyPerEnv(flag, prodOnly, 'treatment');
		const allocations = buildAllocations(
			flag,
			prodOnly,
			undefined,
			undefined,
			dvk,
			'EPPO',
		);
		expect(dvk.get('dd-prod')).toBe('treatment');
		expect(allocations.map((a) => a.key)).toEqual(['default-alloc']);
	});
});

describe('environments without a default', () => {
	const mapping = new Map<number, DatadogEnvironment>([
		[PROD_ENV_ID, ddProd],
		[STAGING_ENV_ID, ddStaging],
	]);

	it('lists production environments without a default, mapped or not', () => {
		const flag = splitFlag({ allocations: [experiment()] });
		expect(productionEnvironmentsWithoutDefault(flag)).toEqual(['production']);
		expect(
			productionEnvironmentsWithoutDefault(
				splitFlag({ allocations: [pureDefault()] }),
			),
		).toEqual([]);
	});

	it('lists mapped active environments without a default', () => {
		const flag = splitFlag({
			environments: [
				{
					id: PROD_ENV_ID,
					name: 'production',
					active: true,
					is_production: true,
				},
				{
					id: STAGING_ENV_ID,
					name: 'staging',
					active: true,
					is_production: false,
				},
				{ id: 30, name: 'qa', active: true, is_production: false },
			],
			allocations: [pureDefault()],
		});
		expect(activeEnvironmentsWithoutDefault(flag, mapping)).toEqual([
			'staging',
		]);
	});
});

describe('findEppoMigrationBlockers', () => {
	const mapping = new Map<number, DatadogEnvironment>([
		[PROD_ENV_ID, ddProd],
		[STAGING_ENV_ID, ddStaging],
	]);

	function blockers(
		flag: EppoFlag,
		map: Map<number, DatadogEnvironment | DatadogEnvironment[]> = mapping,
		mode: 'EPPO' | 'DATADOG' = 'EPPO',
	): string[] {
		const dvk = buildDefaultVariantKeyPerEnv(flag, map);
		return findEppoMigrationBlockers(
			flag,
			map,
			buildAllocations(flag, map, undefined, undefined, dvk, mode),
			mode,
		);
	}

	it('applies the default and weight rules to flags migrated before Eppo bucketing', () => {
		expect(
			blockers(splitFlag({ allocations: [experiment()] }), mapping, 'DATADOG'),
		).toEqual([expect.stringContaining('Eppo serves no default')]);
		expect(
			blockers(
				splitFlag({
					allocations: [
						experiment({
							variation_weight: [
								{ id: 901, variation_id: 200, weight: 0 },
								{ id: 902, variation_id: 100, weight: 0 },
							],
						}),
						pureDefault(),
					],
				}),
				mapping,
				'DATADOG',
			),
		).toEqual([expect.stringContaining('has no non-zero weights')]);
	});

	it('does not require weight IDs for flags migrated before Eppo bucketing, which never send them', () => {
		const flag = splitFlag({
			allocations: [
				experiment({
					variation_weight: [
						{ variation_id: 200, weight: 1 },
						{ variation_id: 100, weight: 1 },
					],
				}),
				pureDefault({ variation_weight: [{ variation_id: 100, weight: 100 }] }),
			],
		});
		expect(blockers(flag, mapping, 'DATADOG')).toEqual([]);
		expect(blockers(flag, mapping, 'EPPO')).toEqual([
			expect.stringContaining('Eppo did not return variation weight IDs'),
		]);
	});

	it('fails a one-to-many mapping for flags migrated before Eppo bucketing instead of renaming keys', () => {
		const flag = splitFlag({ allocations: [experiment(), pureDefault()] });
		const oneToMany = new Map([[PROD_ENV_ID, [ddProd, ddStaging]]]);
		expect(blockers(flag, oneToMany, 'EPPO')).toEqual([]);
		expect(blockers(flag, oneToMany, 'DATADOG')).toEqual([
			expect.stringContaining(
				'"experiment-alloc" would be used more than once',
			),
		]);
	});

	it('allows a flag with a default in every active environment', () => {
		expect(
			blockers(splitFlag({ allocations: [experiment(), pureDefault()] })),
		).toEqual([]);
	});

	it('fails a production environment with no default', () => {
		expect(blockers(splitFlag({ allocations: [experiment()] }))).toEqual([
			'Flag "checkout-redesign" (production): Eppo serves no default; unmatched subjects receive the SDK fallback value, which Datadog cannot represent. Set a default variation in Eppo, or run the migration interactively to choose one, and re-run the migration.',
		]);
	});

	it('fails a disabled or unmapped production environment with no default', () => {
		const disabledProduction = splitFlag({
			environments: [
				{
					id: PROD_ENV_ID,
					name: 'production',
					active: false,
					is_production: true,
				},
				{
					id: STAGING_ENV_ID,
					name: 'staging',
					active: false,
					is_production: false,
				},
			],
		});
		expect(blockers(disabledProduction)).toEqual([
			expect.stringContaining(
				'Flag "checkout-redesign" (production): Eppo serves no default',
			),
		]);

		const stagingOnly = new Map<number, DatadogEnvironment>([
			[STAGING_ENV_ID, ddStaging],
		]);
		expect(blockers(splitFlag(), stagingOnly)).toEqual([
			expect.stringContaining('(production): Eppo serves no default'),
		]);
	});

	it('fails an active non-production environment with no default', () => {
		const flag = splitFlag({
			environments: [
				{
					id: PROD_ENV_ID,
					name: 'production',
					active: true,
					is_production: true,
				},
				{
					id: STAGING_ENV_ID,
					name: 'staging',
					active: true,
					is_production: false,
				},
			],
			allocations: [pureDefault()],
		});
		expect(blockers(flag)).toEqual([
			'Flag "checkout-redesign" (staging): Eppo serves no default; unmatched subjects receive the SDK fallback value, which Datadog cannot represent. Set a default variation in Eppo and re-run the migration.',
		]);
	});

	it('allows missing defaults that a chosen variant or existing defaults cover', () => {
		const flag = splitFlag({
			environments: [
				{
					id: PROD_ENV_ID,
					name: 'production',
					active: true,
					is_production: true,
				},
				{
					id: STAGING_ENV_ID,
					name: 'staging',
					active: true,
					is_production: false,
				},
			],
			allocations: [experiment()],
		});
		const allocations = buildAllocations(
			flag,
			mapping,
			undefined,
			undefined,
			undefined,
			'EPPO',
		);
		expect(
			findEppoMigrationBlockers(flag, mapping, allocations, 'EPPO', {
				coveredDefaults: true,
			}),
		).toEqual([]);
	});

	it('allows an inactive environment with no default', () => {
		const flag = splitFlag({
			allocations: [
				pureDefault(),
				experiment({
					id: 8001,
					key: 'staging-exp',
					environment_id: STAGING_ENV_ID,
				}),
			],
		});
		expect(blockers(flag)).toEqual([]);
	});

	it.each([
		[
			'a targeted default',
			pureDefault({ targeting_rules: experiment().targeting_rules }),
		],
		['a disabled default', pureDefault({ enabled: false })],
		['a zero-exposure default', pureDefault({ percent_exposure: 0 })],
	])('fails an active environment with %s', (_label, allocation) => {
		expect(blockers(splitFlag({ allocations: [allocation] }))).toEqual([
			expect.stringContaining('Eppo serves no default'),
		]);
	});

	it('fails a default below 100% exposure', () => {
		expect(
			blockers(
				splitFlag({ allocations: [pureDefault({ percent_exposure: 0.25 })] }),
			),
		).toEqual([
			'Flag "checkout-redesign" (production): Eppo\'s default serves only 25% of subjects; the rest receive the SDK fallback value, which Datadog cannot represent. Set a default variation in Eppo, or run the migration interactively to choose one, and re-run the migration.',
		]);
	});

	it('fails a split whose active weights are all zero', () => {
		const flag = splitFlag({
			allocations: [
				experiment({
					variation_weight: [
						{ id: 901, variation_id: 200, weight: 0 },
						{ id: 902, variation_id: 100, weight: 0 },
						{ id: 903, variation_id: 300, weight: 100 },
					],
				}),
				pureDefault(),
			],
		});
		expect(blockers(flag)).toEqual([
			'Flag "checkout-redesign" (production): targeting filter "Experiment" has no non-zero weights on active variations. Give one variation a weight in Eppo and re-run the migration.',
		]);
	});

	it('fails a split without variation weight IDs, but not a single-variation allocation', () => {
		const withoutIds = splitFlag({
			allocations: [
				experiment({
					variation_weight: [
						{ variation_id: 200, weight: 1 },
						{ variation_id: 100, weight: 1 },
					],
				}),
				pureDefault({
					variation_weight: [{ variation_id: 100, weight: 100 }],
				}),
			],
		});
		expect(blockers(withoutIds)).toEqual([
			expect.stringContaining('Eppo did not return variation weight IDs'),
		]);

		const singleVariation = splitFlag({
			allocations: [
				experiment({
					variation_weight: [
						{ variation_id: 200, weight: 1 },
						{ variation_id: 100, weight: 0 },
					],
				}),
				pureDefault({
					variation_weight: [{ variation_id: 100, weight: 100 }],
				}),
			],
		});
		expect(blockers(singleVariation)).toEqual([]);
	});

	it('fails a split default without variation weight IDs', () => {
		const flag = splitFlag({
			allocations: [
				pureDefault({
					variation_weight: [
						{ variation_id: 200, weight: 1 },
						{ variation_id: 100, weight: 1 },
					],
				}),
			],
		});
		expect(blockers(flag)).toEqual([
			expect.stringContaining('Eppo did not return variation weight IDs'),
		]);
	});

	it('fails allocation keys that would collide in Datadog', () => {
		const flag = splitFlag({
			allocations: [
				experiment(),
				experiment({ id: 7005, name: 'Duplicate' }),
				pureDefault(),
			],
		});
		expect(blockers(flag)).toEqual([
			'Flag "checkout-redesign": targeting filter key(s) "experiment-alloc" would be used more than once, but Datadog requires them to be unique. Rename the Eppo allocations and re-run the migration.',
		]);
	});
});

describe('resolveFlagDefaultVariantKey', () => {
	const flag = splitFlag();
	const variants = buildVariants(flag);
	const mapping = new Map<number, DatadogEnvironment[]>([
		[STAGING_ENV_ID, [ddStaging]],
		[PROD_ENV_ID, [ddDev, ddProd]],
	]);

	it("prefers the production environment's default", () => {
		const perEnv = new Map([
			['dd-staging', 'legacy'],
			['dd-dev', 'treatment'],
			['dd-prod', 'control'],
		]);
		expect(resolveFlagDefaultVariantKey(flag, mapping, perEnv, variants)).toBe(
			'control',
		);
	});

	it('then an active environment, then any mapped environment', () => {
		expect(
			resolveFlagDefaultVariantKey(
				flag,
				mapping,
				new Map([
					['dd-staging', 'legacy'],
					['dd-dev', 'treatment'],
				]),
				variants,
			),
		).toBe('treatment');
		expect(
			resolveFlagDefaultVariantKey(
				flag,
				mapping,
				new Map([['dd-staging', 'legacy']]),
				variants,
			),
		).toBe('legacy');
	});

	it("uses the Eppo production default even when production isn't mapped", () => {
		const withProductionDefault = splitFlag({
			allocations: [
				pureDefault({
					variation_weight: [{ id: 903, variation_id: 200, weight: 100 }],
				}),
			],
		});
		expect(
			resolveFlagDefaultVariantKey(
				withProductionDefault,
				new Map([[STAGING_ENV_ID, [ddStaging]]]),
				new Map(),
				variants,
			),
		).toBe('treatment');
	});

	it('uses the chosen variant when production has no default', () => {
		expect(
			resolveFlagDefaultVariantKey(
				flag,
				mapping,
				new Map([['dd-staging', 'legacy']]),
				variants,
				'treatment',
			),
		).toBe('treatment');
	});

	it('falls back to the first variant when no environment has a default', () => {
		expect(
			resolveFlagDefaultVariantKey(flag, mapping, new Map(), variants),
		).toBe('control');
	});
});

describe('classifyExistingFlag', () => {
	const base: DatadogFlagEntry = { id: 'dd-1', key: 'checkout-redesign' };

	it.each<[string, DatadogFlagEntry, string]>([
		[
			'an EPPO flag',
			{
				...base,
				bucketing_mode: 'EPPO',
				migration_metadata: { provider: 'eppo' },
			},
			'eppo',
		],
		[
			'a DATADOG flag migrated from Eppo',
			{
				...base,
				bucketing_mode: 'DATADOG',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			},
			'legacy',
		],
		[
			'an Eppo-migrated flag from an API without bucketing modes',
			{ ...base, migration_metadata: { provider: 'eppo', source_id: '1' } },
			'legacy',
		],
		['a native flag', { ...base, bucketing_mode: 'DATADOG' }, 'native'],
		[
			'a flag migrated from another provider',
			{ ...base, migration_metadata: { provider: 'launchdarkly' } },
			'native',
		],
	])('classifies %s', (_label, entry, kind) => {
		expect(classifyExistingFlag(entry)).toBe(kind);
	});
});

describe('toCreateFlagVariants', () => {
	it('stamps Eppo migration metadata instead of sending sourceId', () => {
		const variants = toCreateFlagVariants(buildVariants(splitFlag()));
		expect(variants[0]).toEqual({
			key: 'control',
			name: 'Control',
			value: 'control',
			migration_metadata: {
				provider: 'eppo',
				source_id: '100',
				source_key: 'control',
			},
		});
		expect(variants.some((variant) => 'sourceId' in variant)).toBe(false);
	});
});

describe('buildExposureSchedule', () => {
	it.each([0, 1, 1.5, -0.1, Number.NaN])('returns nothing for %s', (pct) => {
		expect(buildExposureSchedule(pct)).toBeUndefined();
	});

	it('uses the 0–1 exposure as the step ratio', () => {
		expect(buildExposureSchedule(0.0001)?.rollout_steps).toEqual([
			{
				exposure_ratio: 0.0001,
				interval_ms: null,
				is_pause_record: false,
				grouped_step_index: 0,
			},
		]);
	});
});
