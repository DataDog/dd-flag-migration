import { describe, expect, it } from '@jest/globals';
import {
	buildAllocations,
	buildTargetingRules,
	getEnvsToEnable,
	mapOperator,
	mapVariationType,
	toSyncRequests,
} from '../src/migration.js';
import type {
	DatadogEnvironment,
	EppoAllocation,
	EppoFlag,
} from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ddDev: DatadogEnvironment = {
	id: 'dd-dev',
	name: 'Development',
	is_production: false,
	queries: ['dev'],
};

const ddProd: DatadogEnvironment = {
	id: 'dd-prod',
	name: 'Production',
	is_production: true,
	queries: ['prod'],
};

function makeFlag(
	overrides: Partial<EppoFlag> & { id: number; name: string; key: string },
): EppoFlag {
	return {
		variation_type: 'STRING',
		tag_names: [],
		updated_at: '2024-01-01T00:00:00Z',
		created_at: '2024-01-01T00:00:00Z',
		...overrides,
	};
}

function makeAllocation(
	overrides: Partial<EppoAllocation> & { id: number },
): EppoAllocation {
	return {
		key: '',
		name: '',
		type: 'FEATURE_GATE',
		percent_exposure: 100,
		is_default: false,
		variation_weight: [],
		targeting_rules: [],
		...overrides,
	};
}

// ─── mapVariationType ─────────────────────────────────────────────────────────

describe('mapVariationType', () => {
	it('maps BOOLEAN', () => expect(mapVariationType('BOOLEAN')).toBe('BOOLEAN'));
	it('maps INTEGER', () => expect(mapVariationType('INTEGER')).toBe('INTEGER'));
	it('maps NUMERIC', () => expect(mapVariationType('NUMERIC')).toBe('NUMERIC'));
	it('maps JSON', () => expect(mapVariationType('JSON')).toBe('JSON'));
	it('maps unknown to STRING', () =>
		expect(mapVariationType('FOOBAR')).toBe('STRING'));
	it('is case-insensitive', () =>
		expect(mapVariationType('boolean')).toBe('BOOLEAN'));
});

// ─── mapOperator ──────────────────────────────────────────────────────────────

describe('mapOperator', () => {
	it.each([
		'LT',
		'LTE',
		'GT',
		'GTE',
		'MATCHES',
		'ONE_OF',
		'NOT_ONE_OF',
		'IS_NULL',
	])('maps %s to itself', (op) => expect(mapOperator(op)).toBe(op));

	it('is case-insensitive', () => expect(mapOperator('one_of')).toBe('ONE_OF'));
	it('passes through unknown operators uppercased', () =>
		expect(mapOperator('custom_op')).toBe('CUSTOM_OP'));
});

// ─── buildTargetingRules ──────────────────────────────────────────────────────

describe('buildTargetingRules', () => {
	it('returns empty array when allocation has no targeting rules', () => {
		const alloc = makeAllocation({ id: 1 });
		expect(buildTargetingRules(alloc)).toEqual([]);
	});

	it('converts Eppo targeting rules to Datadog format', () => {
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

	it('filters out rules with no conditions', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [{ conditions: [] }],
		});
		expect(buildTargetingRules(alloc)).toEqual([]);
	});
});

// ─── buildAllocations ─────────────────────────────────────────────────────────

describe('buildAllocations', () => {
	it('returns empty array when flag has no variations', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			variations: [],
		});
		const mapping = new Map([[1, ddDev]]);
		expect(buildAllocations(flag, mapping)).toEqual([]);
	});

	it('builds allocations for a single environment with Eppo allocations', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Dev', active: true, is_production: false },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-dev',
					name: 'Dev Allocation',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 70 },
						{ variation_id: 200, weight: 30 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		const result = buildAllocations(flag, mapping);

		expect(result).toHaveLength(1);
		expect(result[0].environment_id).toBe('dd-dev');
		expect(result[0].key).toBe('alloc-dev');
		expect(result[0].variant_weights).toEqual([
			{ variant_key: 'on', value: 70 },
			{ variant_key: 'off', value: 30 },
		]);
	});

	it('creates equal-weight fallback when env has no Eppo allocations but is active', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Dev', active: true, is_production: false },
			],
			allocations: [], // no allocations
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		const result = buildAllocations(flag, mapping);

		expect(result).toHaveLength(1);
		expect(result[0].variant_weights).toEqual([
			{ variant_key: 'on', value: 50 },
			{ variant_key: 'off', value: 50 },
		]);
	});

	it('skips inactive environments with no allocations', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			variations: [{ id: 100, name: 'On', variant_key: 'on' }],
			environments: [
				{ id: 10, name: 'Dev', active: false, is_production: false },
			],
			allocations: [],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		expect(buildAllocations(flag, mapping)).toEqual([]);
	});

	it('builds allocations for multiple environments', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Dev', active: true, is_production: false },
				{ id: 20, name: 'Prod', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-dev',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 50 },
						{ variation_id: 200, weight: 50 },
					],
				}),
				makeAllocation({
					id: 2,
					key: 'alloc-prod',
					environment_id: 20,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
				}),
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([
			[10, ddDev],
			[20, ddProd],
		]);
		const result = buildAllocations(flag, mapping);

		expect(result).toHaveLength(2);
		expect(result[0].environment_id).toBe('dd-dev');
		expect(result[1].environment_id).toBe('dd-prod');
	});

	it('only builds allocations for the mapped environment', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			variations: [
				{ id: 100, name: 'On', variant_key: 'on' },
				{ id: 200, name: 'Off', variant_key: 'off' },
			],
			environments: [
				{ id: 10, name: 'Dev', active: true, is_production: false },
				{ id: 20, name: 'Prod', active: true, is_production: true },
			],
			allocations: [
				makeAllocation({
					id: 1,
					key: 'alloc-dev',
					environment_id: 10,
					variation_weight: [
						{ variation_id: 100, weight: 50 },
						{ variation_id: 200, weight: 50 },
					],
				}),
				makeAllocation({
					id: 2,
					key: 'alloc-prod',
					environment_id: 20,
					variation_weight: [
						{ variation_id: 100, weight: 100 },
						{ variation_id: 200, weight: 0 },
					],
				}),
			],
		});

		// Only map Production — should only get Production allocation
		const mapping = new Map<number, DatadogEnvironment>([[20, ddProd]]);
		const result = buildAllocations(flag, mapping);

		expect(result).toHaveLength(1);
		expect(result[0].environment_id).toBe('dd-prod');
		expect(result[0].key).toBe('alloc-prod');
	});
});

