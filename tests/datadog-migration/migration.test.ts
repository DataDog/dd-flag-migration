import { describe, expect, it } from '@jest/globals';
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogStatusAllocation,
	DatadogStatusFlagDetail,
	EnvironmentMapping,
} from '../../src/datadog/types.js';
import {
	buildDatadogAllocations,
	buildDatadogCreateFlagRequest,
	buildDatadogDefaultVariantKeyPerEnv,
	buildDatadogSourceVariants,
	buildDatadogVariantSyncRequests,
	datadogDistributionChannel,
	datadogValueType,
	discoverSavedFilterRefs,
	findTargetFlag,
	getDatadogEnvsToDisable,
	getDatadogEnvsToEnable,
	liveAllocations,
	planDatadogVariantSync,
	unsupportedTargetingReason,
} from '../../src/datadog-migration/helpers/migration.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const targetProd: DatadogEnvironment = {
	id: 'target-prod',
	name: 'Production',
	is_production: true,
	queries: ['prod'],
};
const targetQa: DatadogEnvironment = {
	id: 'target-qa',
	name: 'QA Env',
	is_production: false,
	queries: ['qa'],
};
const targetStaging: DatadogEnvironment = {
	id: 'target-staging',
	name: 'Staging',
	is_production: false,
	queries: ['staging'],
};

function allocation(
	overrides: Partial<DatadogStatusAllocation> & { key: string },
): DatadogStatusAllocation {
	return {
		name: overrides.key,
		type: 'FEATURE_GATE',
		status: 'published',
		targeting_rules: [],
		variant_weights: [{ variant_id: 'source-on', value: 100 }],
		...overrides,
	};
}

function sourceFlag(
	overrides: Partial<DatadogStatusFlagDetail> = {},
): DatadogStatusFlagDetail {
	return {
		id: 'source-flag-id',
		key: 'example-flag',
		name: 'Example Flag',
		description: 'An example flag',
		valueType: 'BOOLEAN',
		distributionChannel: 'ALL',
		tags: ['team:example'],
		variants: [
			{ id: 'source-on', key: 'on', name: 'On', value: 'true' },
			{ id: 'source-off', key: 'off', name: 'Off', value: 'false' },
		],
		environments: [
			{
				environmentId: 'source-prod',
				status: 'ENABLED',
				defaultVariantKey: 'off',
				allocations: [
					allocation({
						key: 'example-flag-prod-rule-0',
						name: 'Beta users',
						order_position: 0,
						targeting_rules: [
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'id', value: ['user-a'] },
								],
							},
						],
					}),
				],
			},
			{
				environmentId: 'source-staging',
				status: 'DISABLED',
				defaultVariantKey: 'on',
				allocations: null,
			},
		],
		...overrides,
	};
}

function mapping(
	entries: Array<[string, DatadogEnvironment[]]>,
): EnvironmentMapping<string> {
	return new Map(entries);
}

// ─── Flag matching ────────────────────────────────────────────────────────────

describe('findTargetFlag', () => {
	const sameKey: DatadogFlagEntry = { id: 'target-a', key: 'example-flag' };
	const migrated: DatadogFlagEntry = {
		id: 'target-b',
		key: 'example-flag',
		migration_metadata: { provider: 'datadog', source_id: 'source-flag-id' },
	};

	it('prefers Datadog migration metadata', () => {
		expect(
			findTargetFlag([sameKey, migrated], {
				id: 'source-flag-id',
				key: 'example-flag',
			}),
		).toBe(migrated);
	});

	it('falls back to the flag key, regardless of other provider metadata', () => {
		const fromLaunchDarkly: DatadogFlagEntry = {
			id: 'target-c',
			key: 'example-flag',
			migration_metadata: { project_key: 'project', flag_key: 'example-flag' },
		};
		expect(
			findTargetFlag([fromLaunchDarkly], {
				id: 'source-flag-id',
				key: 'example-flag',
			}),
		).toBe(fromLaunchDarkly);
	});

	it('returns undefined when no flag matches', () => {
		expect(
			findTargetFlag([sameKey], { id: 'other', key: 'other-flag' }),
		).toBeUndefined();
	});
});

// ─── Attributes ───────────────────────────────────────────────────────────────

describe('flag attributes', () => {
	it('accepts known value types and distribution channels only', () => {
		expect(datadogValueType(sourceFlag())).toBe('BOOLEAN');
		expect(datadogValueType(sourceFlag({ valueType: 'DATE' }))).toBeUndefined();
		expect(datadogDistributionChannel(sourceFlag())).toBe('ALL');
		expect(
			datadogDistributionChannel(sourceFlag({ distributionChannel: 'BOTH' })),
		).toBeUndefined();
	});
});

// ─── Variants ─────────────────────────────────────────────────────────────────

