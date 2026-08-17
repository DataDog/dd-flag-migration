import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	applyRestrictionPolicy,
	applyVariantDeletes,
	createDDClient,
	createFeatureFlag,
	createVariant,
	ddClient,
	deleteVariant,
	enableFeatureFlagEnvironment,
	fetchCurrentUserIdentity,
	fetchCurrentUserPermissions,
	fetchDatadogEnvironments,
	fetchDatadogFlagKeys,
	fetchDatadogFlags,
	fetchDatadogTeams,
	fetchFlagTags,
	fetchRestrictionPolicy,
	syncAllocationsForEnvironment,
	syncVariants,
	syncVariantsCreatesAndUpdates,
	updateFlagTags,
	updateVariant,
} from '../src/datadog/api.js';
import {
	buildVariantKeyToIdAliases,
	buildVariantSyncDryRunRequests,
	eppoSourceIdLookupKey,
	planVariantSync,
} from '../src/datadog/helpers.js';
import type {
	DatadogAllocationSyncRequest,
	DatadogCreateFlagRequest,
} from '../src/datadog/types.js';

const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const SITE = 'test.invalid';
const BASE = `https://api.${SITE}`;

// ─── fetchDatadogEnvironments ─────────────────────────────────────────────────

describe('fetchDatadogEnvironments', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
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

// ─── fetchDatadogFlagKeys ─────────────────────────────────────────────────────

describe('fetchDatadogFlagKeys', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
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

	it('indexes Eppo flags by source metadata aliases', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'uuid-eppo',
					type: 'feature-flags',
					attributes: {
						key: 'datadog-facing-key',
						name: 'Eppo Flag',
						migration_metadata: {
							provider: 'eppo',
							source_id: '123',
							source_key: 'eppo-source-key',
						},
					},
				},
			],
		});

		const result = await fetchDatadogFlagKeys(API_KEY, APP_KEY, SITE);
		expect(result.get('datadog-facing-key')).toBe('uuid-eppo');
		expect(result.get('eppo-source-key')).toBe('uuid-eppo');
		expect(result.get(eppoSourceIdLookupKey('123'))).toBe('uuid-eppo');
	});

	it('paginates using Datadog next_offset metadata', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit }, (_, i) => ({
			id: `uuid-${i}`,
			type: 'feature-flags',
			attributes: { key: `flag-${i}`, name: `Flag ${i}` },
		}));
		const page2 = [
			{
				id: 'uuid-50',
				type: 'feature-flags',
				attributes: { key: 'flag-50', name: 'Flag 50' },
			},
		];

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 0, is_archived: false },
			})
			.reply(200, {
				data: page1,
				meta: { page: { total: 51, next_offset: 50 } },
			});

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 50, is_archived: false },
			})
			.reply(200, {
				data: page2,
				meta: { page: { total: 51, next_offset: null } },
			});

		const result = await fetchDatadogFlagKeys(API_KEY, APP_KEY, SITE);
		expect(result.size).toBe(51);
		expect(result.get('flag-0')).toBe('uuid-0');
		expect(result.get('flag-50')).toBe('uuid-50');
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

// ─── fetchDatadogFlags ────────────────────────────────────────────────────────

describe('fetchDatadogFlags', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns flag entries with migration_metadata', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'uuid-1',
					type: 'feature-flags',
					attributes: {
						key: 'flag-a',
						name: 'Flag A',
						tags: ['project:health-100'],
						migration_metadata: {
							project_key: 'proj-1',
							flag_key: 'flag-a',
						},
					},
				},
				{
					id: 'uuid-2',
					type: 'feature-flags',
					attributes: { key: 'flag-b', name: 'Flag B' },
				},
			],
		});

		const result = await fetchDatadogFlags(API_KEY, APP_KEY, SITE);
		expect(result).toEqual([
			{
				id: 'uuid-1',
				key: 'flag-a',
				tags: ['project:health-100'],
				migration_metadata: { project_key: 'proj-1', flag_key: 'flag-a' },
			},
			{
				id: 'uuid-2',
				key: 'flag-b',
				migration_metadata: undefined,
			},
		]);
	});

	it('parses key_prefix from migration_metadata', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'uuid-p',
					type: 'feature-flags',
					attributes: {
						key: 'mobile-flag-a',
						name: 'Flag A',
						migration_metadata: {
							project_key: 'proj-1',
							flag_key: 'flag-a',
							key_prefix: 'mobile',
						},
					},
				},
			],
		});

		const result = await fetchDatadogFlags(API_KEY, APP_KEY, SITE);
		expect(result).toEqual([
			{
				id: 'uuid-p',
				key: 'mobile-flag-a',
				migration_metadata: {
					project_key: 'proj-1',
					flag_key: 'flag-a',
					key_prefix: 'mobile',
				},
			},
		]);
	});

	it('returns empty array when there are no flags', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, { data: [] });

		const result = await fetchDatadogFlags(API_KEY, APP_KEY, SITE);
		expect(result).toEqual([]);
	});

	it('paginates using Datadog next_offset metadata', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit }, (_, i) => ({
			id: `uuid-${i}`,
			type: 'feature-flags',
			attributes: { key: `flag-${i}`, name: `Flag ${i}` },
		}));
		const page2 = [
			{
				id: 'uuid-50',
				type: 'feature-flags',
				attributes: {
					key: 'flag-50',
					name: 'Flag 50',
					migration_metadata: { project_key: 'proj-x', flag_key: 'flag-50' },
				},
			},
		];

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 0, is_archived: false },
			})
			.reply(200, {
				data: page1,
				meta: { page: { total: 51, next_offset: 50 } },
			});

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 50, is_archived: false },
			})
			.reply(200, {
				data: page2,
				meta: { page: { total: 51, next_offset: null } },
			});

		const result = await fetchDatadogFlags(API_KEY, APP_KEY, SITE);
		expect(result).toHaveLength(51);
		expect(result[50].migration_metadata).toEqual({
			project_key: 'proj-x',
			flag_key: 'flag-50',
		});
	});

	it('falls back to total_count when next_offset is absent', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit }, (_, i) => ({
			id: `uuid-${i}`,
			type: 'feature-flags',
			attributes: { key: `flag-${i}`, name: `Flag ${i}` },
		}));
		const page2 = [
			{
				id: 'uuid-50',
				type: 'feature-flags',
				attributes: { key: 'flag-50', name: 'Flag 50' },
			},
		];

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 0, is_archived: false },
			})
			.reply(200, {
				data: page1,
				meta: { page: { total_count: 51 } },
			});

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 50, is_archived: false },
			})
			.reply(200, {
				data: page2,
				meta: { page: { total_count: 51 } },
			});

		const result = await fetchDatadogFlags(API_KEY, APP_KEY, SITE);
		expect(result).toHaveLength(51);
		expect(result[50].key).toBe('flag-50');
	});

	it('stops when a short page is returned without next_offset or total', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit - 1 }, (_, i) => ({
			id: `uuid-${i}`,
			type: 'feature-flags',
			attributes: { key: `flag-${i}`, name: `Flag ${i}` },
		}));

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 0, is_archived: false },
			})
			.reply(200, { data: page1 });

		const result = await fetchDatadogFlags(API_KEY, APP_KEY, SITE);
		expect(result).toHaveLength(limit - 1);
	});
});

// ─── createFeatureFlag ────────────────────────────────────────────────────────

