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
							allocations: [],
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
