/**
 * Unit tests for Eppo → Datadog migration functions:
 * mapVariationType, mapOperator, buildTargetingRules, buildAllocations, getEnvsToEnable,
 * hasSemverConditions, buildDefaultVariantKeyPerEnv.
 */
import { describe, expect, it } from '@jest/globals';
import {
	buildAllocations,
	buildDefaultVariantKeyPerEnv,
	buildTargetingRules,
	getEnvsToEnable,
	hasSemverConditions,
	mapOperator,
	mapVariationType,
} from '../../src/eppo/migration.js';
import type {
	DatadogAllocationForFlagCreation,
	DatadogEnvironment,
} from '../../src/types.js';
import { ddDev, ddProd, makeAllocation, makeFlag } from './helpers.js';

// ─── mapVariationType ─────────────────────────────────────────────────────────

describe('mapVariationType', () => {
	it('maps BOOLEAN to BOOLEAN', () => {
		expect(mapVariationType('BOOLEAN')).toBe('BOOLEAN');
	});

	it('maps boolean (lowercase) to BOOLEAN', () => {
		expect(mapVariationType('boolean')).toBe('BOOLEAN');
	});

	it('maps INTEGER to INTEGER', () => {
		expect(mapVariationType('INTEGER')).toBe('INTEGER');
	});

	it('maps NUMERIC to NUMERIC', () => {
		expect(mapVariationType('NUMERIC')).toBe('NUMERIC');
	});

	it('maps JSON to JSON', () => {
		expect(mapVariationType('JSON')).toBe('JSON');
	});

	it('maps STRING to STRING', () => {
		expect(mapVariationType('STRING')).toBe('STRING');
	});

	it('maps unknown types to STRING', () => {
		expect(mapVariationType('UNKNOWN')).toBe('STRING');
		expect(mapVariationType('custom')).toBe('STRING');
	});
});

// ─── mapOperator ──────────────────────────────────────────────────────────────

describe('mapOperator', () => {
	it('maps ONE_OF to ONE_OF', () => {
		expect(mapOperator('ONE_OF')).toBe('ONE_OF');
	});

	it('maps NOT_ONE_OF to NOT_ONE_OF', () => {
		expect(mapOperator('NOT_ONE_OF')).toBe('NOT_ONE_OF');
	});

	it('maps MATCHES to MATCHES', () => {
		expect(mapOperator('MATCHES')).toBe('MATCHES');
	});

	it('maps LT to LT when no values provided', () => {
		expect(mapOperator('LT')).toBe('LT');
	});

	it('maps LTE to LTE when no values provided', () => {
		expect(mapOperator('LTE')).toBe('LTE');
	});

	it('maps GT to GT when no values provided', () => {
		expect(mapOperator('GT')).toBe('GT');
	});

	it('maps GTE to GTE when no values provided', () => {
		expect(mapOperator('GTE')).toBe('GTE');
	});

	it('maps IS_NULL to IS_NULL', () => {
		expect(mapOperator('IS_NULL')).toBe('IS_NULL');
	});

	it('passes through unknown operators uppercased', () => {
		expect(mapOperator('customOp')).toBe('CUSTOMOP');
	});

	it('handles lowercase known operators', () => {
		expect(mapOperator('one_of')).toBe('ONE_OF');
		expect(mapOperator('matches')).toBe('MATCHES');
	});

	// semver detection
	it('maps LT to SEMVER_LT when all values are valid semver', () => {
		expect(mapOperator('LT', ['2.3.0'])).toBe('SEMVER_LT');
	});

	it('maps LTE to SEMVER_LTE when all values are valid semver', () => {
		expect(mapOperator('LTE', ['1.0.0'])).toBe('SEMVER_LTE');
	});

	it('maps GT to SEMVER_GT when all values are valid semver', () => {
		expect(mapOperator('GT', ['0.9.1'])).toBe('SEMVER_GT');
	});

	it('maps GTE to SEMVER_GTE when all values are valid semver', () => {
		expect(mapOperator('GTE', ['2.10.0'])).toBe('SEMVER_GTE');
	});

	it('maps GTE to SEMVER_GTE for semver with pre-release tag', () => {
		expect(mapOperator('GTE', ['1.0.0-beta.1'])).toBe('SEMVER_GTE');
	});

	it('keeps LT as LT when values are numeric strings', () => {
		expect(mapOperator('LT', ['18'])).toBe('LT');
	});

	it('keeps GTE as GTE when values are numeric strings', () => {
		expect(mapOperator('GTE', ['100'])).toBe('GTE');
	});

	it('keeps LT as LT when values array is empty', () => {
		expect(mapOperator('LT', [])).toBe('LT');
	});

	it('keeps GTE as GTE when any value is not valid semver (mixed)', () => {
		expect(mapOperator('GTE', ['2.3.0', 'not-semver'])).toBe('GTE');
	});

	it('keeps GT as GT when value is a plain version string without patch', () => {
		expect(mapOperator('GT', ['2.3'])).toBe('GT');
	});
});

