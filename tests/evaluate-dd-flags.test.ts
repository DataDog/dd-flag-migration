import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../src/datadog.js';
import { fetchDDFlagData } from '../src/evaluate/dd-flags.js';

const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const SITE = 'test.invalid';
const BASE = `https://api.${SITE}`;
const ENV_ID = 'env-abc';

describe('fetchDDFlagData', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('collects keys, env status, value types, and migration metadata', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					attributes: {
						key: 'flag-a',
						value_type: 'boolean',
						feature_flag_environments: [
							{ environment_id: ENV_ID, status: 'ENABLED' },
							{ environment_id: 'other-env', status: 'DISABLED' },
						],
						migration_metadata: {
							provider: 'eppo',
							source_key: 'src-a',
						},
					},
				},
				{
					attributes: {
						key: 'flag-b',
						feature_flag_environments: [
							{ environment_id: ENV_ID, status: 'DISABLED' },
						],
					},
				},
			],
		});

		const result = await fetchDDFlagData(API_KEY, APP_KEY, SITE, ENV_ID);
		expect(result.keys).toEqual(new Set(['flag-a', 'flag-b']));
		expect(result.enabledByKey.get('flag-a')).toBe(true);
		expect(result.enabledByKey.get('flag-b')).toBe(false);
		expect(result.valueTypeByKey.get('flag-a')).toBe('boolean');
		expect(result.valueTypeByKey.has('flag-b')).toBe(false);
		expect(result.migrationMetadataByKey.get('flag-a')).toEqual({
			provider: 'eppo',
			source_key: 'src-a',
		});
	});

	it('paginates using next_offset metadata', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit }, (_, i) => ({
			attributes: { key: `flag-${i}` },
		}));
		const page2 = [{ attributes: { key: 'flag-50' } }];

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

		const result = await fetchDDFlagData(API_KEY, APP_KEY, SITE, ENV_ID);
		expect(result.keys.size).toBe(51);
		expect(result.keys.has('flag-50')).toBe(true);
	});

	it('falls back to total_count when next_offset is absent', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit }, (_, i) => ({
			attributes: { key: `flag-${i}` },
		}));
		const page2 = [{ attributes: { key: 'flag-50' } }];

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

		const result = await fetchDDFlagData(API_KEY, APP_KEY, SITE, ENV_ID);
		expect(result.keys.size).toBe(51);
		expect(result.keys.has('flag-50')).toBe(true);
	});

	it('stops when a short page is returned without next_offset or total', async () => {
		const limit = 50;
		const page1 = Array.from({ length: limit - 1 }, (_, i) => ({
			attributes: { key: `flag-${i}` },
		}));

		mock
			.onGet(`${BASE}/api/v2/feature-flags`, {
				params: { limit, offset: 0, is_archived: false },
			})
			.reply(200, { data: page1 });

		const result = await fetchDDFlagData(API_KEY, APP_KEY, SITE, ENV_ID);
		expect(result.keys.size).toBe(limit - 1);
	});

	it('translates 403 responses into a helpful error', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(403, {});
		await expect(
			fetchDDFlagData(API_KEY, APP_KEY, SITE, ENV_ID),
		).rejects.toThrow(/403 Forbidden/);
	});

	it('translates 401 responses into a helpful error', async () => {
		mock.onGet(`${BASE}/api/v2/feature-flags`).reply(401, {});
		await expect(
			fetchDDFlagData(API_KEY, APP_KEY, SITE, ENV_ID),
		).rejects.toThrow(/401 Unauthorized/);
	});
});