describe('createFeatureFlag', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
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

	it('includes migration_metadata when provided', async () => {
		const requestWithMeta: DatadogCreateFlagRequest = {
			...request,
			migration_metadata: {
				project_key: 'my-ld-project',
				flag_key: 'my-flag',
			},
		};

		mock.onPost(`${BASE}/api/v2/feature-flags`).reply((config) => {
			const body = JSON.parse(config.data as string) as {
				data: { type: string; attributes: DatadogCreateFlagRequest };
			};
			expect(body.data.attributes.migration_metadata).toEqual({
				project_key: 'my-ld-project',
				flag_key: 'my-flag',
			});
			return [201, { data: { id: 'id-3', attributes: { key: 'my-flag' } } }];
		});

		await createFeatureFlag(API_KEY, APP_KEY, requestWithMeta, SITE);
	});

	it('includes key_prefix in migration_metadata when provided', async () => {
		const requestWithPrefix: DatadogCreateFlagRequest = {
			...request,
			key: 'mobile-my-flag',
			migration_metadata: {
				project_key: 'my-ld-project',
				flag_key: 'my-flag',
				key_prefix: 'mobile',
			},
		};

		mock.onPost(`${BASE}/api/v2/feature-flags`).reply((config) => {
			const body = JSON.parse(config.data as string) as {
				data: { type: string; attributes: DatadogCreateFlagRequest };
			};
			expect(body.data.attributes.migration_metadata).toEqual({
				project_key: 'my-ld-project',
				flag_key: 'my-flag',
				key_prefix: 'mobile',
			});
			expect(body.data.attributes.key).toBe('mobile-my-flag');
			return [
				201,
				{ data: { id: 'id-4', attributes: { key: 'mobile-my-flag' } } },
			];
		});

		await createFeatureFlag(API_KEY, APP_KEY, requestWithPrefix, SITE);
	});

	it('throws on HTTP error', async () => {
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply(422, {
			errors: [{ detail: 'Key already exists' }],
		});

		await expect(
			createFeatureFlag(API_KEY, APP_KEY, request, SITE),
		).rejects.toThrow();
	});

	it('retries with suffixed name on 409 name conflict', async () => {
		let callCount = 0;
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply((config) => {
			callCount++;
			const body = JSON.parse(config.data as string) as {
				data: { attributes: { name: string } };
			};
			if (callCount === 1) {
				expect(body.data.attributes.name).toBe('My Flag');
				return [
					409,
					{
						errors: [
							{ detail: 'a feature flag with this name already exists' },
						],
					},
				];
			}
			expect(body.data.attributes.name).toBe('My Flag (1)');
			return [
				201,
				{ data: { id: 'flag-uuid-retry', attributes: { key: 'my-flag' } } },
			];
		});

		const result = await createFeatureFlag(API_KEY, APP_KEY, request, SITE);
		expect(result).toEqual({ id: 'flag-uuid-retry', key: 'my-flag' });
		expect(callCount).toBe(2);
	});

	it('increments the suffix on each successive name conflict', async () => {
		const names: string[] = [];
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply((config) => {
			const body = JSON.parse(config.data as string) as {
				data: { attributes: { name: string } };
			};
			names.push(body.data.attributes.name);
			if (names.length < 4) {
				return [
					409,
					{
						errors: [
							{ detail: 'a feature flag with this name already exists' },
						],
					},
				];
			}
			return [
				201,
				{ data: { id: 'flag-uuid-3', attributes: { key: 'my-flag' } } },
			];
		});

		await createFeatureFlag(API_KEY, APP_KEY, request, SITE);
		expect(names).toEqual([
			'My Flag',
			'My Flag (1)',
			'My Flag (2)',
			'My Flag (3)',
		]);
	});

	it('throws after 9 retries if name conflict persists', async () => {
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply(409, {
			errors: [{ detail: 'a feature flag with this name already exists' }],
		});

		await expect(
			createFeatureFlag(API_KEY, APP_KEY, request, SITE),
		).rejects.toThrow();

		// 1 original + 9 retries = 10 total attempts
		expect(mock.history.post?.length).toBe(10);
	});

	it('does not retry on a 409 with a different error message', async () => {
		mock.onPost(`${BASE}/api/v2/feature-flags`).reply(409, {
			errors: [{ detail: 'some other conflict' }],
		});

		await expect(
			createFeatureFlag(API_KEY, APP_KEY, request, SITE),
		).rejects.toThrow();

		expect(mock.history.post?.length).toBe(1);
	});
});

// ─── enableFeatureFlagEnvironment ─────────────────────────────────────────────