// ─── buildTargetingRules ──────────────────────────────────────────────────────

describe('buildTargetingRules', () => {
	it('returns empty array for allocation with no targeting rules', () => {
		const alloc = makeAllocation({ id: 1, targeting_rules: [] });
		expect(buildTargetingRules(alloc)).toEqual([]);
	});

	it('converts a simple ONE_OF condition', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{ operator: 'ONE_OF', attribute: 'country', values: ['US', 'CA'] },
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result).toEqual([
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', value: ['US', 'CA'] },
				],
			},
		]);
	});

	it('converts multiple conditions in a single rule', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
						{ operator: 'GTE', attribute: 'age', values: ['18'] },
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result).toHaveLength(1);
		expect(result[0].conditions).toHaveLength(2);
		expect(result[0].conditions[0].operator).toBe('ONE_OF');
		expect(result[0].conditions[1].operator).toBe('GTE');
	});

	it('converts multiple targeting rules', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
					],
				},
				{
					conditions: [
						{
							operator: 'MATCHES',
							attribute: 'email',
							values: ['.*@test.com'],
						},
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result).toHaveLength(2);
	});

	it('filters out rules with no conditions', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{ conditions: [] },
				{
					conditions: [
						{ operator: 'ONE_OF', attribute: 'plan', values: ['pro'] },
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result).toHaveLength(1);
		expect(result[0].conditions[0].attribute).toBe('plan');
	});

	it('handles undefined targeting_rules', () => {
		const alloc = makeAllocation({ id: 1 });
		alloc.targeting_rules = undefined as never;
		expect(buildTargetingRules(alloc)).toEqual([]);
	});

	it('maps condition values to the value field', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{
							operator: 'NOT_ONE_OF',
							attribute: 'group',
							values: ['beta', 'alpha'],
						},
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result[0].conditions[0].value).toEqual(['beta', 'alpha']);
	});

	it('maps GTE with semver values to SEMVER_GTE', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{
							operator: 'GTE',
							attribute: 'app.version',
							values: ['2.3.0'],
						},
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result[0].conditions[0].operator).toBe('SEMVER_GTE');
		expect(result[0].conditions[0].value).toEqual(['2.3.0']);
	});

	it('keeps GTE as GTE for numeric (non-semver) values', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [{ operator: 'GTE', attribute: 'age', values: ['18'] }],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result[0].conditions[0].operator).toBe('GTE');
	});

	it('falls back to numeric operator when only some values are valid semver', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{
							operator: 'LT',
							attribute: 'app.version',
							values: ['2.3.0', 'not-a-semver'],
						},
					],
				},
			],
		});
		const result = buildTargetingRules(alloc);
		expect(result[0].conditions[0].operator).toBe('LT');
	});
});

// ─── buildAllocations ─────────────────────────────────────────────────────────