describe('planDatadogVariantSync', () => {
	const source = buildDatadogSourceVariants(sourceFlag());

	it('uses source variant UUIDs as source IDs', () => {
		expect(source.map((variant) => variant.sourceId)).toEqual([
			'source-on',
			'source-off',
		]);
	});

	it('matches by key and only updates changed name or value', () => {
		const plan = planDatadogVariantSync(source, [
			{
				id: 'target-on',
				key: 'on',
				name: 'On',
				value: 'true',
				migration_metadata: { provider: 'launchdarkly', source_id: 'ld-id' },
			},
			{ id: 'target-off', key: 'off', name: 'Disabled', value: 'false' },
		]);
		expect(plan.toCreate).toEqual([]);
		expect(plan.toUpdate).toEqual([
			{
				id: 'target-off',
				key: 'off',
				name: 'Off',
				value: 'false',
				sourceId: 'source-off',
				sourceKey: 'off',
			},
		]);
		expect(plan.toDelete).toEqual([]);
	});

	it('creates missing variants and deletes target-only variants', () => {
		const plan = planDatadogVariantSync(source, [
			{ id: 'target-on', key: 'on', name: 'On', value: 'true' },
			{ id: 'target-extra', key: 'extra', name: 'Extra', value: 'true' },
		]);
		expect(plan.toCreate.map((variant) => variant.key)).toEqual(['off']);
		expect(plan.toDelete).toEqual([{ id: 'target-extra', key: 'extra' }]);
	});

	it('records metadata on creates but not on updates', () => {
		const plan = planDatadogVariantSync(source, [
			{ id: 'target-on', key: 'on', name: 'Renamed', value: 'true' },
		]);
		const { createUpdateRequests, deleteRequests } =
			buildDatadogVariantSyncRequests('target-flag', plan);
		expect(createUpdateRequests).toEqual([
			{
				method: 'PUT',
				path: '/api/v2/feature-flags/target-flag/variants/target-on',
				body: {
					data: {
						type: 'variants',
						id: 'target-on',
						attributes: { name: 'On', value: 'true' },
					},
				},
			},
			{
				method: 'POST',
				path: '/api/v2/feature-flags/target-flag/variants',
				body: {
					data: {
						type: 'variants',
						attributes: {
							key: 'off',
							name: 'Off',
							value: 'false',
							migration_metadata: {
								provider: 'datadog',
								source_id: 'source-off',
								source_key: 'off',
							},
						},
					},
				},
			},
		]);
		expect(deleteRequests).toEqual([]);
	});
});

// ─── Targeting ────────────────────────────────────────────────────────────────

describe('liveAllocations', () => {
	it('drops drafts and sorts by order position', () => {
		const result = liveAllocations({
			allocations: [
				allocation({ key: 'second', order_position: 1 }),
				allocation({ key: 'draft', order_position: 0, status: 'draft' }),
				allocation({ key: 'first', order_position: 0 }),
			],
		});
		expect(result.map((item) => item.key)).toEqual(['first', 'second']);
	});
});

describe('unsupportedTargetingReason', () => {
	const prodOnly = mapping([['source-prod', [targetProd]]]);
	const names = new Map([['source-prod', 'Production']]);

	it('accepts plain targeting filters', () => {
		expect(
			unsupportedTargetingReason(sourceFlag(), prodOnly, names),
		).toBeUndefined();
	});

	it.each([
		[{ type: 'CANARY' }, /CANARY progressive rollout/],
		[{ experiment_id: 'experiment-1' }, /linked to an experiment/],
		[{ exposure_schedule: { steps: [] } }, /scheduled rollout/],
	])('rejects %o', (overrides, message) => {
		const flag = sourceFlag();
		flag.environments[0].allocations = [
			allocation({ key: 'rollout', ...overrides }),
		];
		expect(unsupportedTargetingReason(flag, prodOnly, names)).toMatch(message);
	});

	it('rejects environment overrides only where the source is enabled', () => {
		const flag = sourceFlag();
		flag.environments[0].overrideVariantKey = 'on';
		flag.environments[1].overrideVariantKey = 'on';
		expect(unsupportedTargetingReason(flag, prodOnly, names)).toBe(
			'Environment override is set in Production',
		);
		expect(
			unsupportedTargetingReason(
				flag,
				mapping([['source-staging', [targetStaging]]]),
			),
		).toBeUndefined();
	});
});

describe('discoverSavedFilterRefs', () => {
	it('finds saved filter references in mapped environments only', () => {
		const flag = sourceFlag();
		flag.environments[0].allocations = [
			allocation({
				key: 'segment',
				targeting_rules: [{ conditions: [{ saved_filter_id: 'filter-a' }] }],
			}),
		];
		flag.environments[1].allocations = [
			allocation({
				key: 'other',
				targeting_rules: [{ conditions: [{ saved_filter_id: 'filter-b' }] }],
			}),
		];
		expect(discoverSavedFilterRefs([flag], ['source-prod'])).toEqual([
			'filter-a',
		]);
	});
});

