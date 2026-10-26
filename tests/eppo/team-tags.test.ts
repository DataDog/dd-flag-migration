/**
 * Eppo team tags: new flags get a `team:<handle>` tag for each owning Eppo
 * team matched to a Datadog team. Unmatched teams and failed team lookups
 * produce no team tags.
 */
import fs from 'node:fs';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../../src/datadog/api.js';
import { eppoClient } from '../../src/eppo/api.js';
import { runEppoMigration } from '../../src/eppo/migrate.js';

const DD_SITE = 'test.invalid';
const DD_BASE = `https://api.${DD_SITE}`;
const EPPO_BASE = 'https://eppo.cloud';

const eppoFlag = {
	id: 1,
	key: 'flag',
	name: 'Flag',
	variation_type: 'BOOLEAN',
	tag_names: ['source:tag'],
	variations: [
		{ id: 10, name: 'On', variant_key: 'on' },
		{ id: 20, name: 'Off', variant_key: 'off' },
	],
	environments: [
		{ id: 100, name: 'Production', active: true, is_production: true },
	],
	allocations: [
		{
			id: 1000,
			key: 'default-allocation',
			name: 'Default',
			environment_id: 100,
			type: 'FEATURE_GATE',
			enabled: true,
			percent_exposure: 1,
			is_default: true,
			variation_weight: [{ id: 5000, variation_id: 20, weight: 100 }],
			targeting_rules: [],
		},
	],
};

const eppoTeams = [
	{ id: 1, name: 'Team A', feature_flags: [1], archived_at: null },
	{ id: 2, name: 'Unmatched Team', feature_flags: [1], archived_at: null },
	{ id: 3, name: 'Other Team', feature_flags: [2], archived_at: null },
];

describe('Eppo team tags on new flags', () => {
	let ddMock: AxiosMockAdapter;
	let eppoMock: AxiosMockAdapter;
	let stdoutWrites: string[];

	beforeEach(() => {
		ddMock = new AxiosMockAdapter(ddClient as never);
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		stdoutWrites = [];
		process.exitCode = undefined;
		process.env.EPPO_API_KEY = 'eppo-api-key';
		jest.spyOn(process.stdout, 'write').mockImplementation(((
			chunk: unknown,
		) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as never);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

		eppoMock.onGet(`${EPPO_BASE}/api/v1/feature-flags`).reply(200, [eppoFlag]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [],
			meta: { page: { total: 0 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [
				{
					id: 'dd-prod',
					type: 'feature-flag-environments',
					attributes: {
						name: 'Production',
						is_production: true,
						queries: ['production'],
					},
				},
			],
		});
		// Setting an environment default after creation fetches variant UUIDs.
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {
			data: {
				id: 'dd-flag-1',
				attributes: {
					variants: [
						{ id: 'on-id', key: 'on', name: 'On', value: 'on' },
						{ id: 'off-id', key: 'off', name: 'Off', value: 'off' },
					],
				},
			},
		});
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags`)
			.reply(201, { data: { id: 'dd-flag-1', attributes: { key: 'flag' } } });
		ddMock.onPost(/.*/).reply(200, {});
		ddMock.onPut(/.*/).reply(200, {});
	});

	afterEach(() => {
		ddMock.restore();
		eppoMock.restore();
		jest.restoreAllMocks();
		process.exitCode = undefined;
		delete process.env.EPPO_API_KEY;
	});

	async function createdTags(dryRun: boolean): Promise<unknown> {
		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, dryRun, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['flag'],
			},
		});
		const report = JSON.parse(
			[...stdoutWrites]
				.reverse()
				.find(
					(s) => s.trimStart().startsWith('{') && s.includes('"summary"'),
				) ?? '{}',
		);
		expect(report.summary).toMatchObject({ created: 1, errored: 0 });
		const body = dryRun
			? report.requests.find(
					(r: { method: string; path: string }) =>
						r.method === 'POST' && r.path === '/api/v2/feature-flags',
				)?.body
			: JSON.parse(
					ddMock.history.post.find(
						(r) => r.url === `${DD_BASE}/api/v2/feature-flags`,
					)?.data ?? '{}',
				);
		return body?.data?.attributes?.tags;
	}

	it.each([
		true,
		false,
	])('tags matched owning teams (dry run: %s)', async (dryRun) => {
		eppoMock.onGet(`${EPPO_BASE}/api/v1/teams`).reply(200, eppoTeams);
		ddMock.onGet(`${DD_BASE}/api/v2/team`).reply(200, {
			data: [
				{ id: 'team-a-id', attributes: { handle: 'team-a', name: 'Team A' } },
				{
					id: 'other-id',
					attributes: { handle: 'other-team', name: 'Other Team' },
				},
			],
		});

		await expect(createdTags(dryRun)).resolves.toEqual([
			'source:tag',
			'team:team-a',
		]);
	});

	it('creates the flag without team tags when Eppo teams cannot be fetched', async () => {
		eppoMock.onGet(`${EPPO_BASE}/api/v1/teams`).reply(403, {});

		await expect(createdTags(false)).resolves.toEqual(['source:tag']);
	});

	it('creates the flag without team tags when Datadog teams cannot be fetched', async () => {
		eppoMock.onGet(`${EPPO_BASE}/api/v1/teams`).reply(200, eppoTeams);
		ddMock.onGet(`${DD_BASE}/api/v2/team`).reply(403, {});

		await expect(createdTags(false)).resolves.toEqual(['source:tag']);
	});
});