describe('buildAllocations', () => {
	it('returns empty array when flag has no variations', () => {
		const flag = makeFlag({ id: 1, key: 'test', variations: [] });
		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		expect(buildAllocations(flag, mapping)).toEqual([]);
	});

	it('builds allocations from Eppo allocations with variant weights', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-prod',
					name: 'Production Allocation',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 70 },
						{ variation_id: 200, weight: 30 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(1);
		expect(allocations[0].environment_id).toBe('dd-prod');
		expect(allocations[0].name).toBe('Production Allocation');
		expect(allocations[0].key).toBe('alloc-prod');
		expect(allocations[0].type).toBe('FEATURE_GATE');
		expect(allocations[0].variant_weights).toEqual([
			{ variant_key: 'on', value: 70 },
			{ variant_key: 'off', value: 30 },
		]);
	});

	it('normalizes variant weights to percentages', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 3 },
						{ variation_id: 200, weight: 7 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations[0].variant_weights).toEqual([
			{ variant_key: 'on', value: 30 },
			{ variant_key: 'off', value: 70 },
		]);
	});

	it('returns no allocations for active env with no Eppo allocations (serves default)', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Development', active: true, is_production: false },
			],
			allocations: [],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(0);
	});

	it('returns no allocations for inactive env with no Eppo allocations', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Development', active: false, is_production: false },
			],
			allocations: [],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(0);
	});

	it('includes targeting rules on allocations', () => {
		const flag = makeFlag({
			id: 1,
			key: 'targeted-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
					targeting_rules: [
						{
							conditions: [
								{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
							],
						},
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations[0].targeting_rules).toEqual([
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', value: ['US'] },
				],
			},
		]);
	});

	it('omits targeting_rules when allocation has none', () => {
		const flag = makeFlag({
			id: 1,
			key: 'no-rules-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
					targeting_rules: [],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations[0].targeting_rules).toBeUndefined();
	});

	it('builds allocations for multiple environments', () => {
		const flag = makeFlag({
			id: 1,
			key: 'multi-env',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Development', active: true, is_production: false },
				{ id: 20, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
				}),
				makeAllocation({
					id: 2,
					environment_id: 20,
					variation_weight: [
						{ variation_id: 100, weight: 50 },
						{ variation_id: 200, weight: 50 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddDev],
			[20, ddProd],
		]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(2);
		expect(allocations[0].environment_id).toBe('dd-dev');
		expect(allocations[1].environment_id).toBe('dd-prod');
	});

	it('skips allocations with zero total weight', () => {
		const flag = makeFlag({
			id: 1,
			key: 'zero-weight',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 0 },
						{ variation_id: 200, weight: 0 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		// Should still produce allocation, just with 0 values
		expect(allocations).toHaveLength(1);
		expect(allocations[0].variant_weights).toEqual([
			{ variant_key: 'on', value: 0 },
			{ variant_key: 'off', value: 0 },
		]);
	});

	it('skips allocations with unknown variation_ids', () => {
		const flag = makeFlag({
			id: 1,
			key: 'unknown-var',
			variations: [{ id: 100, name: 'On', variant_key: 'on' }],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					variation_weight: [{ variation_id: 999, weight: 100 }],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		// Filtered out unknown variation_id 999, empty variant_weights → skipped
		expect(allocations).toHaveLength(0);
	});

	it('generates allocation key from flag key and env name when eppo key is missing', () => {
		const flag = makeFlag({
			id: 1,
			key: 'my-flag',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 42,
					key: '',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations[0].key).toBe('my-flag-production-42');
	});

	it('uses eppo allocation name, falls back to env name', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					name: '',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations[0].name).toBe('Production');
	});

	it('skips allocations with percent_exposure of 0 (Eppo passthrough)', () => {
		// A 0% serve / 100% passthrough allocation must be dropped entirely.
		// Without this guard, Datadog receives a catch-all allocation at 100% enabled.
		const flag = makeFlag({
			id: 1,
			key: 'test-flag',
			variations: [
				{ id: 100, name: 'enabled', variant_key: 'enabled' },
				{ id: 200, name: 'disabled', variant_key: 'disabled' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-passthrough',
					name: 'prod rollout',
					environment_id: 10,
					percent_exposure: 0,
					variation_weight: [{ variation_id: 100, weight: 100 }],
					targeting_rules: [],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(0);
	});

	it('handles multiple allocations per environment', () => {
		const flag = makeFlag({
			id: 1,
			key: 'multi-alloc',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-targeted',
					name: 'Targeted',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
					targeting_rules: [
						{
							conditions: [
								{ operator: 'ONE_OF', attribute: 'plan', values: ['pro'] },
							],
						},
					],
				}),
				makeAllocation({
					id: 2,
					key: 'alloc-default',
					name: 'Default',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 0 },
						{ variation_id: 200, weight: 100 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(2);
		expect(allocations[0].key).toBe('alloc-targeted');
		expect(allocations[0].targeting_rules).toBeDefined();
		expect(allocations[1].key).toBe('alloc-default');
		expect(allocations[1].targeting_rules).toBeUndefined();
	});
});

// ─── getEnvsToEnable ──────────────────────────────────────────────────────────

describe('getEnvsToEnable', () => {
	it('returns environments where flag is active', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			environments: [
				{ id: 10, name: 'Development', active: true, is_production: false },
				{ id: 20, name: 'Production', active: false, is_production: true },
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddDev],
			[20, ddProd],
		]);
		const result = getEnvsToEnable(flag, mapping);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('dd-dev');
	});

	it('returns empty when flag is inactive everywhere', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			environments: [
				{ id: 10, name: 'Development', active: false, is_production: false },
				{ id: 20, name: 'Production', active: false, is_production: true },
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddDev],
			[20, ddProd],
		]);
		expect(getEnvsToEnable(flag, mapping)).toEqual([]);
	});

	it('only returns mapped environments', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			environments: [
				{ id: 10, name: 'Development', active: true, is_production: false },
				{ id: 20, name: 'Staging', active: true, is_production: false },
			],
		});

		// Only dev is mapped
		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		const result = getEnvsToEnable(flag, mapping);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('dd-dev');
	});

	it('returns all mapped active environments', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			environments: [
				{ id: 10, name: 'Development', active: true, is_production: false },
				{ id: 20, name: 'Production', active: true, is_production: true },
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddDev],
			[20, ddProd],
		]);
		const result = getEnvsToEnable(flag, mapping);

		expect(result).toHaveLength(2);
	});

	it('handles flag with no environments', () => {
		const flag = makeFlag({ id: 1, key: 'test', environments: [] });
		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		expect(getEnvsToEnable(flag, mapping)).toEqual([]);
	});
});

