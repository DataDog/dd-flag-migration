import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { extractEnvironments, fetchEppoFlags } from '../src/eppo.js';
import type { EppoFlag } from '../src/types.js';

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
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns flags from an array response', async () => {
		const flags = [makeFlag({ id: 1, name: 'Flag A', key: 'flag-a' })];
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply(200, flags);

		const result = await fetchEppoFlags('test-api-key');
		expect(result).toEqual(flags);
	});

	it('returns flags from a paginated {data, total} response', async () => {
		const flags = [makeFlag({ id: 1, name: 'Flag A', key: 'flag-a' })];
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.reply(200, { data: flags, total: 1 });

		const result = await fetchEppoFlags('test-api-key');
		expect(result).toEqual(flags);
	});

	it('returns empty array for unexpected response shape', async () => {
		mock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.reply(200, { unexpected: true });

		const result = await fetchEppoFlags('test-api-key');
		expect(result).toEqual([]);
	});

	it('sends the API key in the x-eppo-token header', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply((config) => {
			expect(config.headers?.['x-eppo-token']).toBe('my-key');
			return [200, []];
		});

		await fetchEppoFlags('my-key');
	});

	it('throws on HTTP error', async () => {
		mock.onGet('https://eppo.cloud/api/v1/feature-flags').reply(401);
		await expect(fetchEppoFlags('bad-key')).rejects.toThrow();
	});
});
