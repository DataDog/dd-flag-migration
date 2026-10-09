import fs from 'node:fs';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../src/datadog/api.js';
import { eppoClient } from '../src/eppo/api.js';
import { runEppoMigration } from '../src/eppo/migrate.js';
import { ldClient } from '../src/launchdarkly/api.js';
import { runLaunchDarklyMigration } from '../src/launchdarkly/migrate.js';

describe('non-interactive tag modes', () => {
	afterEach(() => {
		jest.restoreAllMocks();
		process.exitCode = undefined;
	});

	it.each(
		['launchdarkly', 'eppo'].flatMap((provider) =>
			[true, false].flatMap((active) =>
				[true, false].flatMap((dryRun) =>
					[[], ['source:added', 'shared']].flatMap((sourceTags) =>
						([undefined, 'additive', 'replace'] as const).map((tagMode) => ({
							provider,
							active,
							dryRun,
							sourceTags,
							tagMode,
						})),
					),
				),
			),
		),
	)('applies the selected tag mode: %j', async ({
		provider,
		active,
		dryRun,
		sourceTags,
		tagMode,
	}) => {
		const dd = new AxiosMockAdapter(ddClient as never);
		const ld = new AxiosMockAdapter(ldClient as never);
		const eppo = new AxiosMockAdapter(eppoClient as never);
		const oldLD = process.env.LAUNCHDARKLY_API_KEY;
		const oldEppo = process.env.EPPO_API_KEY;
		process.env.LAUNCHDARKLY_API_KEY = 'test';
		process.env.EPPO_API_KEY = 'test';
		const output: string[] = [];
		jest.spyOn(process.stdout, 'write').mockImplementation(((
			chunk: unknown,
		) => {
			output.push(String(chunk));
			return true;
		}) as never);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
		const base = 'https://api.test.invalid';
		const existingTags = ['dd-only', 'team:existing-team', 'shared'];
		try {
			dd.onGet(`${base}/api/v2/feature-flags`).reply(200, {
				data: [
					{
						id: 'flag-id',
						type: 'feature-flags',
						attributes: {
							key: 'flag',
							name: 'Flag',
							tags: ['stale-list-tag'],
							migration_metadata: {
								project_key: 'project',
								flag_key: 'flag',
								provider: 'eppo',
								source_id: '1',
								source_key: 'flag',
							},
						},
					},
				],
				meta: { page: { total: 1 } },
			});
			dd.onGet(`${base}/api/v2/feature-flags/environments`).reply(200, {
				data: [
					{
						id: 'env-id',
						type: 'feature-flag-environments',
						attributes: {
							name: 'Production',
							is_production: false,
							queries: ['production'],
						},
					},
				],
			});
			dd.onGet(`${base}/api/v2/feature-flags/flag-id`).reply(200, {
				data: {
					id: 'flag-id',
					attributes: {
						name: 'Flag',
						tags: existingTags,
						variants: [
							{
								id: 'on-id',
								key: 'on',
								name: 'On',
								value: provider === 'eppo' ? 'on' : 'true',
								migration_metadata: { provider, source_id: '10' },
							},
							{
								id: 'off-id',
								key: 'off',
								name: 'Off',
								value: provider === 'eppo' ? 'off' : 'false',
								migration_metadata: { provider, source_id: '20' },
							},
						],
						feature_flag_environments: [],
					},
				},
			});
			dd.onPut().reply(200, {});
			dd.onPost().reply(200, {});
			dd.onDelete().reply(200, {});
			if (provider === 'launchdarkly') {
				const root = 'https://app.launchdarkly.com/api/v2';
				ld.onGet(`${root}/projects`).reply(200, {
					items: [{ key: 'project', name: 'Project' }],
					totalCount: 1,
				});
				ld.onGet(`${root}/projects/project`).reply(200, {
					environments: {
						items: [{ key: 'production', name: 'Production', archived: false }],
					},
				});
				ld.onGet(`${root}/roles`).reply(200, { items: [], totalCount: 0 });
				ld.onGet(`${root}/teams`).reply(200, { items: [], totalCount: 0 });
				ld.onGet(`${root}/flags/project/flag`).reply(200, {
					key: 'flag',
					name: 'Flag',
					kind: 'boolean',
					tags: sourceTags,
					archived: false,
					temporary: false,
					deprecated: false,
					variations: [
						{ _id: '10', name: 'On', value: true },
						{ _id: '20', name: 'Off', value: false },
					],
					defaults: { onVariation: 0, offVariation: 1 },
					environments: {
						production: {
							on: active,
							archived: false,
							targets: [],
							contextTargets: [],
							rules: [],
							prerequisites: [],
							fallthrough: { variation: 0 },
							offVariation: 1,
							_environmentName: 'Production',
						},
					},
				});
				await runLaunchDarklyMigration('test', 'test', 'test.invalid', dryRun, {
					distributionChannelMode: 'server',
					nonInteractive: {
						projectKey: 'project',
						envMap: [['production', 'Production']],
						flagKeys: ['flag'],
					},
					doExport: false,
					tagMode,
				});
			} else {
				eppo.onGet('https://eppo.cloud/api/v1/feature-flags').reply(200, [
					{
						id: 1,
						key: 'flag',
						name: 'Flag',
						variation_type: 'BOOLEAN',
						tag_names: sourceTags,
						variations: [
							{ id: 10, name: 'On', variant_key: 'on' },
							{ id: 20, name: 'Off', variant_key: 'off' },
						],
						environments: [
							{ id: 100, name: 'Production', active, is_production: false },
						],
						allocations: [],
					},
				]);
				eppo.onGet('https://eppo.cloud/api/v1/audiences').reply(200, []);
				await runEppoMigration('test', 'test', 'test.invalid', dryRun, {
					nonInteractive: {
						envMap: [['Production', 'Production']],
						flagKeys: ['flag'],
					},
					doExport: false,
					tagMode,
				});
			}
			const report = JSON.parse(
				[...output]
					.reverse()
					.find(
						(s) => s.trimStart().startsWith('{') && s.includes('"summary"'),
					) ?? '{}',
			);
			expect(report.summary).toMatchObject({ synced: 1, errored: 0 });
			const attrs = dryRun
				? report.requests
						.filter(
							(r: { path: string }) =>
								r.path === '/api/v2/feature-flags/flag-id',
						)
						.map(
							(r: {
								body: { data: { attributes: Record<string, unknown> } };
							}) => r.body.data.attributes,
						)
				: dd.history.put
						.filter((r) => r.url === `${base}/api/v2/feature-flags/flag-id`)
						.map((r) => JSON.parse(r.data).data.attributes);
			const tags = attrs.find((a: Record<string, unknown>) =>
				Array.isArray(a.tags),
			)?.tags;
			expect(tags).toEqual([
				...new Set([
					...(tagMode === 'replace' ? [] : existingTags),
					...sourceTags,
					...(provider === 'launchdarkly' ? ['project:project'] : []),
				]),
			]);
			if (provider === 'launchdarkly') {
				expect(attrs).toContainEqual(
					expect.objectContaining({ distribution_channel: 'SERVER' }),
				);
			}
			if (dryRun) {
				expect(dd.history.put).toHaveLength(0);
				expect(dd.history.post).toHaveLength(0);
			}
		} finally {
			dd.restore();
			ld.restore();
			eppo.restore();
			if (oldLD === undefined) delete process.env.LAUNCHDARKLY_API_KEY;
			else process.env.LAUNCHDARKLY_API_KEY = oldLD;
			if (oldEppo === undefined) delete process.env.EPPO_API_KEY;
			else process.env.EPPO_API_KEY = oldEppo;
		}
	});
});