// ─── hasSemverConditions ──────────────────────────────────────────────────────

describe('hasSemverConditions', () => {
	const makeAlloc = (operator: string): DatadogAllocationForFlagCreation => ({
		environment_id: 'dd-prod',
		name: 'test',
		key: 'test',
		type: 'FEATURE_GATE',
		variant_weights: [],
		targeting_rules: [
			{ conditions: [{ operator, attribute: 'v', value: ['1.0.0'] }] },
		],
	});

	it('returns true when an allocation has a SEMVER_GTE condition', () => {
		expect(hasSemverConditions([makeAlloc('SEMVER_GTE')])).toBe(true);
	});

	it('returns true for any SEMVER_* variant', () => {
		for (const op of ['SEMVER_LT', 'SEMVER_LTE', 'SEMVER_GT', 'SEMVER_GTE']) {
			expect(hasSemverConditions([makeAlloc(op)])).toBe(true);
		}
	});

	it('returns false when all conditions are non-semver', () => {
		expect(hasSemverConditions([makeAlloc('GTE')])).toBe(false);
		expect(hasSemverConditions([makeAlloc('ONE_OF')])).toBe(false);
	});

	it('returns false for empty allocations', () => {
		expect(hasSemverConditions([])).toBe(false);
	});

	it('returns false when allocations have no targeting rules', () => {
		const alloc: DatadogAllocationForFlagCreation = {
			environment_id: 'dd-prod',
			name: 'test',
			key: 'test',
			type: 'FEATURE_GATE',
			variant_weights: [],
		};
		expect(hasSemverConditions([alloc])).toBe(false);
	});

	it('returns true when only one of multiple allocations has a SEMVER condition', () => {
		expect(
			hasSemverConditions([makeAlloc('ONE_OF'), makeAlloc('SEMVER_LT')]),
		).toBe(true);
	});
});