describe('enableFeatureFlagEnvironment', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
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
		mock = new AxiosMockAdapter(ddClient as never);
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

	// Helper to mock the GET flag detail call (returns variants + allocations)
	function mockGetPrereqs(
		flagId: string,
		existingAllocs: Array<{ id: string; key: string }> = [],
		variants: Array<{ id: string; key: string }> = [
			{ id: 'variant-uuid-on', key: 'on' },
			{ id: 'variant-uuid-off', key: 'off' },
		],
		site = SITE,
		envId = 'env-uuid-456',
	) {
		mock
			.onGet(`https://api.${site}/api/v2/feature-flags/${flagId}`)
			.reply(200, {
				data: {
					id: flagId,
					type: 'feature-flags',
					attributes: {
						variants,
						feature_flag_environments: [
							{
								environment_id: envId,
								allocations: existingAllocs.length ? existingAllocs : null,
							},
						],
					},
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

	it('uses caller-provided variant key aliases when resolving variant IDs', async () => {
		const flagId = 'flag-uuid-123';
		const envId = 'env-uuid-456';
		const renamedAllocations: DatadogAllocationSyncRequest[] = [
			{
				name: 'Production',
				key: 'my-flag-production',
				type: 'FEATURE_GATE',
				variant_weights: [{ variant_key: 'new-on', value: 100 }],
			},
		];

		mockGetPrereqs(flagId, [], [{ id: 'variant-uuid-on', key: 'old-on' }]);
		mock
			.onPut(
				`${BASE}/api/v2/feature-flags/${flagId}/environments/${envId}/allocations`,
			)
			.reply((config) => {
				const body = JSON.parse(config.data as string);
				expect(body.data[0].attributes.variant_weights).toEqual([
					{ variant_id: 'variant-uuid-on', value: 100 },
				]);
				return [200, { data: [] }];
			});

		await syncAllocationsForEnvironment(
			API_KEY,
			APP_KEY,
			flagId,
			envId,
			renamedAllocations,
			SITE,
			undefined,
			new Map([['new-on', 'variant-uuid-on']]),
		);
	});

	it('throws before PUT when a variant key cannot be resolved to a UUID', async () => {
		const flagId = 'flag-uuid-123';
		const envId = 'env-uuid-456';

		mockGetPrereqs(flagId, [], []);
		mock
			.onPut(
				`${BASE}/api/v2/feature-flags/${flagId}/environments/${envId}/allocations`,
			)
			.reply(() => {
				throw new Error('PUT should not be called');
			});

		await expect(
			syncAllocationsForEnvironment(
				API_KEY,
				APP_KEY,
				flagId,
				envId,
				[
					{
						name: 'Production',
						key: 'my-flag-production',
						type: 'FEATURE_GATE',
						variant_weights: [{ variant_key: 'true', value: 100 }],
					},
				],
				SITE,
			),
		).rejects.toThrow(
			`Unable to resolve variant key(s) to Datadog variant UUIDs for flag ${flagId} in environment ${envId}: true`,
		);
	});

	it('includes existing allocation IDs when keys match', async () => {
		const flagId = 'flag-uuid-123';
		const envId = 'env-uuid-456';
		const existingId = 'existing-alloc-id-789';

		mockGetPrereqs(flagId, [{ id: existingId, key: 'my-flag-production' }]);
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

// ─── updateFlagTags ──────────────────────────────────────────────────────────

describe('fetchFlagTags', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns tags from flag response', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/flag-123`).reply(200, {
			data: { attributes: { tags: ['team:eng', 'manual-tag'] } },
		});

		const tags = await fetchFlagTags(API_KEY, APP_KEY, 'flag-123', SITE);
		expect(tags).toEqual(['team:eng', 'manual-tag']);
	});

	it('returns empty array when tags field is missing', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/flag-123`).reply(200, {
			data: { attributes: {} },
		});

		const tags = await fetchFlagTags(API_KEY, APP_KEY, 'flag-123', SITE);
		expect(tags).toEqual([]);
	});
});

describe('updateFlagTags', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('replaces all existing tags with the provided tags', async () => {
		mock.onPut(`${BASE}/api/v2/feature-flags/flag-123`).reply((config) => {
			const body = JSON.parse(config.data);
			expect(body).toEqual({
				data: {
					type: 'feature-flags',
					attributes: { tags: ['team:eng', 'ui'] },
				},
			});
			return [
				200,
				{ data: { id: 'flag-123', type: 'feature-flags', attributes: {} } },
			];
		});

		await updateFlagTags(
			API_KEY,
			APP_KEY,
			'flag-123',
			['team:eng', 'ui'],
			SITE,
		);
	});

	it('clears all tags when called with an empty array', async () => {
		mock.onPut(`${BASE}/api/v2/feature-flags/flag-123`).reply((config) => {
			const body = JSON.parse(config.data);
			expect(body).toEqual({
				data: {
					type: 'feature-flags',
					attributes: { tags: [] },
				},
			});
			return [
				200,
				{ data: { id: 'flag-123', type: 'feature-flags', attributes: {} } },
			];
		});

		await updateFlagTags(API_KEY, APP_KEY, 'flag-123', [], SITE);
	});

	it('throws on error response', async () => {
		mock.onPut(`${BASE}/api/v2/feature-flags/flag-123`).reply(403);

		await expect(
			updateFlagTags(API_KEY, APP_KEY, 'flag-123', ['team:eng'], SITE),
		).rejects.toThrow();
	});
});

// ─── fetchDatadogTeams ───────────────────────────────────────────────────────

describe('fetchDatadogTeams', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns teams with handle and name', async () => {
		mock.onGet(`${BASE}/api/v2/team`).reply(200, {
			data: [
				{ id: 't1', attributes: { handle: 'eng', name: 'Engineering' } },
				{ id: 't2', attributes: { handle: 'platform', name: 'Platform' } },
			],
		});

		const teams = await fetchDatadogTeams(API_KEY, APP_KEY, SITE);
		expect(teams).toEqual([
			{ id: 't1', handle: 'eng', name: 'Engineering' },
			{ id: 't2', handle: 'platform', name: 'Platform' },
		]);
	});

	it('paginates through multiple pages', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			id: `t${i}`,
			attributes: { handle: `team-${i}`, name: `Team ${i}` },
		}));
		const page2 = [
			{ id: 't100', attributes: { handle: 'team-100', name: 'Team 100' } },
		];

		mock
			.onGet(`${BASE}/api/v2/team`)
			.replyOnce(200, { data: page1 })
			.onGet(`${BASE}/api/v2/team`)
			.replyOnce(200, { data: page2 });

		const teams = await fetchDatadogTeams(API_KEY, APP_KEY, SITE);
		expect(teams).toHaveLength(101);
	});

	it('returns empty array when no teams exist', async () => {
		mock.onGet(`${BASE}/api/v2/team`).reply(200, { data: [] });

		const teams = await fetchDatadogTeams(API_KEY, APP_KEY, SITE);
		expect(teams).toEqual([]);
	});
});

// ─── fetchCurrentUserIdentity ─────────────────────────────────────────────────

describe('fetchCurrentUserIdentity', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns the authenticated user and org UUIDs', async () => {
		mock.onGet(`${BASE}/api/v2/current_user`).reply(200, {
			data: {
				id: 'user-uuid',
				type: 'users',
				relationships: {
					org: { data: { id: 'org-uuid', type: 'orgs' } },
				},
			},
		});

		await expect(
			fetchCurrentUserIdentity(API_KEY, APP_KEY, SITE),
		).resolves.toEqual({ userId: 'user-uuid', orgId: 'org-uuid' });
	});

	it('throws when the response does not contain both IDs', async () => {
		mock.onGet(`${BASE}/api/v2/current_user`).reply(200, {
			data: { id: '', relationships: { org: { data: { id: '' } } } },
		});

		await expect(
			fetchCurrentUserIdentity(API_KEY, APP_KEY, SITE),
		).rejects.toThrow('Could not determine Datadog user and org IDs');
	});
});

// ─── fetchRestrictionPolicy ───────────────────────────────────────────────────

describe('fetchRestrictionPolicy', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns existing bindings', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-uuid-123`)
			.reply(200, {
				data: {
					id: 'feature-flag:flag-uuid-123',
					type: 'restriction_policy',
					attributes: {
						bindings: [
							{ principals: ['team:creator-team'], relation: 'editor' },
						],
					},
				},
			});

		const result = await fetchRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-uuid-123',
			SITE,
		);
		expect(result).toEqual([
			{ principals: ['team:creator-team'], relation: 'editor' },
		]);
	});

	it('returns empty array when no policy exists (404)', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-uuid-123`)
			.reply(404, { errors: ['not found'] });

		const result = await fetchRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-uuid-123',
			SITE,
		);
		expect(result).toEqual([]);
	});

	it('throws on non-404 errors', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-uuid-123`)
			.reply(403, { errors: ['forbidden'] });

		await expect(
			fetchRestrictionPolicy(API_KEY, APP_KEY, 'flag-uuid-123', SITE),
		).rejects.toThrow();
	});
});

// ─── applyRestrictionPolicy ───────────────────────────────────────────────────

