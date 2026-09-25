import fs from 'node:fs';
import path from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import ExcelJS from 'exceljs';
import { ddClient } from '../src/datadog/api.js';
import { eppoClient } from '../src/eppo/api.js';
import { runEppoMigration } from '../src/eppo/migrate.js';
import type { EppoFlag } from '../src/eppo/types.js';
import { ldClient } from '../src/launchdarkly/api.js';
import { runLaunchDarklyMigration } from '../src/launchdarkly/migrate.js';
import type { LDFlag } from '../src/launchdarkly/types.js';

const DD_SITE = 'test.invalid';
const DD_BASE = `https://api.${DD_SITE}`;
const EPPO_BASE = 'https://eppo.cloud';
const LD_BASE = 'https://app.launchdarkly.com';

function ddEnvironment(id: string, name: string, isProduction = false) {
	return {
		id,
		type: 'feature-flag-environments',
		attributes: {
			name,
			is_production: isProduction,
			queries: [name.toLowerCase()],
			require_feature_flag_approval: false,
		},
	};
}

function ddFlagDetail(variants: unknown[] = []) {
	return {
		data: {
			id: 'dd-flag-1',
			type: 'feature-flags',
			attributes: {
				variants,
				feature_flag_environments: [],
			},
		},
	};
}

function parseLastJsonOutput(writes: string[]): {
	success: boolean;
	summary: {
		created: number;
		synced: number;
		skipped: number;
		errored: number;
	};
	failures: Array<{ key: string; error: string }>;
	disableApprovalRequests?: Array<{ key: string; env: string }>;
	flagKeyMapping?: Array<{ sourceKey: string; datadogKey: string }>;
	requests?: Array<{
		method: string;
		path: string;
		body: { data?: { attributes?: Record<string, unknown> } };
	}>;
} {
	for (let i = writes.length - 1; i >= 0; i--) {
		const trimmed = writes[i].trimStart();
		if (trimmed.startsWith('{') && trimmed.includes('"summary"')) {
			return JSON.parse(writes[i]);
		}
	}
	throw new Error('No JSON output was written');
}

function flagUpdateAttributes(
	mock: AxiosMockAdapter,
	flagId: string,
): Array<Record<string, unknown>> {
	return mock.history.put
		.filter(
			(request) => request.url === `${DD_BASE}/api/v2/feature-flags/${flagId}`,
		)
		.map(
			(request) =>
				(
					JSON.parse(request.data as string) as {
						data: { attributes: Record<string, unknown> };
					}
				).data.attributes,
		);
}

function eppoFlag(): EppoFlag {
	return {
		id: 1,
		key: 'flag-with-bad-variant',
		name: 'Flag With Bad Variant',
		variation_type: 'BOOLEAN',
		tag_names: [],
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: false, is_production: true },
		],
		allocations: [],
	};
}

