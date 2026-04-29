/**
 * Tests for LaunchDarkly API: fetching projects, flags, individual flags,
 * and project environments from the LD API.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	createLDClient,
	fetchCustomRoles,
	fetchFlag,
	fetchFlags,
	fetchProjectEnvironments,
	fetchProjects,
	fetchTeamsWithRoles,
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

// ─── fetchCustomRoles ────────────────────────────────────────────────────────

describe('fetchCustomRoles', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns custom roles with policy statements', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/roles').reply(200, {
			items: [
				{
					key: 'editor',
					name: 'Editor',
					policy: [
						{
							effect: 'allow',
							actions: ['updateFlagVariations'],
							resources: ['proj/my-project:env/*:flag/*'],
						},
					],
				},
			],
		});

		const roles = await fetchCustomRoles(API_KEY);
		expect(roles).toEqual([
			{
				key: 'editor',
				name: 'Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		]);
	});

	it('paginates through multiple pages', async () => {
		const firstPage = Array.from({ length: 100 }, (_, i) => ({
			key: `role-${i}`,
			name: `Role ${i}`,
			policy: [],
		}));
		const secondPage = Array.from({ length: 25 }, (_, i) => ({
			key: `role-${100 + i}`,
			name: `Role ${100 + i}`,
			policy: [],
		}));

		mock
			.onGet('https://app.launchdarkly.com/api/v2/roles')
			.replyOnce((config) => {
				expect(config.params).toMatchObject({ limit: 100, offset: 0 });
				return [200, { items: firstPage, totalCount: 125 }];
			})
			.onGet('https://app.launchdarkly.com/api/v2/roles')
			.replyOnce((config) => {
				expect(config.params).toMatchObject({ limit: 100, offset: 100 });
				return [200, { items: secondPage, totalCount: 125 }];
			});

		const roles = await fetchCustomRoles(API_KEY);
		expect(roles).toHaveLength(125);
		expect(roles[0].key).toBe('role-0');
		expect(roles[124].key).toBe('role-124');
	});

	it('returns empty array on 403', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/roles').reply(403);

		const roles = await fetchCustomRoles(API_KEY);
		expect(roles).toEqual([]);
	});

	it('propagates non-403 errors', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/roles').reply(500);

		await expect(fetchCustomRoles(API_KEY)).rejects.toThrow();
	});
});

// ─── fetchTeamsWithRoles ─────────────────────────────────────────────────────

describe('fetchTeamsWithRoles', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns teams with their assigned roles', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/teams').reply(200, {
			items: [
				{
					key: 'platform',
					name: 'Platform',
					roles: { items: [{ key: 'editor' }] },
				},
			],
			totalCount: 1,
		});

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
		]);
	});

	it('paginates through multiple pages', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			key: `team-${i}`,
			name: `Team ${i}`,
			roles: { items: [{ key: 'editor' }] },
		}));
		const page2 = [
			{
				key: 'team-100',
				name: 'Team 100',
				roles: { items: [{ key: 'viewer' }] },
			},
		];

		mock
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, { items: page1, totalCount: 101 })
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, { items: page2, totalCount: 101 });

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toHaveLength(101);
	});

	it('retries with older API version when roles are missing', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [{ key: 'platform', name: 'Platform', roles: { items: [] } }],
				totalCount: 1,
			})
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [
					{
						key: 'platform',
						name: 'Platform',
						roles: { items: [{ key: 'editor' }] },
					},
				],
				totalCount: 1,
			});

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
		]);
	});

	it('returns empty array on 403', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/teams').reply(403);

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([]);
	});

	it('returns teams with empty roles when retry also has no roles', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [{ key: 'platform', name: 'Platform', roles: { items: [] } }],
				totalCount: 1,
			})
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [{ key: 'platform', name: 'Platform', roles: { items: [] } }],
				totalCount: 1,
			});

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([{ key: 'platform', name: 'Platform', roles: [] }]);
	});
});