// ─── getEnvsToEnable ──────────────────────────────────────────────────────────

describe('getEnvsToEnable', () => {
	it('returns environments where the flag is active', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			environments: [
				{ id: 10, name: 'Dev', active: true, is_production: false },
				{ id: 20, name: 'Prod', active: false, is_production: true },
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

	it('returns empty array when no environments are active', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			environments: [
				{ id: 10, name: 'Dev', active: false, is_production: false },
			],
		});

		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		expect(getEnvsToEnable(flag, mapping)).toEqual([]);
	});

	it('only returns environments that are in the mapping', () => {
		const flag = makeFlag({
			id: 1,
			name: 'Flag',
			key: 'flag-1',
			environments: [
				{ id: 10, name: 'Dev', active: true, is_production: false },
				{ id: 20, name: 'Prod', active: true, is_production: true },
			],
		});

		// Only map Dev
		const mapping = new Map<number, DatadogEnvironment>([[10, ddDev]]);
		const result = getEnvsToEnable(flag, mapping);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('dd-dev');
	});
});

// ─── toSyncRequests ───────────────────────────────────────────────────────────

describe('toSyncRequests', () => {
	it('filters allocations by environment_id and strips it from output', () => {
		const allocations = [
			{
				environment_id: 'dd-dev',
				name: 'Dev Alloc',
				key: 'alloc-dev',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'on', value: 100 }],
			},
			{
				environment_id: 'dd-prod',
				name: 'Prod Alloc',
				key: 'alloc-prod',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'on', value: 50 }],
			},
		];

		const result = toSyncRequests(allocations, 'dd-dev');

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			name: 'Dev Alloc',
			key: 'alloc-dev',
			type: 'FEATURE_GATE',
			variant_weights: [{ variant_key: 'on', value: 100 }],
		});
		// Verify environment_id is not present
		expect('environment_id' in result[0]).toBe(false);
	});

	it('returns empty array when no allocations match the environment', () => {
		const allocations = [
			{
				environment_id: 'dd-dev',
				name: 'Dev Alloc',
				key: 'alloc-dev',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'on', value: 100 }],
			},
		];

		expect(toSyncRequests(allocations, 'dd-prod')).toEqual([]);
	});

	it('includes targeting_rules when present', () => {
		const allocations = [
			{
				environment_id: 'dd-prod',
				name: 'Prod Alloc',
				key: 'alloc-prod',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'on', value: 100 }],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'country', value: ['US'] },
						],
					},
				],
			},
		];

		const result = toSyncRequests(allocations, 'dd-prod');
		expect(result[0].targeting_rules).toHaveLength(1);
	});

	it('omits targeting_rules when empty', () => {
		const allocations = [
			{
				environment_id: 'dd-prod',
				name: 'Prod Alloc',
				key: 'alloc-prod',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'on', value: 100 }],
				targeting_rules: [],
			},
		];

		const result = toSyncRequests(allocations, 'dd-prod');
		expect('targeting_rules' in result[0]).toBe(false);
	});

	it('handles multiple allocations for the same environment', () => {
		const allocations = [
			{
				environment_id: 'dd-prod',
				name: 'Alloc 1',
				key: 'alloc-1',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'on', value: 100 }],
			},
			{
				environment_id: 'dd-prod',
				name: 'Alloc 2',
				key: 'alloc-2',
				type: 'FEATURE_GATE' as const,
				variant_weights: [{ variant_key: 'off', value: 100 }],
			},
		];

		const result = toSyncRequests(allocations, 'dd-prod');
		expect(result).toHaveLength(2);
	});
});
