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
import type { DatadogOrgPair } from '../../src/datadog/orgs.js';
import { runDatadogMigration } from '../../src/datadog-migration/migrate.js';
import type { DatadogDryRunFile } from '../../src/datadog-migration/types.js';
import { buildDatadogMigrationRows } from '../../src/datadog-migration/xlsx.js';

const pair: DatadogOrgPair = {
	source: {
		role: 'source',
		apiKey: 'source-api',
		appKey: 'source-app',
		site: 'source.invalid',
	},
	target: {
		role: 'target',
		apiKey: 'target-api',
		appKey: 'target-app',
		site: 'target.invalid',
	},
};
const sourceBase = 'https://api.source.invalid/api/v2/feature-flags';
const targetBase = 'https://api.target.invalid/api/v2/feature-flags';

function resource(id: string, attributes: Record<string, unknown>) {
	return { id, attributes };
}

describe('Datadog migration workflow', () => {
	let mock: AxiosMockAdapter;
	let writes: string[];

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
		writes = [];
		jest.spyOn(process.stdout, 'write').mockImplementation(((
			chunk: unknown,
		) => {
			writes.push(String(chunk));
			return true;
		}) as never);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
	});

	afterEach(() => {
		mock.restore();
		jest.restoreAllMocks();
		process.exitCode = undefined;
	});

	function inventory(
		active: boolean,
		existing = true,
		jsonSchema?: string | null,
		schedules: { source?: unknown; target?: unknown } = {},
	) {
		for (const [base, org] of [
			[sourceBase, 'source'],
			[targetBase, 'target'],
		] as const) {
			mock.onGet(base).reply(200, {
				data:
					org === 'target' && !existing
						? []
						: [resource(`${org}-flag`, { key: 'config', name: 'Config' })],
				meta: { page: { total: org === 'target' && !existing ? 0 : 1 } },
			});
			mock.onGet(`${base}/environments`).reply(200, {
				data: [
					resource(`${org}-prod`, {
						name: 'Production',
						queries: ['prod'],
						is_production: true,
					}),
				],
			});
			mock.onGet(`${base}/${org}-flag`).reply(200, {
				data: resource(`${org}-flag`, {
					key: 'config',
					name: 'Config',
					value_type: 'JSON',
					json_schema: org === 'source' ? jsonSchema : '{"type":"string"}',
					variants: [
						{
							id: `${org}-variant`,
							key: 'config',
							name: 'Config',
							value: '{"enabled":true}',
						},
					],
					feature_flag_environments: [
						{
							environment_id: `${org}-prod`,
							status: active ? 'ENABLED' : 'DISABLED',
							default_variant_id: `${org}-variant`,
							allocations: schedules[org]
								? [
										{
											id: `${org}-filter`,
											key: 'scheduled-filter',
											name: 'Scheduled filter',
											type: 'CANARY',
											exposure_schedule: schedules[org],
											variant_weights: [
												{ variant_id: `${org}-variant`, value: 100 },
											],
										},
									]
								: [],
						},
					],
				}),
			});
		}
		mock.onPut(`${targetBase}/target-flag`).reply(200, {});
		mock
			.onPut(`${targetBase}/target-flag/environments/target-prod/allocations`)
			.reply(200, {});
		mock
			.onPost(`${targetBase}/target-flag/environments/target-prod/disable`)
			.reply(200, {});
	}

	async function run(dryRun = false): Promise<DatadogDryRunFile> {
		await runDatadogMigration(pair, dryRun, {
			tagMode: 'replace',
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['config'],
			},
		});
		const output = [...writes]
			.reverse()
			.find(
				(write) =>
					write.trimStart().startsWith('{') && write.includes('"summary"'),
			);
		if (!output) throw new Error('Missing migration report');
		return JSON.parse(output);
	}

	describe.each([true, false])('schema sync with active=%s', (active) => {
		it.each([
			{ dryRun: false, schema: '{"type":"object"}' },
			{ dryRun: true, schema: '{"type":"object"}' },
			{ dryRun: false, schema: null },
			{ dryRun: true, schema: null },
			{ dryRun: false, schema: undefined },
			{ dryRun: true, schema: undefined },
		])('replaces or removes the source schema: %j', async ({
			dryRun,
			schema,
		}) => {
			inventory(active, true, schema);
			mock
				.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
				.reply(200, {});
			const report = await run(dryRun);
			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			const attributes = { json_schema: schema ?? null };
			if (dryRun) {
				expect(report.requests).toContainEqual({
					method: 'PUT',
					path: '/api/v2/feature-flags/target-flag',
					body: { data: { type: 'feature-flags', attributes } },
				});
				expect(mock.history.put).toHaveLength(0);
				expect(mock.history.post).toHaveLength(0);
			} else {
				expect(
					mock.history.put
						.filter((request) => request.url === `${targetBase}/target-flag`)
						.map((request) => JSON.parse(request.data).data.attributes),
				).toContainEqual(attributes);
			}
		});
	});

	const pendingSchedule = {
		id: 'source-schedule',
		absolute_start_time: null,
		scheduled_start_time: '2099-01-01T00:00:00Z',
		control_variant_id: 'source-variant',
		rollout_options: {
			strategy: 'NO_ROLLOUT',
			autostart: false,
			selection_interval_ms: 0,
		},
		rollout_steps: [
			{
				id: 'source-step',
				exposure_ratio: 1,
				grouped_step_index: 0,
				is_pause_record: false,
			},
		],
	};

	describe.each([true, false])('schedule migration dryRun=%s', (dryRun) => {
		it.each([
			true,
			false,
		])('copies schedules on create (active=%s)', async (active) => {
			inventory(active, false, undefined, { source: pendingSchedule });
			mock.onPost(targetBase).reply(201, {
				data: { id: 'target-flag', attributes: { key: 'config' } },
			});
			mock
				.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
				.reply(200, {});
			const report = await run(dryRun);
			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			const body = dryRun
				? report.requests.find(
						(request) =>
							request.method === 'POST' &&
							request.path === '/api/v2/feature-flags',
					)?.body
				: JSON.parse(
						mock.history.post.find((request) => request.url === targetBase)
							?.data,
					);
			expect(body).toMatchObject({
				data: {
					attributes: {
						allocations: [
							expect.objectContaining({
								type: 'CANARY',
								exposure_schedule: expect.objectContaining({
									control_variant_key: 'config',
									rollout_options: expect.objectContaining({
										scheduled_start: 'absolute:2099-01-01T00:00:00.000Z',
									}),
								}),
							}),
						],
					},
				},
			});
			expect(JSON.stringify(body)).not.toContain('source-schedule');
			expect(JSON.stringify(body)).not.toContain('source-step');
		});

		it.each([
			true,
			false,
		])('syncs schedules only in active environments (active=%s)', async (active) => {
			inventory(active, true, undefined, {
				source: pendingSchedule,
				target: {
					...pendingSchedule,
					id: 'target-schedule',
					control_variant_id: 'target-variant',
				},
			});
			mock
				.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
				.reply(200, {});
			const report = await run(dryRun);
			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			if (dryRun) {
				const request = report.requests.find((request) =>
					request.path.includes('/allocations'),
				);
				if (active)
					expect(request?.body).toEqual([
						expect.objectContaining({
							exposure_schedule: expect.objectContaining({
								control_variant_key: 'config',
							}),
						}),
					]);
				else expect(request).toBeUndefined();
			} else {
				const request = mock.history.put.find((request) =>
					request.url?.includes('/allocations'),
				);
				if (active) {
					expect(JSON.parse(request?.data)).toMatchObject({
						data: [
							{
								attributes: {
									exposure_schedule: expect.objectContaining({
										id: 'target-schedule',
										control_variant_id: 'target-variant',
									}),
								},
							},
						],
					});
					expect(request?.data).not.toContain('source-schedule');
				} else expect(request).toBeUndefined();
			}
		});

		it.each([
			'source',
			'target',
		] as const)('skips before writing when the %s schedule is running', async (org) => {
			inventory(true, true, undefined, {
				[org]: {
					...pendingSchedule,
					control_variant_id: `${org}-variant`,
					absolute_start_time: new Date(Date.now() - 1000).toISOString(),
					scheduled_start_time: null,
					rollout_options: {
						strategy: 'UNIFORM_INTERVALS',
						autostart: false,
						selection_interval_ms: 60000,
					},
					rollout_steps: [
						{
							exposure_ratio: 0.1,
							grouped_step_index: 0,
							is_pause_record: false,
							interval_ms: 60000,
						},
						{
							exposure_ratio: 1,
							grouped_step_index: 1,
							is_pause_record: false,
							interval_ms: null,
						},
					],
				},
			});
			const report = await run(dryRun);
			expect(report.summary.skipped).toBe(1);
			expect(mock.history.put).toHaveLength(0);
			expect(mock.history.post).toHaveLength(0);
		});

		describe.each([
			true,
			false,
		])('completed rollouts existing=%s', (existing) => {
			it.each([
				true,
				false,
			])('copies final exposure without replaying a ramp (active=%s)', async (active) => {
				inventory(active, existing, undefined, {
					source: {
						...pendingSchedule,
						absolute_start_time: '2020-01-01T00:00:00Z',
						scheduled_start_time: null,
						rollout_options: {
							strategy: 'UNIFORM_INTERVALS',
							autostart: false,
							selection_interval_ms: 60000,
						},
						rollout_steps: [
							{
								exposure_ratio: 0.1,
								grouped_step_index: 0,
								is_pause_record: false,
								interval_ms: 60000,
							},
							{
								exposure_ratio: 0.4,
								grouped_step_index: 1,
								is_pause_record: false,
								interval_ms: null,
							},
						],
					},
					target: existing
						? {
								...pendingSchedule,
								id: 'target-schedule',
								control_variant_id: 'target-variant',
							}
						: undefined,
				});
				mock.onPost(targetBase).reply(201, {
					data: { id: 'target-flag', attributes: { key: 'config' } },
				});
				mock
					.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
					.reply(200, {});
				const report = await run(dryRun);
				expect(report.failures).toEqual([]);
				expect(existing ? report.summary.synced : report.summary.created).toBe(
					1,
				);
				const expected = expect.objectContaining({
					absolute_start_time: '2020-01-01T00:00:00.000Z',
					rollout_options: {
						strategy: 'NO_ROLLOUT',
						autostart: false,
						scheduled_start: 'now',
						selection_interval_ms: 0,
					},
					rollout_steps: [
						{
							exposure_ratio: 0.4,
							grouped_step_index: 0,
							is_pause_record: false,
							interval_ms: null,
						},
					],
				});
				if (existing && !active) {
					expect(
						report.requests?.some((request) =>
							request.path.includes('/allocations'),
						) ?? false,
					).toBe(false);
					expect(
						mock.history.put.some((request) =>
							request.url?.includes('/allocations'),
						),
					).toBe(false);
				} else if (dryRun) {
					if (existing)
						expect(
							report.requests.find((request) =>
								request.path.includes('/allocations'),
							)?.body,
						).toEqual([
							expect.objectContaining({ exposure_schedule: expected }),
						]);
					else
						expect(
							report.requests.find(
								(request) => request.path === '/api/v2/feature-flags',
							)?.body,
						).toMatchObject({
							data: {
								attributes: { allocations: [{ exposure_schedule: expected }] },
							},
						});
				} else {
					expect(
						JSON.parse(
							mock.history.put.find((request) =>
								request.url?.includes('/allocations'),
							)?.data,
						),
					).toMatchObject({
						data: [{ attributes: { exposure_schedule: expected } }],
					});
				}
			});
		});

		it('removes an unstarted target schedule when absent from the source', async () => {
			inventory(true, true, undefined, {
				target: { ...pendingSchedule, control_variant_id: 'target-variant' },
			});
			mock
				.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
				.reply(200, {});
			const report = await run(dryRun);
			expect(report.failures).toEqual([]);
			if (dryRun)
				expect(
					report.requests.find((request) =>
						request.path.includes('/allocations'),
					)?.body,
				).toEqual([]);
			else
				expect(
					JSON.parse(
						mock.history.put.find((request) =>
							request.url?.includes('/allocations'),
						)?.data,
					),
				).toEqual({ data: [] });
		});

		it('syncs completed targets without changing strategy or replaying the ramp', async () => {
			const completed = {
				...pendingSchedule,
				absolute_start_time: '2020-01-01T00:00:00Z',
				scheduled_start_time: null,
				rollout_options: {
					strategy: 'UNIFORM_INTERVALS',
					autostart: true,
					selection_interval_ms: 60000,
				},
				rollout_steps: [
					{
						exposure_ratio: 0.1,
						grouped_step_index: 0,
						is_pause_record: false,
						interval_ms: 60000,
					},
					{
						exposure_ratio: 0.4,
						grouped_step_index: 1,
						is_pause_record: false,
						interval_ms: null,
					},
				],
			};
			inventory(true, true, undefined, {
				source: completed,
				target: {
					...completed,
					id: 'target-schedule',
					control_variant_id: 'target-variant',
				},
			});
			mock
				.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
				.reply(200, {});
			const report = await run(dryRun);
			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			const expected = expect.objectContaining({
				rollout_options: expect.objectContaining({
					strategy: 'UNIFORM_INTERVALS',
					selection_interval_ms: 60000,
					scheduled_start: 'now',
				}),
				rollout_steps: [
					{
						exposure_ratio: 0.4,
						grouped_step_index: 0,
						interval_ms: null,
						is_pause_record: false,
					},
				],
			});
			if (dryRun)
				expect(
					report.requests.find((request) =>
						request.path.includes('/allocations'),
					)?.body,
				).toEqual([expect.objectContaining({ exposure_schedule: expected })]);
			else
				expect(
					JSON.parse(
						mock.history.put.find((request) =>
							request.url?.includes('/allocations'),
						)?.data,
					),
				).toMatchObject({
					data: [{ attributes: { exposure_schedule: expected } }],
				});
		});

		it('does not reset a completed target to an unstarted schedule', async () => {
			inventory(true, true, undefined, {
				source: pendingSchedule,
				target: {
					...pendingSchedule,
					control_variant_id: 'target-variant',
					absolute_start_time: '2020-01-01T00:00:00Z',
					scheduled_start_time: null,
				},
			});
			const report = await run(dryRun);
			expect(report.summary.skipped).toBe(1);
			expect(mock.history.put).toHaveLength(0);
			expect(mock.history.post).toHaveLength(0);
		});
	});

	it.each([
		true,
		false,
	])('records pending enable approvals (existing=%s)', async (existing) => {
		inventory(true, existing);
		mock.onPost(targetBase).reply(201, {
			data: { id: 'target-flag', attributes: { key: 'config' } },
		});
		mock
			.onPost(`${targetBase}/target-flag/environments/target-prod/enable`)
			.reply(202, {});
		const report = await run();
		expect(report.failures).toEqual([]);
		expect(report.summary.enabled).toBe(0);
		expect(report.enableApprovalRequests).toEqual([
			{ key: 'config', env: 'Production' },
		]);
		expect(buildDatadogMigrationRows(report)[0].details).toContain(
			'Enable in Production is awaiting approval',
		);
	});
});
