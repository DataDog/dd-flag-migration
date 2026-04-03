import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	createFeatureFlag,
	enableFeatureFlagEnvironment,
	fetchDatadogEnvironments,
	fetchDatadogFlagKeys,
	syncAllocationsForEnvironment,
	validateDatadogKeys,
} from '../src/datadog.js';
import type {
	DatadogAllocationSyncRequest,
	DatadogCreateFlagRequest,
} from '../src/types.js';

const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const SITE = 'test.invalid';
const BASE = `https://api.${SITE}`;

// ─── fetchDatadogEnvironments ─────────────────────────────────────────────────

describe('fetchDatadogEnvironments', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns parsed environments', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [
				{
					id: 'env-1',
					type: 'feature-flag-environments',
					attributes: {
						name: 'production',
						is_production: true,
						queries: ['prod'],
						require_feature_flag_approval: false,
					},
				},
				{
					id: 'env-2',
					type: 'feature-flag-environments',
					attributes: {
						name: 'staging',
						is_production: false,
						queries: ['staging'],
						require_feature_flag_approval: false,
					},
				},
			],
		});

		const result = await fetchDatadogEnvironments(API_KEY, APP_KEY, SITE);
		expect(result).toEqual([
			{
				id: 'env-1',
				name: 'production',
				is_production: true,
				queries: ['prod'],
			},
			{
				id: 'env-2',
				name: 'staging',
				is_production: false,
				queries: ['staging'],
			},
		]);
	});

	it('defaults queries to [] when not present', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [
				{
					id: 'env-1',
					type: 'feature-flag-environments',
					attributes: {
						name: 'production',
						is_production: true,
						require_feature_flag_approval: false,
					},
				},
			],
		});

		const result = await fetchDatadogEnvironments(API_KEY, APP_KEY, SITE);
		expect(result[0].queries).toEqual([]);
	});

	it('uses the site parameter to build the base URL', async () => {
		const customSite = 'datadoghq.eu';
		mock
			.onGet(`https://api.${customSite}/api/v2/feature-flags/environments`)
			.reply(200, { data: [] });

		const result = await fetchDatadogEnvironments(API_KEY, APP_KEY, customSite);
		expect(result).toEqual([]);
	});

	it('sends dd-api-key and dd-application-key headers', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/environments`).reply((config) => {
			expect(config.headers?.['dd-api-key']).toBe(API_KEY);
			expect(config.headers?.['dd-application-key']).toBe(APP_KEY);
			return [200, { data: [] }];
		});

		await fetchDatadogEnvironments(API_KEY, APP_KEY, SITE);
	});

	it('throws on HTTP error', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/environments`).reply(403);

		await expect(
			fetchDatadogEnvironments(API_KEY, APP_KEY, SITE),
		).rejects.toThrow();
	});
});

// ─── validateDatadogKeys ──────────────────────────────────────────────────────

describe('validateDatadogKeys', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns true when the API call succeeds', async () => {
		mock
			.onGet(`${BASE}/api/v2/feature-flags/environments`)
			.reply(200, { data: [] });

		const result = await validateDatadogKeys(API_KEY, APP_KEY, SITE);
		expect(result).toBe(true);
	});

	it('returns false on 401', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/environments`).reply(401);

		const result = await validateDatadogKeys(API_KEY, APP_KEY, SITE);
		expect(result).toBe(false);
	});

	it('returns false on network error', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/environments`).networkError();

		const result = await validateDatadogKeys(API_KEY, APP_KEY, SITE);
		expect(result).toBe(false);
	});
});

// ─── fetchDatadogFlagKeys ─────────────────────────────────────────────────────

describe('fetchDatadogFlagKeys', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns a map of flag keys to IDs', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'uuid-1',
					type: 'feature-flags',
					attributes: { key: 'flag-a', name: 'Flag A' },
				},
				{
					id: 'uuid-2',
					type: 'feature-flags',
					attributes: { key: 'flag-b', name: 'Flag B' },
				},
			],
		});

		const result = await fetchDatadogFlagKeys(API_KEY, APP_KEY, SITE);
		expect(result).toEqual(
			new Map([
				['flag-a', 'uuid-1'],
				['flag-b', 'uuid-2'],
			]),
		);
	});

	it('returns empty map when there are no flags', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, { data: [] });

		const result = await fetchDatadogFlagKeys(API_KEY, APP_KEY, SITE);
		expect(result.size).toBe(0);
	});

	it('paginates until a page returns fewer items than the limit', async () => {
		const limit = 200;
		const page1 = Array.from({ length: limit }, (_, i) => ({
			id: `uuid-${i}`,
			type: 'feature-flags',
			attributes: { key: `flag-${i}`, name: `Flag ${i}` },
		}));
		const page2 = [
			{
				id: 'uuid-200',
				type: 'feature-flags',
				attributes: { key: 'flag-200', name: 'Flag 200' },
			},
		];

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 0, is_archived: false },
			})
			.reply(200, { data: page1 });

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 200, is_archived: false },
			})
			.reply(200, { data: page2 });

		const result = await fetchDatadogFlagKeys(API_KEY, APP_KEY, SITE);
		expect(result.size).toBe(201);
		expect(result.get('flag-0')).toBe('uuid-0');
		expect(result.get('flag-200')).toBe('uuid-200');
	});

	it('uses the site parameter in the request URL', async () => {
		const eu = 'datadoghq.eu';
		mock
			.onGet(`https://api.${eu}/api/v2/feature-flags`)
			.reply(200, { data: [] });

		const result = await fetchDatadogFlagKeys(API_KEY, APP_KEY, eu);
		expect(result.size).toBe(0);
	});
});

