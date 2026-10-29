import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	ddClient,
	fetchAllSavedFilters,
	fetchDatadogStatusFlagDetail,
	fetchSavedFilter,
} from '../src/datadog/api.js';

const originalEnv = { ...process.env };

describe('Datadog read model', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
		process.env = { ...originalEnv };
	});

	it('parses flag attributes and environment overrides', async () => {
		mock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/flag-id')
			.reply(200, {
				data: {
					id: 'flag-id',
					attributes: {
						key: 'example-flag',
						name: 'Example Flag',
						description: 'An example flag',
						value_type: 'BOOLEAN',
						bucketing_mode: 'EPPO',
						distribution_channel: 'CLIENT',
						tags: ['team:example'],
						variants: [
							{ id: 'v-on', key: 'on', name: 'On', value: 'true' },
							{ id: 'v-off', key: 'off', name: 'Off', value: 'false' },
						],
						feature_flag_environments: [
							{
								environment_id: 'env-prod',
								status: 'ENABLED',
								default_variant_id: 'v-off',
								override_variant_id: 'v-on',
								allocations: [
									{
										id: 'allocation-id',
										key: 'example-flag-rollout',
										eppo_allocation_id: 42,
										type: 'CANARY',
										status: 'published',
										order_position: 0,
										experiment_id: null,
										variant_weights: [
											{
												variant_id: 'v-on',
												value: 100,
												eppo_variant_weight_id: 43,
											},
										],
									},
								],
							},
						],
					},
				},
			});

		const detail = await fetchDatadogStatusFlagDetail('api', 'app', 'flag-id');

		expect(detail).toMatchObject({
			description: 'An example flag',
			valueType: 'BOOLEAN',
			bucketingMode: 'EPPO',
			distributionChannel: 'CLIENT',
			tags: ['team:example'],
			environments: [
				{
					defaultVariantKey: 'off',
					overrideVariantKey: 'on',
					allocations: [
						{
							type: 'CANARY',
							order_position: 0,
							eppo_allocation_id: 42,
							variant_weights: [{ eppo_variant_weight_id: 43 }],
						},
					],
				},
			],
		});
	});

	it('does not infer an Eppo default from a targeting filter named fallthrough', async () => {
		mock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/flag-id')
			.reply(200, {
				data: {
					id: 'flag-id',
					attributes: {
						key: 'eppo-flag',
						name: 'Eppo flag',
						bucketing_mode: 'EPPO',
						variants: [{ id: 'v-on', key: 'on', name: 'On', value: 'true' }],
						feature_flag_environments: [
							{
								environment_id: 'env-prod',
								status: 'ENABLED',
								default_variant_id: null,
								allocations: [
									{
										key: 'eppo-fallthrough',
										variant_weights: [{ variant_id: 'v-on', value: 100 }],
									},
								],
							},
						],
					},
				},
			});
		const detail = await fetchDatadogStatusFlagDetail('api', 'app', 'flag-id');
		expect(detail.environments[0].defaultVariantKey).toBeUndefined();
	});

	it('honors DD_BASE_URL when fetching flag details', async () => {
		process.env.DD_BASE_URL = 'https://proxy.example';
		mock
			.onGet('https://proxy.example/api/v2/feature-flags/flag-id')
			.reply(200, {
				data: {
					id: 'flag-id',
					attributes: {
						key: 'example-flag',
						name: 'Example Flag',
						variants: [],
						feature_flag_environments: [],
					},
				},
			});

		const detail = await fetchDatadogStatusFlagDetail('api', 'app', 'flag-id');

		expect(detail.key).toBe('example-flag');
	});

	it('pages saved filters with rules and strips server-assigned IDs', async () => {
		const url = 'https://api.datadoghq.com/api/v2/feature-flags/saved-filters';
		mock
			.onGet(url, { params: { offset: 0, include_rules: true } })
			.reply(200, {
				data: [
					{
						id: 'filter-1',
						attributes: {
							name: 'Beta users',
							description: null,
							creation_type: 'LIST',
							targeting_rules: [
								{
									id: 'rule-id',
									conditions: [
										{
											id: 'condition-id',
											operator: 'ONE_OF',
											attribute: 'id',
											value: ['user-a'],
										},
									],
								},
							],
						},
					},
				],
				meta: { total: 2 },
			})
			.onGet(url, { params: { offset: 1, include_rules: true } })
			.reply(200, {
				data: [{ id: 'filter-2', attributes: { name: 'Internal' } }],
				meta: { total: 2 },
			});

		const filters = await fetchAllSavedFilters('api', 'app', {
			include_rules: true,
		});

		expect(filters).toEqual([
			{
				id: 'filter-1',
				name: 'Beta users',
				migration_metadata: undefined,
				creation_type: 'LIST',
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'id', value: ['user-a'] },
						],
					},
				],
			},
			{ id: 'filter-2', name: 'Internal', migration_metadata: undefined },
		]);
	});

	it('fetches a single saved filter', async () => {
		mock
			.onGet(
				'https://api.datadoghq.com/api/v2/feature-flags/saved-filters/filter-1',
			)
			.reply(200, {
				data: {
					id: 'filter-1',
					attributes: { name: 'Beta users', creation_type: 'RULES' },
				},
			});

		await expect(fetchSavedFilter('api', 'app', 'filter-1')).resolves.toEqual({
			id: 'filter-1',
			name: 'Beta users',
			migration_metadata: undefined,
			creation_type: 'RULES',
		});
	});
});
