/**
 * Behavioral tests for Eppo → Datadog flag migration.
 *
 * Each test defines a realistic Eppo flag JSON, runs the full migration pipeline,
 * and asserts on the Datadog create-flag request that would be produced.
 */
import { describe, expect, it } from '@jest/globals';
import {
	buildAllocations,
	getEnvsToEnable,
	mapVariationType,
} from '../../src/eppo/migration.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
} from '../../src/types.js';
import { ddProd, ddStaging, makeAllocation, makeFlag } from './helpers.js';

/** Simulate the full migration pipeline for a single Eppo flag. */
function migrateFlag(
	flag: EppoFlag,
	envMapping: Map<number, DatadogEnvironment>,
): {
	request: DatadogCreateFlagRequest;
	envsToEnable: DatadogEnvironment[];
} {
	const variations = flag.variations ?? [];
	const variants = variations.map((v) => ({
		key: v.variant_key,
		name: v.name,
		value: v.variant_key,
	}));

	const allocations = buildAllocations(flag, envMapping);
	const envsToEnable = getEnvsToEnable(flag, envMapping);

	const request: DatadogCreateFlagRequest = {
		key: flag.key,
		name: flag.name,
		value_type: mapVariationType(flag.variation_type),
		variants,
		allocations: allocations.length > 0 ? allocations : undefined,
	};

	return { request, envsToEnable };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe('migrate a simple boolean flag (active in one env, inactive in another)', () => {
	const flag = makeFlag({
		id: 1,
		key: 'enable-dark-mode',
		name: 'Enable Dark Mode',
		variation_type: 'BOOLEAN',
		variations: [
			{ id: 10, name: 'Enabled', variant_key: 'enabled' },
			{ id: 20, name: 'Disabled', variant_key: 'disabled' },
		],
		environments: [
			{ id: 100, name: 'Staging', active: true, is_production: false },
			{ id: 200, name: 'Production', active: false, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'staging-alloc',
				name: 'Staging Default',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
			}),
			makeAllocation({
				id: 2,
				key: 'prod-alloc',
				name: 'Production Default',
				environment_id: 200,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([
		[100, ddStaging],
		[200, ddProd],
	]);
	const result = migrateFlag(flag, envMapping);

	it('produces BOOLEAN value_type', () => {
		expect(result.request.value_type).toBe('BOOLEAN');
	});

	it('has two variants with correct keys', () => {
		expect(result.request.variants).toEqual([
			{ key: 'enabled', name: 'Enabled', value: 'enabled' },
			{ key: 'disabled', name: 'Disabled', value: 'disabled' },
		]);
	});

	it('produces one allocation per environment', () => {
		const allocs = result.request.allocations ?? [];
		expect(allocs).toHaveLength(2);
		expect(allocs[0].environment_id).toBe('dd-staging');
		expect(allocs[1].environment_id).toBe('dd-prod');
	});

	it('staging allocation is 100% enabled', () => {
		const staging = result.request.allocations?.[0];
		expect(staging?.variant_weights).toEqual([
			{ variant_key: 'enabled', value: 100 },
			{ variant_key: 'disabled', value: 0 },
		]);
	});

	it('production allocation is 100% disabled', () => {
		const prod = result.request.allocations?.[1];
		expect(prod?.variant_weights).toEqual([
			{ variant_key: 'enabled', value: 0 },
			{ variant_key: 'disabled', value: 100 },
		]);
	});

	it('only enables staging (active env)', () => {
		expect(result.envsToEnable).toHaveLength(1);
		expect(result.envsToEnable[0].id).toBe('dd-staging');
	});
});

describe('migrate a flag with targeting rules', () => {
	const flag = makeFlag({
		id: 2,
		key: 'feature-by-country',
		name: 'Feature By Country',
		variation_type: 'BOOLEAN',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'us-users',
				name: 'US Users',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
				targeting_rules: [
					{
						conditions: [
							{
								operator: 'ONE_OF',
								attribute: 'country',
								values: ['US', 'CA'],
							},
						],
					},
				],
			}),
			makeAllocation({
				id: 2,
				key: 'default',
				name: 'Default',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('produces 2 allocations: targeted + default', () => {
		expect(result.request.allocations).toHaveLength(2);
	});

	it('first allocation has targeting rules with ONE_OF', () => {
		const targeted = result.request.allocations?.[0];
		expect(targeted?.targeting_rules).toEqual([
			{
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', value: ['US', 'CA'] },
				],
			},
		]);
	});

	it('first allocation gives 100% to on variant', () => {
		const targeted = result.request.allocations?.[0];
		expect(targeted?.variant_weights).toEqual([
			{ variant_key: 'on', value: 100 },
			{ variant_key: 'off', value: 0 },
		]);
	});

	it('second allocation has no targeting rules', () => {
		const def = result.request.allocations?.[1];
		expect(def?.targeting_rules).toBeUndefined();
	});

	it('second allocation gives 100% to off variant', () => {
		const def = result.request.allocations?.[1];
		expect(def?.variant_weights).toEqual([
			{ variant_key: 'on', value: 0 },
			{ variant_key: 'off', value: 100 },
		]);
	});
});

describe('migrate a multivariate string flag', () => {
	const flag = makeFlag({
		id: 3,
		key: 'theme-selector',
		name: 'Theme Selector',
		variation_type: 'STRING',
		variations: [
			{ id: 10, name: 'Light', variant_key: 'light' },
			{ id: 20, name: 'Dark', variant_key: 'dark' },
			{ id: 30, name: 'Auto', variant_key: 'auto' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'theme-rollout',
				name: 'Theme Rollout',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 40 },
					{ variation_id: 20, weight: 40 },
					{ variation_id: 30, weight: 20 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('infers STRING value_type', () => {
		expect(result.request.value_type).toBe('STRING');
	});

	it('has three variants', () => {
		expect(result.request.variants).toHaveLength(3);
		expect(result.request.variants.map((v) => v.key)).toEqual([
			'light',
			'dark',
			'auto',
		]);
	});

	it('produces rollout weights totaling 100%', () => {
		const alloc = result.request.allocations?.[0];
		expect(alloc?.variant_weights).toEqual([
			{ variant_key: 'light', value: 40 },
			{ variant_key: 'dark', value: 40 },
			{ variant_key: 'auto', value: 20 },
		]);
	});
});

describe('migrate a JSON flag', () => {
	const flag = makeFlag({
		id: 4,
		key: 'auth-config',
		name: 'Auth Config',
		variation_type: 'JSON',
		variations: [
			{ id: 10, name: 'Config A', variant_key: 'config-a' },
			{ id: 20, name: 'Config B', variant_key: 'config-b' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'json-alloc',
				name: 'JSON Allocation',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('infers JSON value_type', () => {
		expect(result.request.value_type).toBe('JSON');
	});

	it('maps variant keys correctly', () => {
		expect(result.request.variants.map((v) => v.key)).toEqual([
			'config-a',
			'config-b',
		]);
	});
});

describe('migrate a numeric flag', () => {
	const flag = makeFlag({
		id: 5,
		key: 'retry-count',
		name: 'Retry Count',
		variation_type: 'NUMERIC',
		variations: [
			{ id: 10, name: '1 retry', variant_key: '1' },
			{ id: 20, name: '3 retries', variant_key: '3' },
			{ id: 30, name: '5 retries', variant_key: '5' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
					{ variation_id: 30, weight: 0 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('infers NUMERIC value_type', () => {
		expect(result.request.value_type).toBe('NUMERIC');
	});

	it('has three variants', () => {
		expect(result.request.variants).toHaveLength(3);
	});

	it('100% goes to the 3-retries variant', () => {
		const alloc = result.request.allocations?.[0];
		expect(alloc?.variant_weights).toEqual([
			{ variant_key: '1', value: 0 },
			{ variant_key: '3', value: 100 },
			{ variant_key: '5', value: 0 },
		]);
	});
});

describe('migrate a flag with complex targeting (multiple conditions)', () => {
	const flag = makeFlag({
		id: 6,
		key: 'premium-feature',
		name: 'Premium Feature',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'premium-us',
				name: 'Premium US Users',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
							{
								operator: 'ONE_OF',
								attribute: 'plan',
								values: ['premium', 'enterprise'],
							},
						],
					},
				],
			}),
			makeAllocation({
				id: 2,
				key: 'default',
				name: 'Default',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('first allocation has two conditions in one rule (AND logic)', () => {
		const targeted = result.request.allocations?.[0];
		expect(targeted?.targeting_rules).toHaveLength(1);
		expect(targeted?.targeting_rules?.[0].conditions).toHaveLength(2);
		expect(targeted?.targeting_rules?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US'],
		});
		expect(targeted?.targeting_rules?.[0].conditions[1]).toEqual({
			operator: 'ONE_OF',
			attribute: 'plan',
			value: ['premium', 'enterprise'],
		});
	});
});

describe('migrate a flag with comparison operators in targeting', () => {
	const flag = makeFlag({
		id: 7,
		key: 'version-gate',
		name: 'Version Gate',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'old-version',
				name: 'Old Version Users',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
				],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'LT', attribute: 'app_version', values: ['5.0'] },
						],
					},
				],
			}),
			makeAllocation({
				id: 2,
				key: 'new-version',
				name: 'New Version Users',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'GTE', attribute: 'app_version', values: ['5.0'] },
						],
					},
				],
			}),
			makeAllocation({
				id: 3,
				key: 'fallback',
				name: 'Fallback',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('produces 3 allocations', () => {
		expect(result.request.allocations).toHaveLength(3);
	});

	it('first allocation uses LT operator', () => {
		const cond =
			result.request.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('LT');
		expect(cond?.value).toEqual(['5.0']);
	});

	it('second allocation uses GTE operator', () => {
		const cond =
			result.request.allocations?.[1].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('GTE');
		expect(cond?.value).toEqual(['5.0']);
	});

	it('third allocation has no targeting rules (fallback)', () => {
		expect(result.request.allocations?.[2].targeting_rules).toBeUndefined();
	});
});

describe('migrate a flag with NOT_ONE_OF targeting', () => {
	const flag = makeFlag({
		id: 8,
		key: 'exclude-internal',
		name: 'Exclude Internal Users',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'external-only',
				name: 'External Only',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
				targeting_rules: [
					{
						conditions: [
							{
								operator: 'NOT_ONE_OF',
								attribute: 'email_domain',
								values: ['internal.com', 'test.com'],
							},
						],
					},
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('maps NOT_ONE_OF correctly', () => {
		const cond =
			result.request.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('NOT_ONE_OF');
		expect(cond?.value).toEqual(['internal.com', 'test.com']);
	});
});

describe('migrate a flag with MATCHES targeting', () => {
	const flag = makeFlag({
		id: 9,
		key: 'regex-flag',
		name: 'Regex Flag',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'email-match',
				name: 'Email Match',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
				targeting_rules: [
					{
						conditions: [
							{
								operator: 'MATCHES',
								attribute: 'email',
								values: ['.*@acme\\.com$'],
							},
						],
					},
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('passes through MATCHES operator and regex pattern', () => {
		const cond =
			result.request.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('MATCHES');
		expect(cond?.value).toEqual(['.*@acme\\.com$']);
	});
});

describe('migrate a flag across multiple environments with different configs', () => {
	const flag = makeFlag({
		id: 10,
		key: 'multi-env-feature',
		name: 'Multi-Env Feature',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Staging', active: true, is_production: false },
			{ id: 200, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'staging-full',
				name: 'Staging Full Rollout',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
			}),
			makeAllocation({
				id: 2,
				key: 'prod-rollout',
				name: 'Production Rollout',
				environment_id: 200,
				variation_weight: [
					{ variation_id: 10, weight: 50 },
					{ variation_id: 20, weight: 50 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([
		[100, ddStaging],
		[200, ddProd],
	]);
	const result = migrateFlag(flag, envMapping);

	it('produces separate allocations per environment', () => {
		const allocs = result.request.allocations ?? [];
		expect(allocs).toHaveLength(2);
	});

	it('staging allocation is 100% on', () => {
		const staging = result.request.allocations?.[0];
		expect(staging?.environment_id).toBe('dd-staging');
		expect(staging?.variant_weights).toEqual([
			{ variant_key: 'on', value: 100 },
			{ variant_key: 'off', value: 0 },
		]);
	});

	it('production allocation is 50/50 rollout', () => {
		const prod = result.request.allocations?.[1];
		expect(prod?.environment_id).toBe('dd-prod');
		expect(prod?.variant_weights).toEqual([
			{ variant_key: 'on', value: 50 },
			{ variant_key: 'off', value: 50 },
		]);
	});

	it('enables both environments since both are active', () => {
		expect(result.envsToEnable).toHaveLength(2);
	});
});

describe('migrate a flag where mapped environment has no allocations (active env)', () => {
	const flag = makeFlag({
		id: 11,
		key: 'sparse-env',
		name: 'Sparse Env Flag',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Staging', active: true, is_production: false },
			{ id: 200, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			// Only staging has allocations
			makeAllocation({
				id: 1,
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([
		[100, ddStaging],
		[200, ddProd],
	]);
	const result = migrateFlag(flag, envMapping);

	it('only creates allocation for staging (production serves default)', () => {
		const allocs = result.request.allocations ?? [];
		expect(allocs).toHaveLength(1);
		expect(allocs[0].environment_id).toBe('dd-staging');
	});

	it('enables both environments since both are active', () => {
		expect(result.envsToEnable).toHaveLength(2);
	});
});

describe('migrate a flag with no allocations and inactive environment', () => {
	const flag = makeFlag({
		id: 12,
		key: 'inactive-flag',
		name: 'Inactive Flag',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: false, is_production: true },
		],
		allocations: [],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('produces no allocations for inactive environment', () => {
		expect(result.request.allocations).toBeUndefined();
	});

	it('enables no environments', () => {
		expect(result.envsToEnable).toHaveLength(0);
	});
});

describe('migrate a flag with multiple targeting rules on one allocation', () => {
	const flag = makeFlag({
		id: 13,
		key: 'multi-rule-alloc',
		name: 'Multi Rule Allocation',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'complex-targeting',
				name: 'Complex Targeting',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 100 },
					{ variation_id: 20, weight: 0 },
				],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
						],
					},
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'plan', values: ['enterprise'] },
						],
					},
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('preserves multiple targeting rules (OR logic between rules)', () => {
		const alloc = result.request.allocations?.[0];
		expect(alloc?.targeting_rules).toHaveLength(2);
		expect(alloc?.targeting_rules?.[0].conditions[0].attribute).toBe('country');
		expect(alloc?.targeting_rules?.[1].conditions[0].attribute).toBe('plan');
	});
});

describe('migrate a flag with IS_NULL operator', () => {
	const flag = makeFlag({
		id: 14,
		key: 'null-check-flag',
		name: 'Null Check Flag',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				key: 'null-check',
				name: 'Null Check',
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 0 },
					{ variation_id: 20, weight: 100 },
				],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'IS_NULL', attribute: 'email', values: ['true'] },
						],
					},
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('maps IS_NULL operator correctly', () => {
		const cond =
			result.request.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('IS_NULL');
		expect(cond?.attribute).toBe('email');
	});
});

describe('migrate a flag with integer variation type', () => {
	const flag = makeFlag({
		id: 15,
		key: 'max-items',
		name: 'Max Items',
		variation_type: 'INTEGER',
		variations: [
			{ id: 10, name: '10 items', variant_key: '10' },
			{ id: 20, name: '50 items', variant_key: '50' },
			{ id: 30, name: '100 items', variant_key: '100' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 50 },
					{ variation_id: 20, weight: 30 },
					{ variation_id: 30, weight: 20 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('infers INTEGER value_type', () => {
		expect(result.request.value_type).toBe('INTEGER');
	});

	it('normalizes weights to percentages', () => {
		const alloc = result.request.allocations?.[0];
		expect(alloc?.variant_weights).toEqual([
			{ variant_key: '10', value: 50 },
			{ variant_key: '50', value: 30 },
			{ variant_key: '100', value: 20 },
		]);
	});
});

describe('migrate a flag with weight normalization from non-100 totals', () => {
	const flag = makeFlag({
		id: 16,
		key: 'weighted-flag',
		name: 'Weighted Flag',
		variations: [
			{ id: 10, name: 'A', variant_key: 'a' },
			{ id: 20, name: 'B', variant_key: 'b' },
		],
		environments: [
			{ id: 100, name: 'Production', active: true, is_production: true },
		],
		allocations: [
			makeAllocation({
				id: 1,
				environment_id: 100,
				variation_weight: [
					{ variation_id: 10, weight: 1 },
					{ variation_id: 20, weight: 3 },
				],
			}),
		],
	});

	const envMapping = new Map<number, DatadogEnvironment>([[100, ddProd]]);
	const result = migrateFlag(flag, envMapping);

	it('normalizes weights from total=4 to percentages', () => {
		const alloc = result.request.allocations?.[0];
		expect(alloc?.variant_weights).toEqual([
			{ variant_key: 'a', value: 25 },
			{ variant_key: 'b', value: 75 },
		]);
	});
});
