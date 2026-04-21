/**
 * Tests for LaunchDarkly API: fetching projects, flags, individual flags,
 * and project environments from the LD API.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	buildMemberTeamCache,
	createLDClient,
	ForbiddenError,
	fetchFlag,
	fetchFlags,
	fetchMember,
	fetchProjectEnvironments,
	fetchProjects,
	ldClient,
	validateLDApiKey,
} from '../../src/launchdarkly/api.js';
import type { LDFlag } from '../../src/launchdarkly/types.js';

const API_KEY = 'api-test-key';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const booleanFlagSummary: LDFlag = {
	name: 'Kill Switch',
	kind: 'boolean',
	key: 'kill-switch',
	variations: [
		{ _id: 'v0', value: true, name: 'on' },
		{ _id: 'v1', value: false, name: 'off' },
	],
	defaults: { onVariation: 0, offVariation: 1 },
	tags: [],
	archived: false,
	deprecated: false,
	temporary: false,
};

const booleanFlagFull: LDFlag = {
	...booleanFlagSummary,
	environments: {
		dev: {
			on: true,
			archived: false,
			targets: [],
			contextTargets: [],
			rules: [],
			fallthrough: { variation: 0 },
			offVariation: 1,
			prerequisites: [],
			_environmentName: 'Development',
		},
		production: {
			on: false,
			archived: false,
			targets: [],
			contextTargets: [],
			rules: [],
			fallthrough: { variation: 1 },
			offVariation: 1,
			prerequisites: [],
			_environmentName: 'Production',
		},
	},
};

const multivariateFlagSummary: LDFlag = {
	name: 'Theme Selector',
	kind: 'multivariate',
	key: 'theme-selector',
	variations: [
		{ _id: 'v0', value: 'light', name: 'Light' },
		{ _id: 'v1', value: 'dark', name: 'Dark' },
	],
	defaults: { onVariation: 0, offVariation: 0 },
	tags: ['ui'],
	archived: false,
	deprecated: false,
	temporary: false,
};

// ─── fetchProjects ───────────────────────────────────────────────────────────

describe('fetchProjects', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns projects sorted by name', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/projects').reply(200, {
			items: [
				{ key: 'z-project', name: 'Zebra Project' },
				{ key: 'a-project', name: 'Alpha Project' },
			],
			totalCount: 2,
		});

		const projects = await fetchProjects(API_KEY);
		expect(projects).toEqual([
			{ key: 'a-project', name: 'Alpha Project' },
			{ key: 'z-project', name: 'Zebra Project' },
		]);
	});

	it('paginates through multiple pages', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.replyOnce(200, {
				items: Array.from({ length: 20 }, (_, i) => ({
					key: `proj-${i}`,
					name: `Project ${i}`,
				})),
				totalCount: 25,
			})
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.replyOnce(200, {
				items: Array.from({ length: 5 }, (_, i) => ({
					key: `proj-${20 + i}`,
					name: `Project ${20 + i}`,
				})),
				totalCount: 25,
			});

		const projects = await fetchProjects(API_KEY);
		expect(projects).toHaveLength(25);
	});

	it('returns empty array when no projects exist', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.reply(200, { items: [], totalCount: 0 });

		const projects = await fetchProjects(API_KEY);
		expect(projects).toEqual([]);
	});
});

// ─── fetchProjectEnvironments ────────────────────────────────────────────────

describe('fetchProjectEnvironments', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns environments sorted by name', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects/my-project')
			.reply(200, {
				environments: [
					{ key: 'production', name: 'Production', color: 'ff0000' },
					{ key: 'dev', name: 'Development', color: '00ff00' },
				],
			});

		const envs = await fetchProjectEnvironments(API_KEY, 'my-project');
		expect(envs).toEqual([
			{ key: 'dev', name: 'Development', color: '00ff00', archived: false },
			{
				key: 'production',
				name: 'Production',
				color: 'ff0000',
				archived: false,
			},
		]);
	});

	it('returns empty array when no environments exist', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects/empty-project')
			.reply(200, { environments: [] });

		const envs = await fetchProjectEnvironments(API_KEY, 'empty-project');
		expect(envs).toEqual([]);
	});
});

// ─── fetchFlags ──────────────────────────────────────────────────────────────

describe('fetchFlags', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns flag summaries (without environments)', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/flags/my-project')
			.reply(200, {
				items: [booleanFlagSummary, multivariateFlagSummary],
				totalCount: 2,
			});

		const flags = await fetchFlags(API_KEY, 'my-project');
		expect(flags).toHaveLength(2);
		expect(flags.map((f) => f.key)).toEqual(['kill-switch', 'theme-selector']);
		// Summary flags should not have environments
		expect(flags[0].environments).toBeUndefined();
	});

	it('paginates through multiple pages of flags', async () => {
		const makeFlags = (start: number, count: number) =>
			Array.from({ length: count }, (_, i) => ({
				...booleanFlagSummary,
				key: `flag-${start + i}`,
				name: `Flag ${start + i}`,
			}));

		mock
			.onGet('https://app.launchdarkly.com/api/v2/flags/big-project')
			.replyOnce(200, { items: makeFlags(0, 20), totalCount: 30 })
			.onGet('https://app.launchdarkly.com/api/v2/flags/big-project')
			.replyOnce(200, { items: makeFlags(20, 10), totalCount: 30 });

		const flags = await fetchFlags(API_KEY, 'big-project');
		expect(flags).toHaveLength(30);
	});

	it('returns empty array when project has no flags', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/flags/empty-project')
			.reply(200, { items: [], totalCount: 0 });

		const flags = await fetchFlags(API_KEY, 'empty-project');
		expect(flags).toEqual([]);
	});
});

// ─── fetchFlag ───────────────────────────────────────────────────────────────

describe('fetchFlag', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns a single flag with full environment configs', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/flags/my-project/kill-switch')
			.reply(200, booleanFlagFull);

		const flag = await fetchFlag(API_KEY, 'my-project', 'kill-switch');
		expect(flag.key).toBe('kill-switch');
		expect(flag.environments).toBeDefined();
		expect(Object.keys(flag.environments ?? {})).toEqual(['dev', 'production']);
	});
});

// ─── validateLDApiKey ────────────────────────────────────────────────────────

describe('validateLDApiKey', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns true for valid API key', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.reply(200, { items: [], totalCount: 0 });

		expect(await validateLDApiKey('valid-key')).toBe(true);
	});

	it('returns false for invalid API key', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.reply(401, { message: 'Unauthorized' });

		expect(await validateLDApiKey('bad-key')).toBe(false);
	});
});

// ─── Rate Limiting ──────────────────────────────────────────────────────────

describe('rate limiting', () => {
	let client: ReturnType<typeof createLDClient>;
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		client = createLDClient();
		mock = new AxiosMockAdapter(client as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('retries on 429 and succeeds', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.replyOnce(429, { message: 'Rate limited' }, { 'retry-after': '0.01' })
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.replyOnce(200, { items: [], totalCount: 0 });

		const response = await client.get(
			'https://app.launchdarkly.com/api/v2/projects',
		);
		expect(response.status).toBe(200);
	});

	it('pauses when global rate limit is nearly exhausted', async () => {
		const resetTime = Date.now() + 100; // 100ms from now
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.replyOnce(
				200,
				{ items: [], totalCount: 0 },
				{
					'x-ratelimit-global-remaining': '10',
					'x-ratelimit-global-reset': String(resetTime),
				},
			)
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.replyOnce(200, { items: [], totalCount: 0 });

		const start = Date.now();
		await client.get('https://app.launchdarkly.com/api/v2/projects');
		// Should have paused before returning; allow some slack for timing
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(50);

		// Second request should succeed normally (no throttle headers)
		const response = await client.get(
			'https://app.launchdarkly.com/api/v2/projects',
		);
		expect(response.status).toBe(200);
	});

	it('throws after exhausting retries on 429', async () => {
		// 4 replies: initial + 3 retries = all 429s, then should throw
		mock
			.onGet('https://app.launchdarkly.com/api/v2/projects')
			.reply(429, { message: 'Rate limited' }, { 'retry-after': '0.01' });

		await expect(
			client.get('https://app.launchdarkly.com/api/v2/projects'),
		).rejects.toThrow();
	}, 30000);
});

// ─── fetchMember ─────────────────────────────────────────────────────────────

describe('fetchMember', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns member with teams', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/member-1')
			.reply(200, {
				_id: 'member-1',
				email: 'alice@example.com',
				teams: {
					items: [
						{ key: 'platform', name: 'Platform' },
						{ key: 'frontend', name: 'Frontend' },
					],
				},
			});

		const member = await fetchMember(API_KEY, 'member-1');
		expect(member).toEqual({
			_id: 'member-1',
			email: 'alice@example.com',
			teams: {
				items: [
					{ key: 'platform', name: 'Platform' },
					{ key: 'frontend', name: 'Frontend' },
				],
			},
		});
	});

	it('returns member with no teams', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/member-2')
			.reply(200, {
				_id: 'member-2',
				email: 'bob@example.com',
				teams: { items: [] },
			});

		const member = await fetchMember(API_KEY, 'member-2');
		expect(member?.teams?.items).toEqual([]);
	});

	it('returns null on 404', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/deleted-member')
			.reply(404);

		const member = await fetchMember(API_KEY, 'deleted-member');
		expect(member).toBeNull();
	});

	it('throws ForbiddenError on 403', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/member-1')
			.reply(403);

		await expect(fetchMember(API_KEY, 'member-1')).rejects.toThrow(
			ForbiddenError,
		);
	});

	it('propagates other errors', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/member-1')
			.reply(500);

		await expect(fetchMember(API_KEY, 'member-1')).rejects.toThrow();
	});
});

// ─── buildMemberTeamCache ────────────────────────────────────────────────────

function makeFlagForCache(
	overrides: Partial<LDFlag> & { key: string },
): LDFlag {
	return {
		name: overrides.key,
		kind: 'boolean',
		variations: [
			{ _id: 'v0', value: true, name: 'true' },
			{ _id: 'v1', value: false, name: 'false' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
		...overrides,
	};
}

describe('buildMemberTeamCache', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns empty cache when no flags have individual maintainers', async () => {
		const flags = [
			makeFlagForCache({ key: 'f1', maintainerTeamKey: 'team-a' }),
		];
		const [cache, wasForbidden] = await buildMemberTeamCache(API_KEY, flags);
		expect(cache.size).toBe(0);
		expect(wasForbidden).toBe(false);
	});

	it('fetches team memberships for individual maintainers', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/members/m1').reply(200, {
			_id: 'm1',
			email: 'a@ex.com',
			teams: { items: [{ key: 'eng', name: 'Engineering' }] },
		});

		const flags = [makeFlagForCache({ key: 'f1', maintainerId: 'm1' })];
		const [cache, wasForbidden] = await buildMemberTeamCache(API_KEY, flags);
		expect(cache.get('m1')).toEqual(['eng']);
		expect(wasForbidden).toBe(false);
	});

	it('deduplicates member IDs across flags', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/m1')
			.replyOnce(200, {
				_id: 'm1',
				email: 'a@ex.com',
				teams: { items: [{ key: 'eng', name: 'Engineering' }] },
			});

		const flags = [
			makeFlagForCache({ key: 'f1', maintainerId: 'm1' }),
			makeFlagForCache({ key: 'f2', maintainerId: 'm1' }),
		];
		const [cache] = await buildMemberTeamCache(API_KEY, flags);
		expect(cache.get('m1')).toEqual(['eng']);
		// Only one API call was made (replyOnce would fail on a second call)
	});

	it('skips flags that already have maintainerTeamKey', async () => {
		const flags = [
			makeFlagForCache({
				key: 'f1',
				maintainerId: 'm1',
				maintainerTeamKey: 'team-a',
			}),
		];
		// No mock set up — if fetchMember were called it would throw
		const [cache, wasForbidden] = await buildMemberTeamCache(API_KEY, flags);
		expect(cache.size).toBe(0);
		expect(wasForbidden).toBe(false);
	});

	it('returns wasForbidden=true on 403 and empty cache', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/members/m1').reply(403);

		const flags = [makeFlagForCache({ key: 'f1', maintainerId: 'm1' })];
		const [cache, wasForbidden] = await buildMemberTeamCache(API_KEY, flags);
		expect(cache.size).toBe(0);
		expect(wasForbidden).toBe(true);
	});

	it('handles member with no teams field', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/members/m1')
			.reply(200, { _id: 'm1', email: 'a@ex.com' });

		const flags = [makeFlagForCache({ key: 'f1', maintainerId: 'm1' })];
		const [cache] = await buildMemberTeamCache(API_KEY, flags);
		expect(cache.get('m1')).toEqual([]);
	});

	it('returns empty cache for empty flags array', async () => {
		const [cache, wasForbidden] = await buildMemberTeamCache(API_KEY, []);
		expect(cache.size).toBe(0);
		expect(wasForbidden).toBe(false);
	});
});