describe('buildDatadogAllocations', () => {
	it('copies targeting filters with variant keys and the source key', () => {
		const result = buildDatadogAllocations(
			sourceFlag(),
			mapping([['source-prod', [targetProd]]]),
		);
		expect(result).toEqual({
			allocations: [
				{
					environment_id: 'target-prod',
					name: 'Beta users',
					key: 'example-flag-prod-rule-0',
					type: 'FEATURE_GATE',
					variant_weights: [{ variant_key: 'on', value: 100 }],
					targeting_rules: [
						{
							conditions: [
								{ operator: 'ONE_OF', attribute: 'id', value: ['user-a'] },
							],
						},
					],
				},
			],
		});
	});

	it('suffixes keys when one source environment maps to several targets', () => {
		const result = buildDatadogAllocations(
			sourceFlag(),
			mapping([['source-prod', [targetProd, targetQa]]]),
		);
		expect(
			'allocations' in result && result.allocations.map((a) => a.key),
		).toEqual([
			'example-flag-prod-rule-0-production',
			'example-flag-prod-rule-0-qa-env',
		]);
	});

	it('remaps saved filter references to target IDs', () => {
		const flag = sourceFlag();
		flag.environments[0].allocations = [
			allocation({
				key: 'segment',
				targeting_rules: [
					{ conditions: [{ saved_filter_id: 'source-filter' }] },
				],
			}),
		];
		const result = buildDatadogAllocations(
			flag,
			mapping([['source-prod', [targetProd]]]),
			new Map([['source-filter', 'target-filter']]),
		);
		expect(
			'allocations' in result &&
				result.allocations[0].targeting_rules?.[0].conditions,
		).toEqual([{ saved_filter_id: 'target-filter' }]);
	});

	it('skips the flag when a saved filter could not be migrated', () => {
		const flag = sourceFlag();
		flag.environments[0].allocations = [
			allocation({
				key: 'segment',
				targeting_rules: [{ conditions: [{ saved_filter_id: 'missing' }] }],
			}),
		];
		expect(
			buildDatadogAllocations(flag, mapping([['source-prod', [targetProd]]])),
		).toEqual({ flagSkip: 'Saved filter missing could not be migrated' });
	});

	it('skips the flag when a weight references an unknown variant', () => {
		const flag = sourceFlag();
		flag.environments[0].allocations = [
			allocation({
				key: 'broken',
				variant_weights: [{ variant_id: 'unknown', value: 100 }],
			}),
		];
		expect(
			buildDatadogAllocations(flag, mapping([['source-prod', [targetProd]]])),
		).toEqual({
			flagSkip: 'Targeting filter "broken" references an unknown variant',
		});
	});
});

// ─── Environment state ────────────────────────────────────────────────────────

describe('environment state', () => {
	const envMapping = mapping([
		['source-prod', [targetProd, targetQa]],
		['source-staging', [targetStaging]],
	]);

	it('maps default variants to every mapped target environment', () => {
		expect(
			buildDatadogDefaultVariantKeyPerEnv(sourceFlag(), envMapping),
		).toEqual(
			new Map([
				['target-prod', 'off'],
				['target-qa', 'off'],
				['target-staging', 'on'],
			]),
		);
	});

	it('enables targets of enabled sources and disables the rest', () => {
		expect(
			getDatadogEnvsToEnable(sourceFlag(), envMapping).map((env) => env.id),
		).toEqual(['target-prod', 'target-qa']);
		expect(
			getDatadogEnvsToDisable(sourceFlag(), envMapping).map((env) => env.id),
		).toEqual(['target-staging']);
	});
});

// ─── Creation ─────────────────────────────────────────────────────────────────

describe('buildDatadogCreateFlagRequest', () => {
	it('copies flag attributes and records Datadog migration metadata', () => {
		const request = buildDatadogCreateFlagRequest(
			sourceFlag({ jsonSchema: undefined }),
			'BOOLEAN',
			[],
			'datadoghq.com',
		);
		expect(request).toEqual({
			key: 'example-flag',
			name: 'Example Flag',
			description: 'An example flag',
			value_type: 'BOOLEAN',
			variants: [
				{ key: 'on', name: 'On', value: 'true' },
				{ key: 'off', name: 'Off', value: 'false' },
			],
			allocations: undefined,
			migration_metadata: {
				provider: 'datadog',
				source_id: 'source-flag-id',
				source_key: 'example-flag',
				source_site: 'datadoghq.com',
			},
			distribution_channel: 'ALL',
			tags: ['team:example'],
		});
	});
});