// ─── createFeatureFlag ────────────────────────────────────────────────────────

describe('createFeatureFlag', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	const request: DatadogCreateFlagRequest = {
		key: 'my-flag',
		name: 'My Flag',
		value_type: 'BOOLEAN',
		variants: [
			{ key: 'on', name: 'On', value: 'on' },
			{ key: 'off', name: 'Off', value: 'off' },
		],
	};

	it('returns the created flag id and key', async () => {
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply(201, {
			data: {
				id: 'flag-uuid-123',
				attributes: { key: 'my-flag' },
			},
		});

		const result = await createFeatureFlag(API_KEY, APP_KEY, request, SITE);
		expect(result).toEqual({ id: 'flag-uuid-123', key: 'my-flag' });
	});

	it('sends the flag request wrapped in JSON:API format', async () => {
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply((config) => {
			const body = JSON.parse(config.data as string) as {
				data: { type: string; attributes: DatadogCreateFlagRequest };
			};
			expect(body.data.type).toBe('feature-flags');
			expect(body.data.attributes).toEqual(request);
			return [201, { data: { id: 'id-1', attributes: { key: 'my-flag' } } }];
		});

		await createFeatureFlag(API_KEY, APP_KEY, request, SITE);
	});

	it('uses the site parameter in the request URL', async () => {
		const us3 = 'us3.datadoghq.com';
		mock.onPost(`https://api.${us3}/api/v2/feature-flags`).reply(201, {
			data: { id: 'id-2', attributes: { key: 'my-flag' } },
		});

		const result = await createFeatureFlag(API_KEY, APP_KEY, request, us3);
		expect(result.key).toBe('my-flag');
	});

	it('throws on HTTP error', async () => {
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply(422, {
			errors: [{ detail: 'Key already exists' }],
		});

		await expect(
			createFeatureFlag(API_KEY, APP_KEY, request, SITE),
		).rejects.toThrow();
	});
});

// ─── enableFeatureFlagEnvironment ─────────────────────────────────────────────

describe('enableFeatureFlagEnvironment', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	it('posts to the correct URL', async () => {
		const flagId = 'flag-uuid-123';
		const envId = 'env-uuid-456';

		mock
			.onPost(
				`${BASE}/api/v2/feature-flags/${flagId}/environments/${envId}/enable`,
			)
			.reply(200, {});

		await expect(
			enableFeatureFlagEnvironment(API_KEY, APP_KEY, flagId, envId, SITE),
		).resolves.toBeUndefined();
	});

	it('uses the site parameter in the URL', async () => {
		const eu = 'datadoghq.eu';
		const flagId = 'f1';
		const envId = 'e1';

		mock
			.onPost(
				`https://api.${eu}/api/v2/feature-flags/${flagId}/environments/${envId}/enable`,
			)
			.reply(200, {});

		await expect(
			enableFeatureFlagEnvironment(API_KEY, APP_KEY, flagId, envId, eu),
		).resolves.toBeUndefined();
	});

	it('throws on HTTP error', async () => {
		mock
			.onPost(`${BASE}/api/v2/feature-flags/f1/environments/e1/enable`)
			.reply(404);

		await expect(
			enableFeatureFlagEnvironment(API_KEY, APP_KEY, 'f1', 'e1', SITE),
		).rejects.toThrow();
	});
});

// ─── syncAllocationsForEnvironment ────────────────────────────────────────────