function ldFlag(): LDFlag {
	return {
		name: 'Flag With Bad Variant',
		kind: 'boolean',
		key: 'flag-with-bad-variant',
		variations: [
			{ _id: 'var-on', value: true, name: 'On' },
			{ _id: 'var-off', value: false, name: 'Off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
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
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};
}

describe('flag-level migration failures', () => {
	let ddMock: AxiosMockAdapter;
	let eppoMock: AxiosMockAdapter;
	let ldMock: AxiosMockAdapter;
	let stdoutWrites: string[];

	beforeEach(() => {
		ddMock = new AxiosMockAdapter(ddClient as never);
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		ldMock = new AxiosMockAdapter(ldClient as never);
		stdoutWrites = [];
		process.exitCode = undefined;
		process.env.EPPO_API_KEY = 'eppo-api-key';
		process.env.LAUNCHDARKLY_API_KEY = 'ld-api-key';

		jest.spyOn(process.stdout, 'write').mockImplementation(((
			chunk: unknown,
		) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as never);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
	});

	afterEach(() => {
		ddMock.restore();
		eppoMock.restore();
		ldMock.restore();
		jest.restoreAllMocks();
		process.exitCode = undefined;
		delete process.env.EPPO_API_KEY;
		delete process.env.LAUNCHDARKLY_API_KEY;
	});

	function mockDatadogForEppoExistingFlag(): void {
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: 'flag-with-bad-variant',
						name: 'Flag With Bad Variant',
						migration_metadata: {
							provider: 'eppo',
							source_id: '1',
							source_key: 'flag-with-bad-variant',
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
	}

	function mockEppoSourceData(): void {
		eppoMock
			.onGet(`${EPPO_BASE}/api/v1/feature-flags`)
			.reply(200, [eppoFlag()]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
	}

	function mockLaunchDarklySource(flag: LDFlag): void {
		ldMock.onGet(`${LD_BASE}/api/v2/projects`).reply(200, {
			items: [{ key: 'proj', name: 'Project' }],
			totalCount: 1,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/flags/proj/${flag.key}`).reply(200, flag);
		ldMock.onGet(`${LD_BASE}/api/v2/projects/proj`).reply(200, {
			environments: {
				items: [
					{
						key: 'production',
						name: 'Production',
						color: '417505',
						archived: false,
					},
				],
			},
		});
		ldMock.onGet(`${LD_BASE}/api/v2/roles`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/teams`).reply(200, {
			items: [],
			totalCount: 0,
		});
	}

	function mockLaunchDarklyNewFlag(flag: LDFlag): void {
		mockLaunchDarklySource(flag);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [],
			meta: { page: { total: 0 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
		ddMock.onPost(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: {
				id: 'created-flag',
				type: 'feature-flags',
				attributes: { key: flag.key },
			},
		});
	}

	async function createLaunchDarklyFlag(
		flag: LDFlag,
		distributionChannelMode: 'auto' | 'client' | 'server' | 'all',
	): Promise<Record<string, unknown>> {
		mockLaunchDarklyNewFlag(flag);
		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
			distributionChannelMode,
		});

		const createRequest = ddMock.history.post.find(
			(request) => request.url === `${DD_BASE}/api/v2/feature-flags`,
		);
		expect(createRequest).toBeDefined();
		const body = JSON.parse(createRequest?.data as string) as {
			data: { attributes: Record<string, unknown> };
		};
		return body.data.attributes;
	}

	it('omits the distribution channel for a new non-semver flag in Auto mode', async () => {
		const attributes = await createLaunchDarklyFlag(ldFlag(), 'auto');
		expect(attributes.distribution_channel).toBeUndefined();
	});

	it('sets CLIENT for a new semver flag in Auto mode', async () => {
		const flag = ldFlag();
		const environment = flag.environments?.production;
		if (!environment) throw new Error('Test flag is missing production');
		environment.rules = [
			{
				_id: 'semver-rule',
				variation: 0,
				clauses: [
					{
						_id: 'semver-clause',
						attribute: 'version',
						op: 'semVerGreaterThan',
						values: ['1.0.0'],
						contextKind: 'user',
						negate: false,
					},
				],
				trackEvents: false,
			},
		];

		const attributes = await createLaunchDarklyFlag(flag, 'auto');
		expect(attributes.distribution_channel).toBe('CLIENT');
	});

	it.each([
		['client', 'CLIENT'],
		['server', 'SERVER'],
		['all', 'BOTH'],
	] as const)('sets %s explicitly for a new non-semver flag', async (mode, expected) => {
		const attributes = await createLaunchDarklyFlag(ldFlag(), mode);
		expect(attributes.distribution_channel).toBe(expected);
	});

	it('records a LaunchDarkly disable approval request without counting the environment as disabled', async () => {
		const flag = ldFlag();
		mockLaunchDarklySource(flag);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: flag.key,
						name: flag.name,
						migration_metadata: {
							project_key: 'proj',
							flag_key: flag.key,
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
		ddMock.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {});
		ddMock
			.onPost(
				`${DD_BASE}/api/v2/feature-flags/dd-flag-1/environments/dd-prod/disable`,
			)
			.reply(202, {});

		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.summary).toMatchObject({ synced: 1, disabled: 0 });
		expect(report.disableApprovalRequests).toEqual([
			{ key: flag.key, env: 'Production' },
		]);
	});

	it('does not update an existing non-semver channel in Auto mode', async () => {
		const flag = ldFlag();
		flag.name = flag.key;
		const datadogKey = `prefixed-${flag.key}`;
		mockLaunchDarklySource(flag);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: datadogKey,
						name: 'Old Datadog name',
						migration_metadata: {
							project_key: 'proj',
							flag_key: flag.key,
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(
			200,
			ddFlagDetail([
				{ id: 'true-id', key: 'true', name: 'On', value: 'true' },
				{ id: 'false-id', key: 'false', name: 'Off', value: 'false' },
			]),
		);
		ddMock.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {});

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [`${flag.key},${datadogKey}`],
			},
			doExport: false,
			distributionChannelMode: 'auto',
		});

		const updateAttributes = flagUpdateAttributes(ddMock, 'dd-flag-1');
		expect(updateAttributes).toHaveLength(2);
		expect(updateAttributes).toContainEqual({ name: datadogKey });
		expect(updateAttributes).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: expect.anything() }),
			]),
		);
		expect(updateAttributes).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ distribution_channel: expect.anything() }),
			]),
		);
	});

	it.each([
		{
			existing: false,
			active: true,
			exportReport: true,
			conflict: false,
			status: 'Would create',
		},
		{
			existing: true,
			active: true,
			exportReport: true,
			conflict: false,
			status: 'Would sync',
		},
		{
			existing: true,
			active: false,
			exportReport: true,
			conflict: false,
			status: 'Would sync',
		},
		{
			existing: true,
			active: true,
			exportReport: true,
			conflict: true,
			status: 'Failed',
		},
		{
			existing: false,
			active: true,
			exportReport: false,
			conflict: false,
			status: '',
		},
	])('exports dry-run Excel results only when requested: %j', async ({
		existing,
		active,
		exportReport,
		conflict,
		status,
	}) => {
		const flag = ldFlag();
		const environment = flag.environments?.production;
		if (!environment) throw new Error('Test flag is missing production');
		environment.on = active;
		mockLaunchDarklyNewFlag(flag);
		if (existing) {
			ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
				data: [
					{
						id: 'dd-flag-1',
						type: 'feature-flags',
						attributes: {
							key: flag.key,
							...(conflict
								? {
										migration_metadata: {
											project_key: 'another-project',
											flag_key: flag.key,
										},
									}
								: {}),
						},
					},
				],
				meta: { page: { total: 1 } },
			});
		}
		let exportedWorkbook: ExcelJS.Workbook | undefined;
		const writeFile = jest
			.fn<ExcelJS.Xlsx['writeFile']>()
			.mockResolvedValue(undefined);
		jest
			.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get')
			.mockImplementation(function (this: ExcelJS.Workbook) {
				exportedWorkbook = this;
				return { writeFile } as unknown as ExcelJS.Xlsx;
			});

		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, true, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [flag.key],
				overwriteExisting: true,
			},
			doExport: exportReport,
		});

		expect(ddMock.history.post).toHaveLength(0);
		expect(ddMock.history.put).toHaveLength(0);
		expect(ddMock.history.delete).toHaveLength(0);
		expect(parseLastJsonOutput(stdoutWrites).summary).toEqual({
			created: existing ? 0 : 1,
			synced: existing && !conflict ? 1 : 0,
			skipped: 0,
			errored: conflict ? 1 : 0,
			enabled: 0,
			disabled: 0,
		});
		if (!exportReport) {
			expect(writeFile).not.toHaveBeenCalled();
			return;
		}
		expect(writeFile).toHaveBeenCalledTimes(1);
		const filename = writeFile.mock.calls[0][0];
		expect(path.dirname(filename)).toBe(process.cwd());
		expect(path.basename(filename)).toMatch(
			/^migration-dry-run-export-.*\.xlsx$/,
		);
		const sheet = exportedWorkbook?.getWorksheet('Migration Results');
		if (!sheet) throw new Error('Missing migration sheet');
		const rows: unknown[][] = [];
		sheet.eachRow((row) => rows.push(row.values as unknown[]));
		expect(
			rows.some((row) =>
				row.some((cell) =>
					String(cell).includes('No changes were written to Datadog'),
				),
			),
		).toBe(true);
		const flagRow = rows.find((row) => row[2] === flag.key);
		expect(flagRow?.[8]).toBe(status);
	});

	describe.each([
		'launchdarkly',
		'eppo',
	] as const)('%s collision-resolved name re-sync', (provider) => {
		it.each([
			{ active: true, dryRun: false },
			{ active: false, dryRun: false },
			{ active: true, dryRun: true },
			{ active: false, dryRun: true },
		])('preserves the name and continues syncing: %j', async ({
			active,
			dryRun,
		}) => {
			const ld = ldFlag();
			if (!ld.environments?.production) throw new Error('Missing environment');
			ld.environments.production.on = active;
			const eppo = eppoFlag();
			if (!eppo.environments?.[0]) throw new Error('Missing environment');
			eppo.environments[0].active = active;
			const name = `${ld.name} (2)`;
			if (provider === 'launchdarkly') mockLaunchDarklySource(ld);
			else {
				eppoMock.onGet(`${EPPO_BASE}/api/v1/feature-flags`).reply(200, [eppo]);
				eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
			}
			ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
				data: [
					{
						id: 'dd-flag-1',
						type: 'feature-flags',
						attributes: {
							key: ld.key,
							name,
							migration_metadata:
								provider === 'launchdarkly'
									? { project_key: 'proj', flag_key: ld.key }
									: { provider: 'eppo', source_id: '1', source_key: eppo.key },
						},
					},
				],
				meta: { page: { total: 1 } },
			});
			ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
				data: [ddEnvironment('dd-prod', 'Production', true)],
			});
			ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(
				200,
				ddFlagDetail(
					provider === 'launchdarkly'
						? [
								{ id: 'true-id', key: 'true', name: 'true', value: 'true' },
								{ id: 'false-id', key: 'false', name: 'false', value: 'false' },
							]
						: [
								{
									id: 'on-id',
									key: 'on',
									name: 'On',
									value: 'on',
									migration_metadata: { provider: 'eppo', source_id: '10' },
								},
								{
									id: 'off-id',
									key: 'off',
									name: 'Off',
									value: 'off',
									migration_metadata: { provider: 'eppo', source_id: '20' },
								},
							],
				),
			);
			ddMock
				.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
				.reply((request) =>
					JSON.parse(request.data).data.attributes.name === ld.name
						? [
								409,
								{
									errors: [
										{ detail: 'a feature flag with this name already exists' },
									],
								},
							]
						: [200, {}],
				);
			ddMock
				.onPut(
					`${DD_BASE}/api/v2/feature-flags/dd-flag-1/environments/dd-prod/allocations`,
				)
				.reply(200, {});
			ddMock
				.onPost(
					`${DD_BASE}/api/v2/feature-flags/dd-flag-1/environments/dd-prod/enable`,
				)
				.reply(200, {});
			ddMock
				.onPost(
					`${DD_BASE}/api/v2/feature-flags/dd-flag-1/environments/dd-prod/disable`,
				)
				.reply(200, {});
			if (provider === 'launchdarkly')
				await runLaunchDarklyMigration(
					'dd-api-key',
					'dd-app-key',
					DD_SITE,
					dryRun,
					{
						nonInteractive: {
							projectKey: 'proj',
							envMap: [['production', 'Production']],
							flagKeys: [ld.key],
						},
					},
				);
			else
				await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, dryRun, {
					nonInteractive: {
						envMap: [['Production', 'Production']],
						flagKeys: [eppo.key],
					},
				});
			const report = parseLastJsonOutput(stdoutWrites);
			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			if (dryRun) {
				expect(report.requests).toContainEqual(
					expect.objectContaining({
						method: 'PUT',
						path: '/api/v2/feature-flags/dd-flag-1',
						body: { data: { type: 'feature-flags', attributes: { name } } },
					}),
				);
				expect(ddMock.history.put).toHaveLength(0);
				expect(ddMock.history.post).toHaveLength(0);
			} else {
				expect(flagUpdateAttributes(ddMock, 'dd-flag-1')).toContainEqual({
					name,
				});
				expect(flagUpdateAttributes(ddMock, 'dd-flag-1')).toContainEqual(
					expect.objectContaining({ tags: expect.any(Array) }),
				);
				expect(
					ddMock.history.put.filter((r) => r.url?.endsWith('/allocations')),
				).toHaveLength(active ? 1 : 0);
			}
		});
	});

	it('includes a LaunchDarkly name update in a full-sync dry run', async () => {
		const flag = ldFlag();
		flag.name = 'Renamed LaunchDarkly flag';
		const environment = flag.environments?.production;
		if (!environment) throw new Error('Test flag is missing production');
		environment.on = true;
		mockLaunchDarklySource(flag);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: flag.key,
						name: 'Old Datadog name',
						migration_metadata: {
							project_key: 'proj',
							flag_key: flag.key,
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});

		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, true, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
			distributionChannelMode: 'auto',
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.requests).toContainEqual(
			expect.objectContaining({
				method: 'PUT',
				path: '/api/v2/feature-flags/dd-flag-1',
				body: {
					data: {
						type: 'feature-flags',
						attributes: { name: flag.name },
					},
				},
			}),
		);
	});

	it('synchronizes an Eppo flag name when no environments need enabling', async () => {
		const flag = eppoFlag();
		flag.name = 'Renamed Eppo flag';
		eppoMock.onGet(`${EPPO_BASE}/api/v1/feature-flags`).reply(200, [flag]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
		mockDatadogForEppoExistingFlag();
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(
			200,
			ddFlagDetail([
				{
					id: 'on-id',
					key: 'on',
					name: 'On',
					value: 'on',
					migration_metadata: { provider: 'eppo', source_id: '10' },
				},
				{
					id: 'off-id',
					key: 'off',
					name: 'Off',
					value: 'off',
					migration_metadata: { provider: 'eppo', source_id: '20' },
				},
			]),
		);
		ddMock.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {});

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
		});

		const updateAttributes = flagUpdateAttributes(ddMock, 'dd-flag-1');
		expect(updateAttributes).toContainEqual({ name: flag.name });
	});

	it('includes an Eppo name update in a full-sync dry run', async () => {
		const flag = eppoFlag();
		flag.name = 'Renamed Eppo flag';
		const environment = flag.environments?.[0];
		if (!environment) throw new Error('Test flag is missing production');
		environment.active = true;
		eppoMock.onGet(`${EPPO_BASE}/api/v1/feature-flags`).reply(200, [flag]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
		mockDatadogForEppoExistingFlag();
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(
			200,
			ddFlagDetail([
				{
					id: 'on-id',
					key: 'on',
					name: 'On',
					value: 'on',
					migration_metadata: { provider: 'eppo', source_id: '10' },
				},
				{
					id: 'off-id',
					key: 'off',
					name: 'Off',
					value: 'off',
					migration_metadata: { provider: 'eppo', source_id: '20' },
				},
			]),
		);

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, true, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.requests).toContainEqual(
			expect.objectContaining({
				method: 'PUT',
				path: '/api/v2/feature-flags/dd-flag-1',
				body: {
					data: {
						type: 'feature-flags',
						attributes: { name: flag.name },
					},
				},
			}),
		);
	});

	it('records an Eppo disable approval request without counting the environment as disabled', async () => {
		mockEppoSourceData();
		mockDatadogForEppoExistingFlag();
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(
			200,
			ddFlagDetail([
				{
					id: 'on-id',
					key: 'on',
					name: 'On',
					value: 'on',
					migration_metadata: { provider: 'eppo', source_id: '10' },
				},
				{
					id: 'off-id',
					key: 'off',
					name: 'Off',
					value: 'off',
					migration_metadata: { provider: 'eppo', source_id: '20' },
				},
			]),
		);
		ddMock.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {});
		ddMock
			.onPost(
				`${DD_BASE}/api/v2/feature-flags/dd-flag-1/environments/dd-prod/disable`,
			)
			.reply(202, {});

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['flag-with-bad-variant'],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.summary).toMatchObject({ disabled: 0 });
		expect(report.disableApprovalRequests).toEqual([
			{ key: 'flag-with-bad-variant', env: 'Production' },
		]);
	});

	it('captures Eppo live variant sync failures in the migration report', async () => {
		mockEppoSourceData();
		mockDatadogForEppoExistingFlag();
		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());
		ddMock.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {});
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags/dd-flag-1/variants`)
			.reply(400, { errors: [{ detail: 'Invalid variant value' }] });

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['flag-with-bad-variant'],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: 'flag-with-bad-variant', error: 'Invalid variant value' },
		]);
		expect(process.exitCode).toBe(1);
	});

	it('captures Eppo dry-run flag failures in the dry-run report', async () => {
		mockEppoSourceData();
		mockDatadogForEppoExistingFlag();
		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(500, { errors: [{ detail: 'detail lookup failed' }] });

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, true, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['flag-with-bad-variant'],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: 'flag-with-bad-variant', error: 'detail lookup failed' },
		]);
		expect(process.exitCode).toBe(1);
	});

	it('captures LaunchDarkly live variant sync failures in the migration report', async () => {
		// Must be multivariate: boolean flags skip variant sync and would not hit this path.
		const flag: LDFlag = {
			name: 'Flag With Bad Variant',
			kind: 'multivariate',
			key: 'flag-with-bad-variant',
			variations: [
				{ _id: 'var-on', value: 'on', name: 'On' },
				{ _id: 'var-off', value: 'off', name: 'Off' },
			],
			defaults: { onVariation: 0, offVariation: 1 },
			environments: {
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
			tags: [],
			archived: false,
			deprecated: false,
			temporary: false,
		};
		ldMock.onGet(`${LD_BASE}/api/v2/projects`).reply(200, {
			items: [{ key: 'proj', name: 'Project' }],
			totalCount: 1,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/flags/proj/${flag.key}`).reply(200, flag);
		ldMock.onGet(`${LD_BASE}/api/v2/projects/proj`).reply(200, {
			environments: {
				items: [
					{
						key: 'production',
						name: 'Production',
						color: '417505',
						archived: false,
					},
				],
			},
		});
		ldMock.onGet(`${LD_BASE}/api/v2/roles`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/teams`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: flag.key,
						name: flag.name,
						migration_metadata: {
							project_key: 'proj',
							flag_key: flag.key,
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());
		ddMock.onPut(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`).reply(200, {});
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags/dd-flag-1/variants`)
			.reply(400, { errors: [{ detail: 'Invalid LD variant value' }] });

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: flag.key, error: 'Invalid LD variant value' },
		]);
		expect(process.exitCode).toBe(1);
	});

	it('captures LaunchDarkly remapped create failures under the source flag key', async () => {
		const flag = ldFlag();
		const datadogKey = `mobile-${flag.key}`;
		ldMock.onGet(`${LD_BASE}/api/v2/projects`).reply(200, {
			items: [{ key: 'proj', name: 'Project' }],
			totalCount: 1,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/flags/proj/${flag.key}`).reply(200, flag);
		ldMock.onGet(`${LD_BASE}/api/v2/projects/proj`).reply(200, {
			environments: {
				items: [
					{
						key: 'production',
						name: 'Production',
						color: '417505',
						archived: false,
					},
				],
			},
		});
		ldMock.onGet(`${LD_BASE}/api/v2/roles`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/teams`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [],
			meta: { page: { total: 0 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags`)
			.reply(400, { errors: [{ detail: 'Create failed' }] });

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [`${flag.key},${datadogKey}`],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: flag.key, error: 'Create failed' },
		]);
		expect(report.flagKeyMapping).toEqual([
			{ sourceKey: flag.key, datadogKey },
		]);
		expect(process.exitCode).toBe(1);
	});
});