describe('applyRestrictionPolicy', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('merges new team IDs into an existing editor binding and POSTs', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-abc`)
			.reply(200, {
				data: {
					id: 'feature-flag:flag-abc',
					type: 'restriction_policy',
					attributes: {
						bindings: [
							{ principals: ['team:creator-team'], relation: 'editor' },
						],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-abc`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-abc',
			['platform', 'sre'],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		const editorBinding = bindings.find((b) => b.relation === 'editor');
		expect(editorBinding?.principals).toEqual(
			expect.arrayContaining([
				'user:test-user-id',
				'team:creator-team',
				'team:platform',
				'team:sre',
			]),
		);
		expect(editorBinding?.principals).toHaveLength(4);
		expect(bindings.find((b) => b.relation === 'viewer')?.principals).toEqual([
			'org:test-org-id',
		]);
		expect(mock.history.post[0]?.params).toEqual({
			allow_self_lockout: false,
		});
	});

	it('creates a new editor binding when no policy exists (404)', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-new`)
			.reply(404);

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-new`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-new',
			['platform'],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		expect(bindings.find((b) => b.relation === 'viewer')?.principals).toEqual([
			'org:test-org-id',
		]);
		expect(bindings.find((b) => b.relation === 'editor')?.principals).toEqual(
			expect.arrayContaining(['user:test-user-id', 'team:platform']),
		);
	});

	it('does nothing when editorTeamHandles is empty', async () => {
		let getCalled = false;
		let postCalled = false;
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-empty`)
			.reply(() => {
				getCalled = true;
				return [200, { data: { attributes: { bindings: [] } } }];
			});
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-empty`)
			.reply(() => {
				postCalled = true;
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-empty',
			[],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		expect(getCalled).toBe(false);
		expect(postCalled).toBe(false);
	});

	it('deduplicates principals that already exist in the binding', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-dup`)
			.reply(200, {
				data: {
					id: 'feature-flag:flag-dup',
					type: 'restriction_policy',
					attributes: {
						bindings: [{ principals: ['team:platform'], relation: 'editor' }],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-dup`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-dup',
			['platform'],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		const editorPrincipals =
			bindings.find((b) => b.relation === 'editor')?.principals ?? [];
		const platformCount = editorPrincipals.filter(
			(p: string) => p === 'team:platform',
		).length;
		expect(platformCount).toBe(1);
	});

	it('preserves viewer bindings and adds the org as a viewer', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-multi`)
			.reply(200, {
				data: {
					id: 'feature-flag:flag-multi',
					type: 'restriction_policy',
					attributes: {
						bindings: [
							{ principals: ['team:creator-team'], relation: 'editor' },
							{ principals: ['orgs/my-org'], relation: 'viewer' },
						],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-multi`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-multi',
			['platform'],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		const viewerBinding = bindings.find((b) => b.relation === 'viewer');
		const editorBinding = bindings.find((b) => b.relation === 'editor');
		expect(viewerBinding?.principals).toEqual(
			expect.arrayContaining(['orgs/my-org', 'org:test-org-id']),
		);
		expect(editorBinding?.principals).toEqual(
			expect.arrayContaining([
				'user:test-user-id',
				'team:creator-team',
				'team:platform',
			]),
		);
	});

	it('does not add the org as a viewer when it is already an editor', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-org-editor`)
			.reply(200, {
				data: {
					attributes: {
						bindings: [
							{
								principals: ['org:test-org-id'],
								relation: 'editor',
							},
						],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-org-editor`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-org-editor',
			['platform'],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		expect(bindings.find((b) => b.relation === 'viewer')).toBeUndefined();
		expect(bindings.find((b) => b.relation === 'editor')?.principals).toEqual(
			expect.arrayContaining([
				'org:test-org-id',
				'user:test-user-id',
				'team:platform',
			]),
		);
	});

	it('promotes required editors out of lower-access bindings', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-promote`)
			.reply(200, {
				data: {
					attributes: {
						bindings: [
							{
								principals: [
									'user:test-user-id',
									'team:platform',
									'team:existing-contributor',
								],
								relation: 'contributor',
							},
							{
								principals: ['org:test-org-id'],
								relation: 'viewer',
							},
						],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-promote`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await applyRestrictionPolicy(
			API_KEY,
			APP_KEY,
			'flag-promote',
			['platform'],
			'test-user-id',
			'test-org-id',
			SITE,
		);

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		expect(
			bindings.find((b) => b.relation === 'contributor')?.principals,
		).toEqual(['team:existing-contributor']);
		expect(bindings.find((b) => b.relation === 'editor')?.principals).toEqual(
			expect.arrayContaining(['user:test-user-id', 'team:platform']),
		);

		const allPrincipals = bindings.flatMap((binding) => binding.principals);
		expect(new Set(allPrincipals).size).toBe(allPrincipals.length);
	});
});

// ─── fetchCurrentUserPermissions ─────────────────────────────────────────────

describe('fetchCurrentUserPermissions', () => {
	let mock: AxiosMockAdapter;

	const PROBE_URLS = {
		feature_flag_config_read: '/api/v2/feature-flags',
		feature_flag_environment_config_read: '/api/v2/feature-flags/environments',
		teams_read: '/api/v2/team',
		restriction_policies_read:
			'/api/v2/restriction_policy/feature-flag:permission-probe',
	} as const;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns the permissions whose probe endpoints are accessible', async () => {
		mock.onGet(`${BASE}${PROBE_URLS.feature_flag_config_read}`).reply(200);
		mock
			.onGet(`${BASE}${PROBE_URLS.feature_flag_environment_config_read}`)
			.reply(200);
		mock.onGet(`${BASE}${PROBE_URLS.teams_read}`).reply(403);
		mock.onGet(`${BASE}${PROBE_URLS.restriction_policies_read}`).reply(200);

		const result = await fetchCurrentUserPermissions(API_KEY, APP_KEY, SITE);
		expect(result).toEqual(
			expect.arrayContaining([
				'feature_flag_config_read',
				'feature_flag_environment_config_read',
				'restriction_policies_read',
			]),
		);
		expect(result).not.toContain('teams_read');
	});

	it('counts probe 404 as accessible (endpoint reachable, resource absent)', async () => {
		mock.onGet(`${BASE}${PROBE_URLS.feature_flag_config_read}`).reply(404);
		mock
			.onGet(`${BASE}${PROBE_URLS.feature_flag_environment_config_read}`)
			.reply(404);
		mock.onGet(`${BASE}${PROBE_URLS.teams_read}`).reply(404);
		mock.onGet(`${BASE}${PROBE_URLS.restriction_policies_read}`).reply(404);

		const result = await fetchCurrentUserPermissions(API_KEY, APP_KEY, SITE);
		expect(result).toEqual(
			expect.arrayContaining([
				'feature_flag_config_read',
				'feature_flag_environment_config_read',
				'teams_read',
				'restriction_policies_read',
			]),
		);
	});

	it('returns empty array when every probe is forbidden', async () => {
		mock.onGet(`${BASE}${PROBE_URLS.feature_flag_config_read}`).reply(403);
		mock
			.onGet(`${BASE}${PROBE_URLS.feature_flag_environment_config_read}`)
			.reply(403);
		mock.onGet(`${BASE}${PROBE_URLS.teams_read}`).reply(403);
		mock.onGet(`${BASE}${PROBE_URLS.restriction_policies_read}`).reply(403);

		const result = await fetchCurrentUserPermissions(API_KEY, APP_KEY, SITE);
		expect(result).toEqual([]);
	});

	it('uses the site parameter in all probe URLs', async () => {
		const eu = 'datadoghq.eu';
		const euBase = `https://api.${eu}`;
		mock.onGet(`${euBase}${PROBE_URLS.feature_flag_config_read}`).reply(200);
		mock
			.onGet(`${euBase}${PROBE_URLS.feature_flag_environment_config_read}`)
			.reply(403);
		mock.onGet(`${euBase}${PROBE_URLS.teams_read}`).reply(403);
		mock.onGet(`${euBase}${PROBE_URLS.restriction_policies_read}`).reply(403);

		const result = await fetchCurrentUserPermissions(API_KEY, APP_KEY, eu);
		expect(result).toEqual(['feature_flag_config_read']);
	});

	it('sends auth headers on every probe', async () => {
		const headers: Record<string, unknown>[] = [];
		const captureAndAllow = (config: { headers?: unknown }) => {
			headers.push(config.headers as Record<string, unknown>);
			return [200] as [number];
		};
		mock
			.onGet(`${BASE}${PROBE_URLS.feature_flag_config_read}`)
			.reply(captureAndAllow);
		mock
			.onGet(`${BASE}${PROBE_URLS.feature_flag_environment_config_read}`)
			.reply(captureAndAllow);
		mock.onGet(`${BASE}${PROBE_URLS.teams_read}`).reply(captureAndAllow);
		mock
			.onGet(`${BASE}${PROBE_URLS.restriction_policies_read}`)
			.reply(captureAndAllow);

		await fetchCurrentUserPermissions(API_KEY, APP_KEY, SITE);
		expect(headers).toHaveLength(4);
		for (const h of headers) {
			expect(h['dd-api-key']).toBe(API_KEY);
			expect(h['dd-application-key']).toBe(APP_KEY);
		}
	});
});

