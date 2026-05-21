/**
 * Tests for Eppo audience migration:
 * - fingerprintConditions stability
 * - buildTargetingRules with audience fingerprint matching
 * - migrateAudiences with mocked API
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../../src/datadog.js';
import { eppoClient, fetchEppoAudiences } from '../../src/eppo/api.js';
import { migrateAudiences } from '../../src/eppo/audiences.js';
import { fingerprintConditions } from '../../src/eppo/migration.js';
import type { EppoAudience } from '../../src/eppo/types.js';

// ─── fingerprintConditions ────────────────────────────────────────────────────

describe('fingerprintConditions', () => {
	it('produces the same fingerprint regardless of condition order', () => {
		const a = fingerprintConditions([
			{ operator: 'ONE_OF', attribute: 'country', values: ['US', 'CA'] },
			{ operator: 'MATCHES', attribute: 'email', values: ['.*@acme\\.com'] },
		]);
		const b = fingerprintConditions([
			{ operator: 'MATCHES', attribute: 'email', values: ['.*@acme\\.com'] },
			{ operator: 'ONE_OF', attribute: 'country', values: ['US', 'CA'] },
		]);
		expect(a).toBe(b);
	});

	it('produces the same fingerprint regardless of values order', () => {
		const a = fingerprintConditions([
			{ operator: 'ONE_OF', attribute: 'country', values: ['US', 'CA'] },
		]);
		const b = fingerprintConditions([
			{ operator: 'ONE_OF', attribute: 'country', values: ['CA', 'US'] },
		]);
		expect(a).toBe(b);
	});

	it('produces different fingerprints for different conditions', () => {
		const a = fingerprintConditions([
			{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
		]);
		const b = fingerprintConditions([
			{ operator: 'ONE_OF', attribute: 'country', values: ['CA'] },
		]);
		expect(a).not.toBe(b);
	});

	it('is case-insensitive for operator', () => {
		const a = fingerprintConditions([
			{ operator: 'one_of', attribute: 'country', values: ['US'] },
		]);
		const b = fingerprintConditions([
			{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
		]);
		expect(a).toBe(b);
	});

	it('handles empty values array', () => {
		const fp = fingerprintConditions([
			{ operator: 'IS_NULL', attribute: 'email', values: [] },
		]);
		expect(typeof fp).toBe('string');
		expect(fp.length).toBeGreaterThan(0);
	});

	it('handles undefined values', () => {
		const fp = fingerprintConditions([
			{ operator: 'IS_NULL', attribute: 'email' },
		]);
		expect(typeof fp).toBe('string');
	});

	it('returns consistent fingerprint across identical calls', () => {
		const conditions = [{ operator: 'GTE', attribute: 'age', values: ['18'] }];
		expect(fingerprintConditions(conditions)).toBe(
			fingerprintConditions(conditions),
		);
	});
});

// ─── buildTargetingRules with fingerprintLookup ──────────────────────────────

import { buildTargetingRules } from '../../src/eppo/migration.js';
import { makeAllocation } from './helpers.js';

describe('buildTargetingRules with fingerprintLookup', () => {
	it('replaces matched conditions with saved_filter_id', () => {
		const conditions = [
			{ operator: 'ONE_OF', attribute: 'country', values: ['US', 'CA'] },
		];
		const fp = fingerprintConditions(conditions);
		const lookup = new Map([[fp, 'sf-123']]);

		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [{ conditions }],
		});

		const rules = buildTargetingRules(alloc, lookup);
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions).toEqual([{ saved_filter_id: 'sf-123' }]);
	});

	it('deduplicates multiple rules that match the same saved filter', () => {
		const conditions = [
			{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
		];
		const fp = fingerprintConditions(conditions);
		const lookup = new Map([[fp, 'sf-abc']]);

		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [{ conditions }, { conditions }],
		});

		const rules = buildTargetingRules(alloc, lookup);
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions).toEqual([{ saved_filter_id: 'sf-abc' }]);
	});

	it('keeps inline conditions when no fingerprint match is found', () => {
		const lookup = new Map<string, string>();

		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
					],
				},
			],
		});

		const rules = buildTargetingRules(alloc, lookup);
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions[0]).toMatchObject({
			operator: 'ONE_OF',
			attribute: 'country',
		});
		expect(rules[0].conditions[0]).not.toHaveProperty('saved_filter_id');
	});

	it('mixes audience and inline rules correctly', () => {
		const audienceConditions = [
			{ operator: 'ONE_OF', attribute: 'plan', values: ['premium'] },
		];
		const inlineConditions = [
			{ operator: 'GTE', attribute: 'age', values: ['18'] },
		];
		const fp = fingerprintConditions(audienceConditions);
		const lookup = new Map([[fp, 'sf-plan']]);

		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{ conditions: audienceConditions },
				{ conditions: inlineConditions },
			],
		});

		const rules = buildTargetingRules(alloc, lookup);
		expect(rules).toHaveLength(2);
		expect(rules[0].conditions).toEqual([{ saved_filter_id: 'sf-plan' }]);
		expect(rules[1].conditions[0]).toMatchObject({
			operator: 'GTE',
			attribute: 'age',
		});
	});

	it('without fingerprintLookup behaves as before (inline conditions)', () => {
		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{
					conditions: [
						{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
					],
				},
			],
		});

		const rules = buildTargetingRules(alloc);
		expect(rules).toHaveLength(1);
		expect(rules[0].conditions[0]).toMatchObject({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US'],
		});
	});

	it('different audiences in same allocation each get their own saved_filter_id rule', () => {
		const conditionsA = [
			{ operator: 'ONE_OF', attribute: 'plan', values: ['premium'] },
		];
		const conditionsB = [
			{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
		];
		const fpA = fingerprintConditions(conditionsA);
		const fpB = fingerprintConditions(conditionsB);
		const lookup = new Map([
			[fpA, 'sf-premium'],
			[fpB, 'sf-us'],
		]);

		const alloc = makeAllocation({
			id: 1,
			targeting_rules: [
				{ conditions: conditionsA },
				{ conditions: conditionsB },
			],
		});

		const rules = buildTargetingRules(alloc, lookup);
		expect(rules).toHaveLength(2);
		expect(rules[0].conditions).toEqual([{ saved_filter_id: 'sf-premium' }]);
		expect(rules[1].conditions).toEqual([{ saved_filter_id: 'sf-us' }]);
	});
});

// ─── fetchEppoAudiences ──────────────────────────────────────────────────────

describe('fetchEppoAudiences', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(eppoClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns active audiences', async () => {
		const audiences: EppoAudience[] = [
			{
				id: 1,
				name: 'US Users',
				description: 'Users in the US',
				targeting_rules: [
					{
						id: 10,
						conditions: [
							{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
						],
					},
				],
				is_archived: false,
			},
		];
		mock.onGet('https://eppo.cloud/api/v1/audiences').reply(200, audiences);

		const result = await fetchEppoAudiences('test-key');
		expect(result).toEqual(audiences);
	});

	it('requests status=active', async () => {
		mock.onGet('https://eppo.cloud/api/v1/audiences').reply((config) => {
			expect(config.params?.status).toBe('active');
			return [200, []];
		});

		await fetchEppoAudiences('test-key');
	});

	it('returns empty array for non-array response', async () => {
		mock
			.onGet('https://eppo.cloud/api/v1/audiences')
			.reply(200, { unexpected: true });

		const result = await fetchEppoAudiences('test-key');
		expect(result).toEqual([]);
	});
});

// ─── migrateAudiences ────────────────────────────────────────────────────────

describe('migrateAudiences', () => {
	let eppoMock: AxiosMockAdapter;
	let ddMock: AxiosMockAdapter;

	const audience: EppoAudience = {
		id: 42,
		name: 'US Users',
		description: 'Users in the US',
		targeting_rules: [
			{
				id: 10,
				conditions: [
					{ operator: 'ONE_OF', attribute: 'country', values: ['US'] },
				],
			},
		],
		is_archived: false,
	};

	beforeEach(() => {
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		ddMock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		eppoMock.restore();
		ddMock.restore();
	});

	it('dryRun=true does not POST saved filters and records the planned request', async () => {
		eppoMock
			.onGet('https://eppo.cloud/api/v1/audiences')
			.reply(200, [audience]);
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply(200, { data: [], meta: { total: 0 } });
		// If any POST sneaks through, fail loudly.
		const createSpy = jest.fn(() => [500, {}] as [number, unknown]);
		ddMock
			.onPost('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply(createSpy);

		const result = await migrateAudiences({
			eppoApiKey: 'eppo-key',
			ddApiKey: 'dd-key',
			ddAppKey: 'dd-app',
			ddSite: 'datadoghq.com',
			dryRun: true,
		});

		expect(createSpy).not.toHaveBeenCalled();
		expect(result.stats.created).toBe(1);
		expect(result.dryRunRequests).toHaveLength(1);
		expect(result.dryRunRequests[0].method).toBe('POST');
		expect(result.dryRunRequests[0].path).toBe(
			'/api/v2/feature-flags/saved-filters',
		);
		// Fingerprint lookup still populated so Phase 2 can show replacement.
		const fp = fingerprintConditions(audience.targeting_rules[0].conditions);
		expect(result.fingerprintLookup.get(fp)).toBe('dry-run-eppo-audience-42');
		expect(result.savedFilterLookup.get(42)).toBe('dry-run-eppo-audience-42');
	});

	it('non-dry-run actually creates the saved filter and uses its real ID', async () => {
		eppoMock
			.onGet('https://eppo.cloud/api/v1/audiences')
			.reply(200, [audience]);
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply(200, { data: [], meta: { total: 0 } });
		ddMock
			.onPost('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply(201, { data: { id: 'sf-real-123' } });

		const result = await migrateAudiences({
			eppoApiKey: 'eppo-key',
			ddApiKey: 'dd-key',
			ddAppKey: 'dd-app',
			ddSite: 'datadoghq.com',
		});

		expect(result.stats.created).toBe(1);
		expect(result.dryRunRequests).toEqual([]);
		expect(result.savedFilterLookup.get(42)).toBe('sf-real-123');
		const fp = fingerprintConditions(audience.targeting_rules[0].conditions);
		expect(result.fingerprintLookup.get(fp)).toBe('sf-real-123');
	});

	it('dryRun=true reuses already-migrated saved filters without POSTing', async () => {
		eppoMock
			.onGet('https://eppo.cloud/api/v1/audiences')
			.reply(200, [audience]);
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply(200, {
				data: [
					{
						id: 'sf-existing',
						attributes: {
							name: audience.name,
							migration_metadata: {
								provider: 'eppo',
								audience_id: audience.id,
							},
						},
					},
				],
				meta: { total: 1 },
			});
		const createSpy = jest.fn(() => [500, {}] as [number, unknown]);
		ddMock
			.onPost('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply(createSpy);

		const result = await migrateAudiences({
			eppoApiKey: 'eppo-key',
			ddApiKey: 'dd-key',
			ddAppKey: 'dd-app',
			ddSite: 'datadoghq.com',
			dryRun: true,
		});

		expect(createSpy).not.toHaveBeenCalled();
		expect(result.stats.reused).toBe(1);
		expect(result.stats.created).toBe(0);
		expect(result.dryRunRequests).toEqual([]);
		expect(result.savedFilterLookup.get(42)).toBe('sf-existing');
	});
});