// ─── buildDefaultVariantKeyPerEnv ────────────────────────────────────────────

describe('buildDefaultVariantKeyPerEnv', () => {
	it('returns a map with the variant key for a single pure-default allocation', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'true', variant_key: 'true' },
				{ id: 200, name: 'false', variant_key: 'false' },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 200, weight: 1 }],
				}),
			],
		});
		const mapping = new Map([[10, ddProd]]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping)).toEqual(
			new Map([['dd-prod', 'false']]),
		);
	});

	it('returns an empty map when no mapped env has a default allocation', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [{ id: 100, name: 'on', variant_key: 'on' }],
			allocations: [],
		});
		const mapping = new Map([[10, ddProd]]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping).size).toBe(0);
	});

	it('returns an empty map when the default allocation is not a pure default (is_default=false)', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [{ id: 100, name: 'on', variant_key: 'on' }],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: false,
					variation_weight: [{ variation_id: 100, weight: 1 }],
				}),
			],
		});
		const mapping = new Map([[10, ddProd]]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping).size).toBe(0);
	});

	it('returns per-env keys when environments disagree on the default variant', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'on', variant_key: 'on' },
				{ id: 200, name: 'off', variant_key: 'off' },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 100, weight: 1 }],
				}),
				makeAllocation({
					id: 2,
					environment_id: 20,
					is_default: true,
					variation_weight: [{ variation_id: 200, weight: 1 }],
				}),
			],
		});
		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddProd],
			[20, ddDev],
		]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping)).toEqual(
			new Map([
				['dd-prod', 'on'],
				['dd-dev', 'off'],
			]),
		);
	});

	it('returns entries for all envs when they agree on the same default variant', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'on', variant_key: 'on' },
				{ id: 200, name: 'off', variant_key: 'off' },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 200, weight: 1 }],
				}),
				makeAllocation({
					id: 2,
					environment_id: 20,
					is_default: true,
					variation_weight: [{ variation_id: 200, weight: 1 }],
				}),
			],
		});
		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddProd],
			[20, ddDev],
		]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping)).toEqual(
			new Map([
				['dd-prod', 'off'],
				['dd-dev', 'off'],
			]),
		);
	});

	it('omits an env whose default allocation has a split (multiple non-zero weights)', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'on', variant_key: 'on' },
				{ id: 200, name: 'off', variant_key: 'off' },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: true,
					variation_weight: [
						{ variation_id: 100, weight: 1 },
						{ variation_id: 200, weight: 1 },
					],
				}),
			],
		});
		const mapping = new Map([[10, ddProd]]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping).size).toBe(0);
	});

	it('includes resolvable envs and omits the split env', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'on', variant_key: 'on' },
				{ id: 200, name: 'off', variant_key: 'off' },
			],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 100, weight: 1 }],
				}),
				makeAllocation({
					id: 2,
					environment_id: 20,
					is_default: true,
					variation_weight: [
						{ variation_id: 100, weight: 1 },
						{ variation_id: 200, weight: 1 },
					],
				}),
			],
		});
		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddProd],
			[20, ddDev],
		]);
		// ddDev (env 20) has a split default — omitted so it keeps its targeting rule
		expect(buildDefaultVariantKeyPerEnv(flag, mapping)).toEqual(
			new Map([['dd-prod', 'on']]),
		);
	});

	it('returns empty map when default allocation has audiences (not a pure default)', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [{ id: 100, name: 'on', variant_key: 'on' }],
			allocations: [
				{
					...makeAllocation({
						id: 1,
						environment_id: 10,
						is_default: true,
						variation_weight: [{ variation_id: 100, weight: 1 }],
					}),
					audiences: [{ audience_id: 99, type: 'IS_IN' }],
				},
			],
		});
		const mapping = new Map([[10, ddProd]]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping).size).toBe(0);
	});

	it('returns empty map when default allocation has targeting rules (not a pure default)', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [{ id: 100, name: 'on', variant_key: 'on' }],
			allocations: [
				makeAllocation({
					id: 1,
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 100, weight: 1 }],
					targeting_rules: [
						{
							conditions: [
								{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
							],
						},
					],
				}),
			],
		});
		const mapping = new Map([[10, ddProd]]);
		expect(buildDefaultVariantKeyPerEnv(flag, mapping).size).toBe(0);
	});
});