// ─── DD client rate-limit handling ───────────────────────────────────────────

describe('Datadog client rate-limit handling', () => {
	let client: ReturnType<typeof createDDClient>;
	let mock: AxiosMockAdapter;
	let warnSpy: ReturnType<typeof jest.spyOn>;
	let setTimeoutSpy: ReturnType<typeof jest.spyOn>;

	beforeEach(() => {
		// Fire timer callbacks synchronously so the retry/pause logic runs without
		// real delays. Date.now() is left untouched — the pause-until comparison
		// uses real time deltas, which is what we want for assertions.
		setTimeoutSpy = jest
			.spyOn(global, 'setTimeout')
			.mockImplementation((cb: unknown) => {
				(cb as () => void)();
				return 0 as unknown as ReturnType<typeof setTimeout>;
			}) as never;
		client = createDDClient();
		mock = new AxiosMockAdapter(client as never);
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		mock.restore();
		warnSpy.mockRestore();
		setTimeoutSpy.mockRestore();
	});

	it('retries on 429 using x-ratelimit-reset header for delay', async () => {
		mock
			.onGet(`${BASE}/foo`)
			.replyOnce(429, {}, { 'x-ratelimit-reset': '5' })
			.onGet(`${BASE}/foo`)
			.replyOnce(200, { ok: true });

		const response = await client.get(`${BASE}/foo`);
		expect(response.status).toBe(200);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/429.*retrying after 6s.*attempt 1 of 3/i),
		);
	});

	it('falls back to exponential backoff when 429 has no reset header', async () => {
		mock
			.onGet(`${BASE}/foo`)
			.replyOnce(429)
			.onGet(`${BASE}/foo`)
			.replyOnce(200, {});

		const response = await client.get(`${BASE}/foo`);
		expect(response.status).toBe(200);
		// First-attempt backoff base is 1s.
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/429.*retrying after 1s/i),
		);
	});

	it('retries a feature flag contribution denial while policy changes propagate', async () => {
		const url = `${BASE}/api/v2/feature-flags/flag-uuid/environments/env-uuid/allocations`;
		mock
			.onPut(url)
			.replyOnce(403, {
				errors: [
					{
						detail:
							'feature-flag permission for contributing to feature flag flag-uuid: permission denied',
					},
				],
			})
			.onPut(url)
			.replyOnce(200, {});

		const response = await client.put(url, {});
		expect(response.status).toBe(200);
		expect(mock.history.put).toHaveLength(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(
				/permissions are still propagating.*attempt 1 of 3/i,
			),
		);
	});

	it('retries the feature flag edit denial used by the contributor fallback', async () => {
		const url = `${BASE}/api/v2/feature-flags/flag-uuid`;
		mock
			.onPut(url)
			.replyOnce(403, {
				errors: [
					{
						detail:
							'feature-flag permission for modifying feature flag flag-uuid: permission denied',
					},
				],
			})
			.onPut(url)
			.replyOnce(200, {});

		const response = await client.put(url, {});
		expect(response.status).toBe(200);
		expect(mock.history.put).toHaveLength(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(
				/permissions are still propagating.*attempt 1 of 3/i,
			),
		);
	});

	it('does not retry unrelated permission denials', async () => {
		const url = `${BASE}/api/v2/feature-flags/flag-uuid`;
		mock.onPut(url).reply(403, {
			errors: [{ detail: 'application key is missing a required permission' }],
		});

		await expect(client.put(url, {})).rejects.toMatchObject({
			response: { status: 403 },
		});
		expect(mock.history.put).toHaveLength(1);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('stops retrying a persistent feature flag contribution denial', async () => {
		const url = `${BASE}/api/v2/feature-flags/flag-uuid`;
		mock.onPut(url).reply(403, {
			errors: [
				{
					detail:
						'feature-flag permission for contributing to feature flag flag-uuid: permission denied',
				},
			],
		});

		await expect(client.put(url, {})).rejects.toMatchObject({
			response: { status: 403 },
		});
		expect(mock.history.put).toHaveLength(4);
		expect(warnSpy).toHaveBeenCalledTimes(3);
	});

	it('throws after exhausting max retries on 429', async () => {
		mock.onGet(`${BASE}/foo`).reply(429);

		await expect(client.get(`${BASE}/foo`)).rejects.toThrow(
			/rate-limited after 3 retries/i,
		);
	});

	it('pauses proactively when x-ratelimit-remaining drops below threshold', async () => {
		mock
			.onGet(`${BASE}/foo`)
			.reply(
				200,
				{},
				{ 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': '10' },
			);

		await client.get(`${BASE}/foo`);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/nearly exhausted.*2 remaining.*pausing 10s/i),
		);

		// Next request must wait for the pause window — the (mocked) setTimeout
		// fires for ~10s of virtual delay.
		const callsBefore = setTimeoutSpy.mock.calls.length;
		await client.get(`${BASE}/foo`);
		const newDelays = (
			setTimeoutSpy.mock.calls.slice(callsBefore) as Array<[unknown, number]>
		).map(([, ms]) => ms);
		expect(newDelays.some((ms) => ms > 5_000)).toBe(true);
	});

	it('does not pause when remaining is above threshold', async () => {
		mock
			.onGet(`${BASE}/foo`)
			.reply(
				200,
				{},
				{ 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '60' },
			);

		await client.get(`${BASE}/foo`);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('does not shorten an existing pause when a later response has a smaller reset window', async () => {
		// First response sets a 60s pause.
		mock
			.onGet(`${BASE}/foo`)
			.reply(
				200,
				{},
				{ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '60' },
			);

		await client.get(`${BASE}/foo`);

		// Second response would set only a 5s pause — should be ignored (max wins).
		mock
			.onGet(`${BASE}/foo`)
			.reply(
				200,
				{},
				{ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '5' },
			);

		await client.get(`${BASE}/foo`);

		// The next request must still observe the original 60s pause, not the
		// shorter 5s one that followed it.
		const callsBefore = setTimeoutSpy.mock.calls.length;
		await client.get(`${BASE}/foo`);
		const newDelays = (
			setTimeoutSpy.mock.calls.slice(callsBefore) as Array<[unknown, number]>
		).map(([, ms]) => ms);
		expect(newDelays.some((ms) => ms > 50_000)).toBe(true);
	});

	it('only warns once when concurrent responses extend the same pause window', async () => {
		mock
			.onGet(`${BASE}/foo`)
			.reply(
				200,
				{},
				{ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '5' },
			);

		// First request opens the pause window and emits the warn.
		await client.get(`${BASE}/foo`);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		// Subsequent responses still carry low-remaining headers — they should
		// extend the pause silently rather than re-warning.
		await Promise.all([
			client.get(`${BASE}/foo`),
			client.get(`${BASE}/foo`),
			client.get(`${BASE}/foo`),
		]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});

// ─── Variant CRUD ────────────────────────────────────────────────────────────

describe('createVariant', () => {
	let mock: AxiosMockAdapter;
	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});
	afterEach(() => {
		mock.restore();
	});

	it('POSTs JSON:API body and returns parsed variant', async () => {
		mock
			.onPost(`${BASE}/api/v2/feature-flags/flag-1/variants`)
			.reply((config) => {
				const body = JSON.parse(config.data as string);
				expect(body).toEqual({
					data: {
						type: 'variants',
						attributes: {
							key: 'red',
							name: 'Red',
							value: 'red',
							migration_metadata: {
								provider: 'eppo',
								source_id: 'sid-red',
								source_key: 'red',
							},
						},
					},
				});
				expect(config.headers?.['Content-Type']).toBe(
					'application/vnd.api+json',
				);
				return [
					201,
					{
						data: {
							id: 'var-uuid-1',
							type: 'variants',
							attributes: { key: 'red', name: 'Red', value: 'red' },
						},
					},
				];
			});

		const result = await createVariant(
			API_KEY,
			APP_KEY,
			'flag-1',
			{
				key: 'red',
				name: 'Red',
				value: 'red',
				migrationMetadata: {
					provider: 'eppo',
					source_id: 'sid-red',
					source_key: 'red',
				},
			},
			SITE,
		);
		expect(result).toEqual({
			id: 'var-uuid-1',
			key: 'red',
			name: 'Red',
			value: 'red',
		});
	});
});

describe('updateVariant', () => {
	let mock: AxiosMockAdapter;
	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});
	afterEach(() => {
		mock.restore();
	});

	it('PUTs to the variant URL with the right body', async () => {
		mock
			.onPut(`${BASE}/api/v2/feature-flags/flag-1/variants/var-uuid-1`)
			.reply((config) => {
				const body = JSON.parse(config.data as string);
				expect(body).toEqual({
					data: {
						type: 'variants',
						id: 'var-uuid-1',
						attributes: {
							name: 'Crimson',
							value: 'crimson',
							migration_metadata: {
								provider: 'launchdarkly',
								source_id: 'sid-red',
								source_key: 'red',
							},
						},
					},
				});
				return [200, {}];
			});

		await updateVariant(
			API_KEY,
			APP_KEY,
			'flag-1',
			'var-uuid-1',
			{
				name: 'Crimson',
				value: 'crimson',
				migrationMetadata: {
					provider: 'launchdarkly',
					source_id: 'sid-red',
					source_key: 'red',
				},
			},
			SITE,
		);
	});
});