describe('syncAllocationsForEnvironment', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	const allocations: DatadogAllocationSyncRequest[] = [
		{
			name: 'Production',
			key: 'my-flag-production',
			type: 'FEATURE_GATE',
			variant_weights: [
				{ variant_key: 'on', value: 50 },
				{ variant_key: 'off', value: 50 },
			],
		},
	];

	// Helper to mock the GET allocations and GET flag (variants) calls
	function mockGetPrereqs(
		flagId: string,
		existingAllocs: Array<{ id: string; key: string }> = [],
		variants: Array<{ id: string; key: string }> = [
			{ id: 'variant-uuid-on', key: 'on' },
			{ id: 'variant-uuid-off', key: 'off' },
		],
		site = SITE,
	) {
		mock
			.onGet(
				`https://api.${site}/api/unstable/feature-flags/${flagId}/allocations`,
			)
			.reply(200, {
				data: existingAllocs.map((a) => ({
					id: a.id,
					type: 'allocations',
					attributes: { key: a.key },
				})),
			});
		mock
			.onGet(`https://api.${site}/api/v2/feature-flags/${flagId}`)
			.reply(200, {
				data: {
					id: flagId,
					type: 'feature-flags',
					attributes: { variants },
				},
			});
	}

	it('sends PUT to the correct URL with variant_id resolved from flag', async () => {
		const flagId = 'flag-uuid-123';
		const envId = 'env-uuid-456';

		mockGetPrereqs(flagId);
		mock
			.onPut(
				`${BASE}/api/v2/feature-flags/${flagId}/environments/${envId}/allocations`,
			)
			.reply((config) => {
				const body = JSON.parse(config.data as string);
				expect(body.data).toHaveLength(1);
				expect(body.data[0].type).toBe('allocations');
				// variant_key should be resolved to variant_id (UUID)
				expect(body.data[0].attributes.variant_weights).toEqual([
					{ variant_id: 'variant-uuid-on', value: 50 },
					{ variant_id: 'variant-uuid-off', value: 50 },
				]);
				return [200, { data: [] }];
			});

		await expect(
			syncAllocationsForEnvironment(
				API_KEY,
				APP_KEY,
				flagId,
				envId,
				allocations,
				SITE,
			),
		).resolves.toBeUndefined();
	});

	it('includes existing allocation IDs when keys match', async () => {
		const flagId = 'flag-uuid-123';
		const envId = 'env-uuid-456';
		const existingId = 'existing-alloc-id-789';

		mockGetPrereqs(flagId, [
			{ id: existingId, key: 'my-flag-production' },
		]);
		mock
			.onPut(
				`${BASE}/api/v2/feature-flags/${flagId}/environments/${envId}/allocations`,
			)
			.reply((config) => {
				const body = JSON.parse(config.data as string);
				expect(body.data[0].id).toBe(existingId);
				expect(body.data[0].attributes.key).toBe('my-flag-production');
				return [200, { data: [] }];
			});

		await syncAllocationsForEnvironment(
			API_KEY,
			APP_KEY,
			flagId,
			envId,
			allocations,
			SITE,
		);
	});

	it('sends auth headers', async () => {
		mockGetPrereqs('f1');
		mock
			.onPut(`${BASE}/api/v2/feature-flags/f1/environments/e1/allocations`)
			.reply((config) => {
				expect(config.headers?.['dd-api-key']).toBe(API_KEY);
				expect(config.headers?.['dd-application-key']).toBe(APP_KEY);
				return [200, { data: [] }];
			});

		await syncAllocationsForEnvironment(
			API_KEY,
			APP_KEY,
			'f1',
			'e1',
			allocations,
			SITE,
		);
	});

	it('uses the site parameter in the URL', async () => {
		const eu = 'datadoghq.eu';
		mockGetPrereqs('f1', [], undefined, eu);
		mock
			.onPut(
				`https://api.${eu}/api/v2/feature-flags/f1/environments/e1/allocations`,
			)
			.reply(200, { data: [] });

		await expect(
			syncAllocationsForEnvironment(
				API_KEY,
				APP_KEY,
				'f1',
				'e1',
				allocations,
				eu,
			),
		).resolves.toBeUndefined();
	});

	it('sends targeting rules when present', async () => {
		const allocsWithRules: DatadogAllocationSyncRequest[] = [
			{
				name: 'Production',
				key: 'my-flag-production',
				type: 'FEATURE_GATE',
				variant_weights: [{ variant_key: 'on', value: 100 }],
				targeting_rules: [
					{
						conditions: [
							{
								operator: 'ONE_OF',
								attribute: 'country',
								value: ['US', 'CA'],
							},
						],
					},
				],
			},
		];

		mockGetPrereqs('f1');
		mock
			.onPut(`${BASE}/api/v2/feature-flags/f1/environments/e1/allocations`)
			.reply((config) => {
				const body = JSON.parse(config.data as string);
				const attrs = body.data[0].attributes;
				expect(attrs.targeting_rules).toHaveLength(1);
				expect(attrs.targeting_rules?.[0].conditions[0].attribute).toBe(
					'country',
				);
				return [200, { data: [] }];
			});

		await syncAllocationsForEnvironment(
			API_KEY,
			APP_KEY,
			'f1',
			'e1',
			allocsWithRules,
			SITE,
		);
	});

	it('throws on HTTP error', async () => {
		mockGetPrereqs('f1');
		mock
			.onPut(`${BASE}/api/v2/feature-flags/f1/environments/e1/allocations`)
			.reply(400, {
				errors: [{ detail: 'Invalid variant reference' }],
			});

		await expect(
			syncAllocationsForEnvironment(
				API_KEY,
				APP_KEY,
				'f1',
				'e1',
				allocations,
				SITE,
			),
		).rejects.toThrow();
	});
});