// ─── buildAllocations — defaultVariantKeyPerEnv ───────────────────────────────

describe('buildAllocations with defaultVariantKeyPerEnv', () => {
	it('skips pure-default allocations for envs in the map', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'true', variant_key: 'true' },
				{ id: 200, name: 'false', variant_key: 'false' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-audience',
					name: 'iOS',
					environment_id: 10,
					is_default: false,
					variation_weight: [{ variation_id: 100, weight: 1 }],
					audiences: [{ audience_id: 99, type: 'IS_IN' }],
				}),
				makeAllocation({
					id: 2,
					key: 'alloc-default',
					name: 'Default',
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 200, weight: 1 }],
				}),
			],
		});

		const mapping = new Map([[10, ddProd]]);
		const allocations = buildAllocations(
			flag,
			mapping,
			undefined,
			undefined,
			new Map([['dd-prod', 'false']]),
		);

		expect(allocations).toHaveLength(1);
		expect(allocations[0].key).toBe('alloc-audience');
	});

	it('retains pure-default allocations when env is not in the map', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [
				{ id: 100, name: 'true', variant_key: 'true' },
				{ id: 200, name: 'false', variant_key: 'false' },
			],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-audience',
					name: 'iOS',
					environment_id: 10,
					is_default: false,
					variation_weight: [{ variation_id: 100, weight: 1 }],
				}),
				makeAllocation({
					id: 2,
					key: 'alloc-default',
					name: 'Default',
					environment_id: 10,
					is_default: true,
					variation_weight: [{ variation_id: 200, weight: 1 }],
				}),
			],
		});

		const mapping = new Map([[10, ddProd]]);
		const allocations = buildAllocations(flag, mapping);

		expect(allocations).toHaveLength(2);
	});

	it('retains is_default=true allocation that has audiences (not a pure default)', () => {
		const flag = makeFlag({
			id: 1,
			key: 'test',
			variations: [{ id: 100, name: 'on', variant_key: 'on' }],
			environments: [
				{ id: 10, name: 'Production', active: true, is_production: true },
			],
			allocations: [
				{
					...makeAllocation({
						id: 1,
						key: 'alloc-with-audience',
						environment_id: 10,
						is_default: true,
						variation_weight: [{ variation_id: 100, weight: 1 }],
					}),
					audiences: [{ audience_id: 42, type: 'IS_IN' }],
				},
			],
		});

		const mapping = new Map([[10, ddProd]]);
		const allocations = buildAllocations(
			flag,
			mapping,
			undefined,
			undefined,
			new Map([['dd-prod', 'on']]),
		);

		expect(allocations).toHaveLength(1);
		expect(allocations[0].key).toBe('alloc-with-audience');
	});
});