describe('deleteVariant', () => {
	let mock: AxiosMockAdapter;
	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});
	afterEach(() => {
		mock.restore();
	});

	it('DELETEs the variant URL', async () => {
		let called = false;
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/var-uuid-1`)
			.reply(() => {
				called = true;
				return [204, {}];
			});

		await deleteVariant(API_KEY, APP_KEY, 'flag-1', 'var-uuid-1', SITE);
		expect(called).toBe(true);
	});
});

describe('syncVariants', () => {
	let mock: AxiosMockAdapter;
	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});
	afterEach(() => {
		mock.restore();
	});

	function mockFlagDetail(
		flagId: string,
		variants: Array<{
			id: string;
			key: string;
			name: string;
			value: string;
			migration_metadata?: Record<string, unknown>;
		}>,
	): void {
		mock.onGet(`${BASE}/api/v2/feature-flags/${flagId}`).reply(200, {
			data: {
				id: flagId,
				type: 'feature-flags',
				attributes: {
					variants,
					feature_flag_environments: [],
				},
			},
		});
	}

	it('adds, updates, and deletes variants based on key diff', async () => {
		mockFlagDetail('flag-1', [
			{
				id: 'v-keep',
				key: 'keep',
				name: 'Keep',
				value: 'k',
				migration_metadata: {
					provider: 'launchdarkly',
					source_id: 'sid-keep',
					source_key: 'keep',
				},
			},
			{ id: 'v-old', key: 'old', name: 'Old', value: 'o' },
			{
				id: 'v-upd',
				key: 'upd',
				name: 'Upd',
				value: 'u',
				migration_metadata: {
					provider: 'launchdarkly',
					source_id: 'sid-upd',
					source_key: 'upd',
				},
			},
		]);

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/feature-flags/flag-1/variants`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [
					201,
					{
						data: {
							id: 'v-new',
							type: 'variants',
							attributes: { key: 'new', name: 'New', value: 'n' },
						},
					},
				];
			});

		let putBody: unknown;
		mock
			.onPut(`${BASE}/api/v2/feature-flags/flag-1/variants/v-upd`)
			.reply((config) => {
				putBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		let deleteCalled = false;
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-old`)
			.reply(() => {
				deleteCalled = true;
				return [204, {}];
			});

		const result = await syncVariants(
			API_KEY,
			APP_KEY,
			'flag-1',
			[
				{ key: 'keep', name: 'Keep', value: 'k', sourceId: 'sid-keep' },
				{ key: 'upd', name: 'Updated', value: 'u2', sourceId: 'sid-upd' },
				{ key: 'new', name: 'New', value: 'n', sourceId: 'sid-new' },
			],
			'launchdarkly',
			SITE,
		);

		expect(result.counts).toEqual({ added: 1, updated: 1, deleted: 1 });
		expect(result.variantKeyToId.get('keep')).toBe('v-keep');
		expect(result.variantKeyToId.get('upd')).toBe('v-upd');
		expect(result.variantKeyToId.get('new')).toBe('v-new');
		expect(result.variantKeyToId.has('old')).toBe(false);
		expect(deleteCalled).toBe(true);

		expect(
			(postBody as { data: { attributes: { migration_metadata: unknown } } })
				.data.attributes.migration_metadata,
		).toEqual({
			provider: 'launchdarkly',
			source_id: 'sid-new',
			source_key: 'new',
		});
		expect(
			(putBody as { data: { attributes: { migration_metadata: unknown } } })
				.data.attributes.migration_metadata,
		).toEqual({
			provider: 'launchdarkly',
			source_id: 'sid-upd',
			source_key: 'upd',
		});
	});

	it('no-ops when source and existing variants match exactly', async () => {
		mockFlagDetail('flag-1', [
			{
				id: 'v1',
				key: 'a',
				name: 'A',
				value: '1',
				migration_metadata: {
					provider: 'eppo',
					source_id: 'sid-a',
					source_key: 'a',
				},
			},
			{
				id: 'v2',
				key: 'b',
				name: 'B',
				value: '2',
				migration_metadata: {
					provider: 'eppo',
					source_id: 'sid-b',
					source_key: 'b',
				},
			},
		]);

		const result = await syncVariants(
			API_KEY,
			APP_KEY,
			'flag-1',
			[
				{ key: 'a', name: 'A', value: '1', sourceId: 'sid-a' },
				{ key: 'b', name: 'B', value: '2', sourceId: 'sid-b' },
			],
			'eppo',
			SITE,
		);

		expect(result.counts).toEqual({ added: 0, updated: 0, deleted: 0 });
		expect(result.variantKeyToId).toEqual(
			new Map([
				['a', 'v1'],
				['b', 'v2'],
			]),
		);
	});

	it('populates eppo provider in migration_metadata on add', async () => {
		mockFlagDetail('flag-1', []);

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/feature-flags/flag-1/variants`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [
					201,
					{
						data: {
							id: 'v-new',
							type: 'variants',
							attributes: { key: 'x', name: 'X', value: 'x' },
						},
					},
				];
			});

		await syncVariants(
			API_KEY,
			APP_KEY,
			'flag-1',
			[{ key: 'x', name: 'X', value: 'x', sourceId: 'sid-x' }],
			'eppo',
			SITE,
		);
		expect(
			(postBody as { data: { attributes: { migration_metadata: unknown } } })
				.data.attributes.migration_metadata,
		).toEqual({ provider: 'eppo', source_id: 'sid-x', source_key: 'x' });
	});

	it('returns source-key aliases for variants matched by source_id', async () => {
		mockFlagDetail('flag-1', [
			{
				id: 'v-renamed',
				key: 'old-name',
				name: 'Old Name',
				value: 'value',
				migration_metadata: {
					provider: 'launchdarkly',
					source_id: 'sid-1',
					source_key: 'old-name',
				},
			},
		]);

		mock
			.onPut(`${BASE}/api/v2/feature-flags/flag-1/variants/v-renamed`)
			.reply(200, {});

		const result = await syncVariantsCreatesAndUpdates(
			API_KEY,
			APP_KEY,
			'flag-1',
			[
				{
					key: 'new-name',
					name: 'New Name',
					value: 'value',
					sourceId: 'sid-1',
				},
			],
			'launchdarkly',
			SITE,
		);

		expect(result.variantKeyToId.get('old-name')).toBe('v-renamed');
		expect(result.variantKeyToId.get('new-name')).toBe('v-renamed');
	});

	it('creates with a collision-free key and preserves the source-key alias', async () => {
		mockFlagDetail('flag-1', [
			{
				id: 'v-old',
				key: 'same-key',
				name: 'Same Key',
				value: 'old-value',
				migration_metadata: {
					provider: 'launchdarkly',
					source_id: 'sid-old',
					source_key: 'same-key',
				},
			},
		]);

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/feature-flags/flag-1/variants`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [
					201,
					{
						data: {
							id: 'v-new',
							type: 'variants',
							attributes: {
								key: 'same-key-1',
								name: 'Same Key',
								value: 'new-value',
							},
						},
					},
				];
			});

		const result = await syncVariantsCreatesAndUpdates(
			API_KEY,
			APP_KEY,
			'flag-1',
			[
				{
					key: 'same-key',
					name: 'Same Key',
					value: 'new-value',
					sourceId: 'sid-new',
				},
			],
			'launchdarkly',
			SITE,
		);

		expect(
			(
				postBody as {
					data: {
						attributes: {
							key: string;
							migration_metadata: Record<string, unknown>;
						};
					};
				}
			).data.attributes,
		).toMatchObject({
			key: 'same-key-1',
			migration_metadata: {
				provider: 'launchdarkly',
				source_id: 'sid-new',
				source_key: 'same-key',
			},
		});
		expect(result.variantKeyToId.get('same-key-1')).toBe('v-new');
		expect(result.variantKeyToId.get('same-key')).toBe('v-new');
		expect(result.sourceKeyToDatadogKey.get('same-key')).toBe('same-key-1');
		expect(result.pendingDeletes).toEqual([{ id: 'v-old', key: 'same-key' }]);
	});
});

// ─── planVariantSync — rename & legacy matching ──────────────────────────────

describe('planVariantSync — source_id matching', () => {
	it('matches by migration_metadata.source_id across a variation rename', () => {
		// DD already holds a variant migrated as "old-name" with source_id "abc".
		// The source variation was renamed; slugified key is now "new-name".
		const plan = planVariantSync(
			[
				{
					key: 'new-name',
					name: 'New Name',
					value: 'v',
					sourceId: 'abc',
				},
			],
			[
				{
					id: 'uuid-1',
					key: 'old-name',
					name: 'Old Name',
					value: 'v',
					migration_metadata: {
						provider: 'launchdarkly',
						source_id: 'abc',
						source_key: 'old-name',
					},
				},
			],
		);
		expect(plan.toCreate).toEqual([]);
		expect(plan.toDelete).toEqual([]);
		expect(plan.toUpdate).toHaveLength(1);
		// DD key stays put (immutable) — only name/value/metadata move.
		expect(plan.toUpdate[0]).toEqual({
			id: 'uuid-1',
			key: 'old-name',
			name: 'New Name',
			value: 'v',
			sourceId: 'abc',
			sourceKey: 'new-name',
		});
	});

	it('falls back to key match for legacy DD variants without migration_metadata', () => {
		const plan = planVariantSync(
			[{ key: 'red', name: 'Red', value: 'r', sourceId: 'sid-red' }],
			[
				{
					id: 'uuid-1',
					key: 'red',
					name: 'Red',
					value: 'r',
					// no migration_metadata
				},
			],
		);
		expect(plan.toCreate).toEqual([]);
		expect(plan.toDelete).toEqual([]);
		// Legacy fallback matches are updated so future re-migrations can match by source_id.
		expect(plan.toUpdate).toEqual([
			{
				id: 'uuid-1',
				key: 'red',
				name: 'Red',
				value: 'r',
				sourceId: 'sid-red',
				sourceKey: 'red',
			},
		]);
	});

	it('does not reuse one legacy fallback match for multiple source variants', () => {
		const sourceA = {
			key: 'same',
			name: 'Same',
			value: 'control',
			sourceId: 'sid-a',
		};
		const sourceB = {
			key: 'same-1',
			name: 'Same',
			value: 'treatment',
			sourceId: 'sid-b',
		};

		const plan = planVariantSync(
			[sourceA, sourceB],
			[{ id: 'uuid-a', key: 'same', name: 'Same', value: 'control' }],
		);

		expect(plan.toUpdate).toEqual([
			{
				id: 'uuid-a',
				key: 'same',
				name: 'Same',
				value: 'control',
				sourceId: 'sid-a',
				sourceKey: 'same',
			},
		]);
		expect(plan.toCreate).toEqual([sourceB]);
		expect(plan.toDelete).toEqual([]);
	});

	it('plans create + delete when neither source_id nor key matches', () => {
		const plan = planVariantSync(
			[{ key: 'green', name: 'Green', value: 'g', sourceId: 'sid-green' }],
			[
				{
					id: 'uuid-old',
					key: 'old',
					name: 'Old',
					value: 'o',
					migration_metadata: {
						provider: 'eppo',
						source_id: 'sid-old',
						source_key: 'old',
					},
				},
			],
		);
		expect(plan.toCreate).toHaveLength(1);
		expect(plan.toDelete).toEqual([{ id: 'uuid-old', key: 'old' }]);
	});

	it('does not fallback-match a variant that has a different source_id', () => {
		const source = {
			key: 'new-a',
			name: 'A',
			value: 'a',
			sourceId: 'sid-new',
		};
		const plan = planVariantSync(
			[source],
			[
				{
					id: 'uuid-old',
					key: 'old-a',
					name: 'A',
					value: 'a',
					migration_metadata: {
						provider: 'launchdarkly',
						source_id: 'sid-old',
						source_key: 'old-a',
					},
				},
			],
		);

		expect(plan.toCreate).toEqual([source]);
		expect(plan.toUpdate).toEqual([]);
		expect(plan.toDelete).toEqual([{ id: 'uuid-old', key: 'old-a' }]);
	});

	it('does not fallback-match by key when the existing variant has a different source_id', () => {
		const source = {
			key: 'same-key',
			name: 'Same Key',
			value: 'new-value',
			sourceId: 'sid-new',
		};
		const plan = planVariantSync(
			[source],
			[
				{
					id: 'uuid-old',
					key: 'same-key',
					name: 'Same Key',
					value: 'old-value',
					migration_metadata: {
						provider: 'launchdarkly',
						source_id: 'sid-old',
						source_key: 'same-key',
					},
				},
			],
		);

		expect(plan.toCreate).toEqual([
			{ ...source, key: 'same-key-1', sourceKey: 'same-key' },
		]);
		expect(plan.toUpdate).toEqual([]);
		expect(plan.toDelete).toEqual([{ id: 'uuid-old', key: 'same-key' }]);
	});

	it('does not fallback-match by name when legacy names are duplicated', () => {
		const source = {
			key: 'same',
			name: 'Same',
			value: 'new-value',
			sourceId: 'sid-new',
		};
		const plan = planVariantSync(
			[source],
			[
				{ id: 'uuid-a', key: 'old-a', name: 'Same', value: 'old-a' },
				{ id: 'uuid-b', key: 'old-b', name: 'Same', value: 'old-b' },
			],
		);

		expect(plan.toCreate).toEqual([source]);
		expect(plan.toUpdate).toEqual([]);
		expect(plan.toDelete).toEqual([
			{ id: 'uuid-a', key: 'old-a' },
			{ id: 'uuid-b', key: 'old-b' },
		]);
	});

	it('still fallback-matches unique legacy scalar values', () => {
		const plan = planVariantSync(
			[{ key: 'true', name: 'true', value: 'true', sourceId: 'sid-true' }],
			[
				{
					id: 'uuid-true',
					key: 'variation-0',
					name: 'Variation 0',
					value: 'true',
				},
			],
		);

		expect(plan.toCreate).toEqual([]);
		expect(plan.toUpdate).toEqual([
			{
				id: 'uuid-true',
				key: 'variation-0',
				name: 'true',
				value: 'true',
				sourceId: 'sid-true',
				sourceKey: 'true',
			},
		]);
		expect(plan.toDelete).toEqual([]);
	});

	it('builds source-key aliases for dry-run update requests', () => {
		const { sourceKeyToDatadogKey } = buildVariantSyncDryRunRequests(
			'flag-1',
			[
				{
					key: 'new-name',
					name: 'New Name',
					value: 'value',
					sourceId: 'sid-1',
				},
			],
			[
				{
					id: 'v-renamed',
					key: 'old-name',
					name: 'Old Name',
					value: 'value',
					migration_metadata: {
						provider: 'launchdarkly',
						source_id: 'sid-1',
						source_key: 'old-name',
					},
				},
			],
			'launchdarkly',
		);

		expect(sourceKeyToDatadogKey.get('new-name')).toBe('old-name');
	});

	it('builds source-key to UUID aliases for legacy boolean variants', () => {
		const aliases = buildVariantKeyToIdAliases(
			[
				{
					key: 'true',
					name: 'Enabled',
					value: 'true',
					sourceId: 'ld-true',
				},
				{
					key: 'false',
					name: 'Disabled',
					value: 'false',
					sourceId: 'ld-false',
				},
			],
			[
				{
					id: 'uuid-enabled',
					key: 'enabled',
					name: 'Enabled',
					value: 'true',
				},
				{
					id: 'uuid-disabled',
					key: 'disabled',
					name: 'Disabled',
					value: 'false',
				},
			],
		);

		expect(aliases).toEqual(
			new Map([
				['true', 'uuid-enabled'],
				['false', 'uuid-disabled'],
			]),
		);
	});
});

// ─── syncVariants — ordering: creates/updates before deletes ─────────────────

describe('syncVariants ordering', () => {
	let mock: AxiosMockAdapter;
	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});
	afterEach(() => {
		mock.restore();
	});

	it('performs creates+updates before deletes', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/flag-1`).reply(200, {
			data: {
				id: 'flag-1',
				type: 'feature-flags',
				attributes: {
					variants: [
						{
							id: 'v-keep',
							key: 'keep',
							name: 'Keep',
							value: 'k',
							migration_metadata: {
								provider: 'launchdarkly',
								source_id: 'sid-keep',
								source_key: 'keep',
							},
						},
						{ id: 'v-old', key: 'old', name: 'Old', value: 'o' },
					],
					feature_flag_environments: [],
				},
			},
		});

		const order: string[] = [];
		mock.onPost(`${BASE}/api/v2/feature-flags/flag-1/variants`).reply(() => {
			order.push('create');
			return [
				201,
				{
					data: {
						id: 'v-new',
						type: 'variants',
						attributes: { key: 'new', name: 'New', value: 'n' },
					},
				},
			];
		});
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-old`)
			.reply(() => {
				order.push('delete');
				return [204, {}];
			});

		await syncVariants(
			API_KEY,
			APP_KEY,
			'flag-1',
			[
				{ key: 'keep', name: 'Keep', value: 'k', sourceId: 'sid-keep' },
				{ key: 'new', name: 'New', value: 'n', sourceId: 'sid-new' },
			],
			'launchdarkly',
			SITE,
		);

		expect(order).toEqual(['create', 'delete']);
	});

	it('syncVariantsCreatesAndUpdates does NOT issue deletes', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags/flag-1`).reply(200, {
			data: {
				id: 'flag-1',
				type: 'feature-flags',
				attributes: {
					variants: [
						{
							id: 'v-keep',
							key: 'keep',
							name: 'Keep',
							value: 'k',
							migration_metadata: {
								provider: 'eppo',
								source_id: 'sid-keep',
								source_key: 'keep',
							},
						},
						{ id: 'v-old', key: 'old', name: 'Old', value: 'o' },
					],
					feature_flag_environments: [],
				},
			},
		});

		let deleteCalled = false;
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-old`)
			.reply(() => {
				deleteCalled = true;
				return [204, {}];
			});

		const result = await syncVariantsCreatesAndUpdates(
			API_KEY,
			APP_KEY,
			'flag-1',
			[{ key: 'keep', name: 'Keep', value: 'k', sourceId: 'sid-keep' }],
			'eppo',
			SITE,
		);

		// Delete is reported as pending but not yet executed — the re-migration
		// "no new envs to enable" branch never calls applyVariantDeletes here,
		// because no allocation rewrite happens to clear UUID references.
		expect(deleteCalled).toBe(false);
		expect(result.pendingDeletes).toEqual([{ id: 'v-old', key: 'old' }]);
		expect(result.counts.deleted).toBe(1);
	});

	it('applyVariantDeletes issues DELETEs in order', async () => {
		const order: string[] = [];
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-a`)
			.reply(() => {
				order.push('a');
				return [204, {}];
			});
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-b`)
			.reply(() => {
				order.push('b');
				return [204, {}];
			});

		await applyVariantDeletes(
			API_KEY,
			APP_KEY,
			'flag-1',
			[
				{ id: 'v-a', key: 'a' },
				{ id: 'v-b', key: 'b' },
			],
			SITE,
		);
		expect(order).toEqual(['a', 'b']);
	});

	it('applyVariantDeletes silently ignores delete failures', async () => {
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-a`)
			.reply(422, { errors: ['variant is still referenced'] });
		mock
			.onDelete(`${BASE}/api/v2/feature-flags/flag-1/variants/v-b`)
			.reply(204, {});

		await expect(
			applyVariantDeletes(
				API_KEY,
				APP_KEY,
				'flag-1',
				[
					{ id: 'v-a', key: 'a' },
					{ id: 'v-b', key: 'b' },
				],
				SITE,
			),
		).resolves.toBeUndefined();
	});
});
