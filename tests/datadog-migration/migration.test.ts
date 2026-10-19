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
	matchDatadogVariants,
	planDatadogVariantSync,
	remapAllocationVariantKeys,
	remapDefaultVariantKeys,
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

describe('matchDatadogVariants', () => {
	const source = buildDatadogSourceVariants(sourceFlag());

	it('matches variants with different keys by unique value', () => {
		const matches = matchDatadogVariants(source, [
			{
				id: 'target-0',
				key: 'variation-0',
				name: 'Variation 0',
				value: 'true',
			},
			{
				id: 'target-1',
				key: 'variation-1',
				name: 'Variation 1',
				value: 'false',
			},
		]);
		expect(matches.get('on')?.id).toBe('target-0');
		expect(matches.get('off')?.id).toBe('target-1');
	});

	it('matches by unique name when keys and values differ', () => {
		const matches = matchDatadogVariants(
			[{ key: 'variation-2', name: 'Third', value: '"c"', sourceId: 's-2' }],
			[{ id: 'target-2', key: 'third', name: 'Third', value: '"z"' }],
		);
		expect(matches.get('variation-2')?.id).toBe('target-2');
	});

	it('prefers a Datadog source ID over a key match on another variant', () => {
		const matches = matchDatadogVariants(source, [
			{
				id: 'target-a',
				key: 'off',
				name: 'Off',
				value: 'false',
				migration_metadata: { provider: 'datadog', source_id: 'source-on' },
			},
			{
				id: 'target-b',
				key: 'on',
				name: 'On',
				value: 'true',
				migration_metadata: { provider: 'datadog', source_id: 'source-off' },
			},
		]);
		expect(matches.get('on')?.id).toBe('target-a');
		expect(matches.get('off')?.id).toBe('target-b');
	});

	it('ignores source IDs recorded by other providers', () => {
		const matches = matchDatadogVariants(source, [
			{
				id: 'target-a',
				key: 'off',
				name: 'Off',
				value: 'false',
				migration_metadata: {
					provider: 'launchdarkly',
					source_id: 'source-on',
				},
			},
		]);
		expect(matches.get('off')?.id).toBe('target-a');
		expect(matches.has('on')).toBe(false);
	});

	it('does not match by a name or value shared by several variants', () => {
		const matches = matchDatadogVariants(
			[{ key: 'a', name: 'Same', value: 'x', sourceId: 's-a' }],
			[
				{ id: 't-1', key: 'b', name: 'Same', value: 'x' },
				{ id: 't-2', key: 'c', name: 'Same', value: 'x' },
			],
		);
		expect(matches.size).toBe(0);
	});

	it('does not match by JSON value', () => {
		const matches = matchDatadogVariants(
			[{ key: 'a', name: 'A', value: '{"x":1}', sourceId: 's-a' }],
			[{ id: 't-1', key: 'b', name: 'B', value: '{"x":1}' }],
		);
		expect(matches.size).toBe(0);
	});
});

describe('planDatadogVariantSync key translation', () => {
	const source = buildDatadogSourceVariants(sourceFlag());

	it('updates boolean variants with different keys instead of creating them', () => {
		const plan = planDatadogVariantSync(
			source,
			[
				{ id: 'target-0', key: 'variation-0', name: 'On', value: 'true' },
				{
					id: 'target-1',
					key: 'variation-1',
					name: 'Variation 1',
					value: 'false',
				},
			],
			'BOOLEAN',
		);
		expect(plan.toCreate).toEqual([]);
		expect(plan.toDelete).toEqual([]);
		expect(plan.toUpdate).toEqual([
			{
				id: 'target-1',
				key: 'variation-1',
				name: 'Off',
				value: 'false',
				sourceId: 'source-off',
				sourceKey: 'off',
			},
		]);
		expect(plan.targetKeys).toEqual(
			new Map([
				['on', 'variation-0'],
				['off', 'variation-1'],
			]),
		);
	});

	it('rejects creates on boolean flags with a clear error', () => {
		expect(() =>
			planDatadogVariantSync(
				source,
				[
					{ id: 't-1', key: 'a', name: 'A', value: 'true' },
					{ id: 't-2', key: 'b', name: 'B', value: 'true' },
				],
				'BOOLEAN',
			),
		).toThrow(/Could not match source variant\(s\) on, off/);
	});

	it('suffixes a created key that collides with a matched target variant', () => {
		const plan = planDatadogVariantSync(
			[
				{ key: 'a', name: 'A', value: '"1"', sourceId: 's-a' },
				{ key: 'b', name: 'B', value: '"2"', sourceId: 's-b' },
			],
			[
				{
					id: 't-1',
					key: 'b',
					name: 'Old',
					value: '"0"',
					migration_metadata: { provider: 'datadog', source_id: 's-a' },
				},
			],
			'STRING',
		);
		expect(plan.toCreate).toEqual([
			{ key: 'b-1', name: 'B', value: '"2"', sourceId: 's-b', sourceKey: 'b' },
		]);
		expect(plan.targetKeys).toEqual(
			new Map([
				['a', 'b'],
				['b', 'b-1'],
			]),
		);
		const { createUpdateRequests } = buildDatadogVariantSyncRequests(
			'target-flag',
			plan,
		);
		expect(createUpdateRequests[1].body).toMatchObject({
			data: {
				attributes: {
					key: 'b-1',
					migration_metadata: { source_id: 's-b', source_key: 'b' },
				},
			},
		});
	});

	it('remaps targeting and default variant keys to target keys', () => {
		const targetKeys = new Map([
			['on', 'variation-0'],
			['off', 'variation-1'],
		]);
		const [remapped] = remapAllocationVariantKeys(
			[
				{
					key: 'rule',
					variant_weights: [
						{ variant_key: 'on', value: 60 },
						{ variant_key: 'off', value: 40 },
					],
				},
			],
			targetKeys,
		);
		expect(remapped.variant_weights).toEqual([
			{ variant_key: 'variation-0', value: 60 },
			{ variant_key: 'variation-1', value: 40 },
		]);
		expect(
			remapDefaultVariantKeys(new Map([['target-prod', 'off']]), targetKeys),
		).toEqual(new Map([['target-prod', 'variation-1']]));
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
