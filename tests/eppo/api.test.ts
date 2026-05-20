/**
 * Tests for Eppo API: fetching flags, extracting environments,
 * and validating API keys.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	createEppoClient,
	eppoClient,
	extractEnvironments,
	fetchEppoFlags,
	validateEppoApiKey,
} from '../../src/eppo/api.js';
import type { EppoFlag } from '../../src/eppo/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── extractEnvironments ──────────────────────────────────────────────────────

describe('extractEnvironments', () => {
	it('returns empty array for no flags', () => {
		expect(extractEnvironments([])).toEqual([]);
	});

	it('returns empty array when flags have no environments', () => {
		const flags = [makeFlag({ id: 1, name: 'Flag A', key: 'flag-a' })];
		expect(extractEnvironments(flags)).toEqual([]);
	});

	it('collects environments from a single flag', () => {
		const flags = [
			makeFlag({
				id: 1,
				name: 'Flag A',
				key: 'flag-a',
				environments: [
					{ id: 10, name: 'production', active: true, is_production: true },
					{ id: 20, name: 'staging', active: true, is_production: false },
				],
			}),
		];
		const result = extractEnvironments(flags);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual([10, 20]);
	});

	it('deduplicates environments with the same id across flags', () => {
		const sharedEnv = {
			id: 10,
			name: 'production',
			active: true,
			is_production: true,
		};
		const flags = [
			makeFlag({
				id: 1,
				name: 'Flag A',
				key: 'flag-a',
				environments: [sharedEnv],
			}),
			makeFlag({
				id: 2,
				name: 'Flag B',
				key: 'flag-b',
				environments: [sharedEnv],
			}),
		];
		const result = extractEnvironments(flags);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(10);
	});

	it('sorts production environments before non-production', () => {
		const flags = [
			makeFlag({
				id: 1,
				name: 'Flag A',
				key: 'flag-a',
				environments: [
					{ id: 20, name: 'staging', active: true, is_production: false },
					{ id: 10, name: 'production', active: true, is_production: true },
				],
			}),
		];
		const result = extractEnvironments(flags);
		expect(result[0].name).toBe('production');
		expect(result[1].name).toBe('staging');
	});

	it('sorts alphabetically within the same production status', () => {
		const flags = [
			makeFlag({
				id: 1,
				name: 'Flag A',
				key: 'flag-a',
				environments: [
					{ id: 30, name: 'gamma', active: true, is_production: false },
					{ id: 10, name: 'alpha', active: true, is_production: false },
					{ id: 20, name: 'beta', active: true, is_production: false },
				],
			}),
		];
		const result = extractEnvironments(flags);
		expect(result.map((e) => e.name)).toEqual(['alpha', 'beta', 'gamma']);
	});

	it('merges environments across multiple flags, deduplicating and sorting', () => {
		const flags = [
			makeFlag({
				id: 1,
				name: 'Flag A',
				key: 'flag-a',
				environments: [
					{ id: 10, name: 'prod', active: true, is_production: true },
					{ id: 20, name: 'beta', active: false, is_production: false },
				],
			}),
			makeFlag({
				id: 2,
				name: 'Flag B',
				key: 'flag-b',
				environments: [
					{ id: 10, name: 'prod', active: true, is_production: true },
					{ id: 30, name: 'alpha', active: true, is_production: false },
				],
			}),
		];
		const result = extractEnvironments(flags);
		expect(result).toHaveLength(3);
		expect(result[0].name).toBe('prod'); // production first
		expect(result[1].name).toBe('alpha'); // then alphabetical
		expect(result[2].name).toBe('beta');
	});
});

// ─── fetchEppoFlags ───────────────────────────────────────────────────────────

describe('fetchEppoFlags', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(eppoClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns flags from a single-page array response (page shorter than pageSize)', async () => {
		const flags = [makeFlag({ id: 1, name: 'Flag A', key: 'flag-a' })];
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply(200, flags);

		const result = await fetchEppoFlags('test-api-key', { pageSize: 100 });
		expect(result).toEqual(flags);
	});

	it('returns flags from a paginated {data, total} response', async () => {
		const flags = [makeFlag({ id: 1, name: 'Flag A', key: 'flag-a' })];
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.reply(200, { data: flags, total: 1 });

		const result = await fetchEppoFlags('test-api-key', { pageSize: 100 });
		expect(result).toEqual(flags);
	});

	it('returns empty array for unexpected response shape', async () => {
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.reply(200, { unexpected: true });

		const result = await fetchEppoFlags('test-api-key', { pageSize: 100 });
		expect(result).toEqual([]);
	});

	it('sends the API key in the x-eppo-token header', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply((config) => {
			expect(config.headers?.['x-eppo-token']).toBe('my-key');
			return [200, []];
		});

		await fetchEppoFlags('my-key', { pageSize: 100 });
	});

	it('throws on HTTP error', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply(401);
		await expect(
			fetchEppoFlags('bad-key', { pageSize: 100 }),
		).rejects.toThrow();
	});

	it('requests detailed allocations with offset/limit pagination params', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply((config) => {
			expect(config.params?.offset).toBe(0);
			expect(config.params?.limit).toBe(100);
			expect(config.params?.include_detailed_allocations).toBe(true);
			return [200, []];
		});

		await fetchEppoFlags('test-key', { pageSize: 100 });
	});

	it('pages through results, advancing offset by pageSize', async () => {
		const page1 = [
			makeFlag({ id: 1, name: 'Flag 1', key: 'flag-1' }),
			makeFlag({ id: 2, name: 'Flag 2', key: 'flag-2' }),
		];
		const page2 = [
			makeFlag({ id: 3, name: 'Flag 3', key: 'flag-3' }),
			makeFlag({ id: 4, name: 'Flag 4', key: 'flag-4' }),
		];
		const page3 = [makeFlag({ id: 5, name: 'Flag 5', key: 'flag-5' })];

		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply((config) => {
			const offset = Number(config.params?.offset);
			if (offset === 0) return [200, page1];
			if (offset === 2) return [200, page2];
			if (offset === 4) return [200, page3];
			return [200, []];
		});

		const result = await fetchEppoFlags('k', { pageSize: 2 });
		expect(result.map((f) => f.key)).toEqual([
			'flag-1',
			'flag-2',
			'flag-3',
			'flag-4',
			'flag-5',
		]);
	});

	it('detects end-of-pagination at exact pageSize boundary without infinite loop', async () => {
		// All pages return exactly pageSize until offset reaches end-of-data,
		// at which point the server returns an empty page.
		const flagsAt = (start: number, count: number) =>
			Array.from({ length: count }, (_, i) =>
				makeFlag({
					id: start + i,
					name: `Flag ${start + i}`,
					key: `flag-${start + i}`,
				}),
			);

		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply((config) => {
			const offset = Number(config.params?.offset);
			if (offset === 0) return [200, flagsAt(0, 2)];
			if (offset === 2) return [200, flagsAt(2, 2)];
			if (offset === 4) return [200, []]; // boundary
			throw new Error(`unexpected offset ${offset}`);
		});

		const result = await fetchEppoFlags('k', { pageSize: 2 });
		expect(result).toHaveLength(4);
	});

	it('invokes onProgress with running total after each page', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply((config) => {
			const offset = Number(config.params?.offset);
			if (offset === 0)
				return [
					200,
					[
						makeFlag({ id: 1, name: 'A', key: 'a' }),
						makeFlag({ id: 2, name: 'B', key: 'b' }),
					],
				];
			if (offset === 2)
				return [200, [makeFlag({ id: 3, name: 'C', key: 'c' })]];
			return [200, []];
		});

		const progress: number[] = [];
		await fetchEppoFlags('k', {
			pageSize: 2,
			onProgress: (n) => progress.push(n),
		});
		expect(progress).toEqual([2, 3]);
	});
});

// ─── 429 Retry ───────────────────────────────────────────────────────────────

describe('Eppo client 429 handling', () => {
	let client: ReturnType<typeof createEppoClient>;
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		client = createEppoClient();
		mock = new AxiosMockAdapter(client as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('retries on 429 and eventually succeeds', async () => {
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.replyOnce(
				429,
				'Too many requests. Rate limit is 200 requests per 1 second(s).',
			)
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.replyOnce(200, []);

		const response = await client.get(
			'https://eppo.cloud/api/v1/feature-flags',
		);
		expect(response.status).toBe(200);
	}, 10000);

	it('throws after exhausting retries on 429', async () => {
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.reply(
				429,
				'Too many requests. Rate limit is 200 requests per 1 second(s).',
			);

		await expect(
			client.get('https://eppo.cloud/api/v1/feature-flags'),
		).rejects.toThrow(/rate-limited after \d+ retries/i);
	}, 120000);

	it('retries even when the 429 body cannot be parsed', async () => {
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.replyOnce(429, 'something else entirely')
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.replyOnce(200, []);

		const response = await client.get(
			'https://eppo.cloud/api/v1/feature-flags',
		);
		expect(response.status).toBe(200);
	}, 10000);
});

// ─── validateEppoApiKey ──────────────────────────────────────────────────────

describe('validateEppoApiKey', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(eppoClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns true for valid API key', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply(200, []);

		expect(await validateEppoApiKey('valid-key')).toBe(true);
	});

	it('returns false for invalid API key', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply(401);

		expect(await validateEppoApiKey('bad-key')).toBe(false);
	});
});
