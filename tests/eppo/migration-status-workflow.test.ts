import fs from 'node:fs';
import os from 'node:os';
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
import { ddClient } from '../../src/datadog/api.js';
import type { SavedFilterSummary } from '../../src/datadog/types.js';
import { eppoClient } from '../../src/eppo/api.js';
import type { EppoAudience, EppoFlag } from '../../src/eppo/types.js';

const selectEnvironments = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const linkEnvironments = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const selectFlags = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const confirm = jest.fn<(...args: unknown[]) => Promise<boolean>>();
const printSummary = jest.fn();
jest.unstable_mockModule('../../src/eppo/migrate.js', () => ({
	selectEnvironments,
	linkEnvironments,
	selectFlags,
}));
jest.unstable_mockModule('../../src/components/Confirm.js', () => ({
	confirm,
}));
jest.unstable_mockModule('../../src/migration-status/index.js', () => ({
	clearScreen: () => {},
	printHeader: async () => {},
	printSummary,
	errorMessage: (error: unknown) => String(error),
	withProgress: async (_label: string, action: () => Promise<unknown>) =>
		action(),
	loadDetails: async (
		_label: string,
		items: unknown[],
		action: (item: unknown) => Promise<void>,
	) => {
		for (const item of items) await action(item);
	},
}));
const { runEppoMigrationStatusWorkflow, buildEppoAudienceLookups } =
	await import('../../src/migration-status/eppo.js');
const environment = { id: 10, name: 'Prod', active: true, is_production: true };
const target = {
	id: 'dd-prod',
	name: 'Prod',
	is_production: true,
	queries: [],
};
const flag: EppoFlag = {
	id: 42,
	name: 'Checkout',
	key: 'checkout',
	variation_type: 'BOOLEAN',
	tag_names: [],
	created_at: '',
	updated_at: '',
	environments: [environment],
	variations: [{ id: 1, name: 'On', variant_key: 'true' }],
	allocations: [],
};
const audience: EppoAudience = {
	id: 7,
	name: 'US',
	description: '',
	is_archived: false,
	targeting_rules: [
		{
			id: 70,
			conditions: [
				{ attribute: 'country', operator: 'ONE_OF', values: ['US'] },
			],
		},
	],
};
const filter: SavedFilterSummary = {
	id: 'sf-7',
	name: 'US',
	migration_metadata: { provider: 'eppo', audience_id: 7 },
};

describe('Eppo status workflow', () => {
	let eppoMock: AxiosMockAdapter;
	let ddMock: AxiosMockAdapter;
	let directory: string;
	beforeEach(() => {
		jest.clearAllMocks();
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eppo-workflow-'));
		jest.spyOn(process, 'cwd').mockReturnValue(directory);
		jest.spyOn(console, 'log').mockImplementation(() => {});
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		ddMock = new AxiosMockAdapter(ddClient as never);
		eppoMock
			.onGet('https://eppo.cloud/api/v1/feature-flags')
			.reply(200, [flag]);
		ddMock.onGet('https://api.datadoghq.com/api/v2/feature-flags').reply(200, {
			data: [
				{
					id: 'dd-flag',
					attributes: {
						key: flag.key,
						migration_metadata: { provider: 'eppo', source_id: '42' },
					},
				},
			],
		});
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/environments')
			.reply(200, {
				data: [
					{
						id: target.id,
						attributes: { name: target.name, is_production: true, queries: [] },
					},
				],
			});
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/dd-flag')
			.reply(200, {
				data: {
					id: 'dd-flag',
					attributes: {
						key: flag.key,
						name: flag.name,
						bucketing_mode: 'EPPO',
						variants: [
							{
								id: 'dd-on',
								key: 'on',
								name: 'On',
								value: 'true',
								migration_metadata: { provider: 'eppo', source_id: '1' },
							},
						],
						feature_flag_environments: [
							{ environment_id: target.id, status: 'ENABLED', allocations: [] },
						],
					},
				},
			});
		selectEnvironments.mockResolvedValue([environment]);
		linkEnvironments.mockResolvedValue(new Map([[10, [target]]]));
		selectFlags.mockResolvedValue([flag]);
		confirm.mockResolvedValue(true);
	});
	afterEach(() => {
		eppoMock.restore();
		ddMock.restore();
		jest.restoreAllMocks();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	it('writes a workbook using only GET requests and Eppo credentials', async () => {
		const output = await runEppoMigrationStatusWorkflow(
			'eppo-token',
			'dd-api',
			'dd-app',
			'datadoghq.com',
		);
		expect(output).toMatch(/migration-status-eppo-.*\.xlsx$/);
		if (output === null) throw new Error('Expected a workbook');
		expect(fs.existsSync(output)).toBe(true);
		expect(selectFlags).toHaveBeenCalledWith(
			[flag],
			new Map([[flag.key, 'dd-flag']]),
			[environment],
			[],
			[],
			'Select flags to check:',
		);
		for (const mock of [eppoMock, ddMock])
			expect(mock.history.every((request) => request.method === 'get')).toBe(
				true,
			);
		expect(eppoMock.history[0].headers?.['x-eppo-token']).toBe('eppo-token');
	});
	it.each([
		'environments',
		'mapping',
		'flags',
		'confirmation',
	])('cancels at %s without fetching details or writing a report', async (step) => {
		if (step === 'environments') selectEnvironments.mockResolvedValue(null);
		if (step === 'mapping') linkEnvironments.mockResolvedValue(null);
		if (step === 'flags') selectFlags.mockResolvedValue(null);
		if (step === 'confirmation') confirm.mockResolvedValue(false);
		expect(
			await runEppoMigrationStatusWorkflow(
				'eppo',
				'api',
				'app',
				'datadoghq.com',
			),
		).toBeNull();
		expect(fs.readdirSync(directory)).toEqual([]);
		expect(
			ddMock.history.filter((request) => request.url?.endsWith('/dd-flag')),
		).toHaveLength(0);
	});
	it('re-prompts empty selections and exports detail failures as needs-review', async () => {
		selectEnvironments.mockResolvedValueOnce([]);
		selectFlags.mockResolvedValueOnce([]);
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/dd-flag')
			.reply(403);
		expect(
			await runEppoMigrationStatusWorkflow(
				'eppo',
				'api',
				'app',
				'datadoghq.com',
			),
		).not.toBeNull();
		expect(selectEnvironments).toHaveBeenCalledTimes(2);
		expect(selectFlags).toHaveBeenCalledTimes(2);
		expect(printSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				flags: [expect.objectContaining({ status: 'needs-review' })],
			}),
		);
	});
	it('fetches missing source details by Eppo ID', async () => {
		selectFlags.mockResolvedValue([{ ...flag, allocations: undefined }]);
		eppoMock
			.onGet('https://eppo.cloud/api/v1/feature-flags/42')
			.reply(200, flag);
		await runEppoMigrationStatusWorkflow('eppo', 'api', 'app', 'datadoghq.com');
		expect(
			eppoMock.history.some((request) => request.url?.endsWith('/42')),
		).toBe(true);
	});
	it.each([
		'inline',
		'explicit',
		'failure',
	])('loads paginated saved filters for %s audience references without writes', async (kind) => {
		const targeted: EppoFlag = {
			...flag,
			allocations: [
				{
					id: 100,
					key: 'targeted',
					name: 'Targeted',
					environment_id: 10,
					type: 'FEATURE_GATE',
					percent_exposure: 1,
					is_default: false,
					variation_weight: [{ id: 77, variation_id: 1, weight: 100 }],
					targeting_rules:
						kind === 'explicit'
							? []
							: [{ conditions: audience.targeting_rules[0].conditions }],
					...(kind === 'explicit'
						? { audiences: [{ audience_id: 7, type: 'IS_IN' as const }] }
						: {}),
				},
			],
		};
		selectFlags.mockResolvedValue([targeted]);
		eppoMock
			.onGet('https://eppo.cloud/api/v1/audiences')
			.reply(kind === 'failure' ? 403 : 200, [audience]);
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/saved-filters')
			.reply((request) => [
				200,
				{
					data:
						request.params.offset === 0
							? [{ id: 'unrelated', attributes: { name: 'Unrelated' } }]
							: [
									{
										id: filter.id,
										attributes: {
											name: filter.name,
											migration_metadata: filter.migration_metadata,
										},
									},
								],
					meta: { total: 2 },
				},
			]);
		ddMock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/dd-flag')
			.reply(200, {
				data: {
					id: 'dd-flag',
					attributes: {
						key: flag.key,
						name: flag.name,
						bucketing_mode: 'EPPO',
						variants: [
							{
								id: 'dd-on',
								key: 'on',
								name: 'On',
								value: 'true',
								migration_metadata: { provider: 'eppo', source_id: '1' },
							},
						],
						feature_flag_environments: [
							{
								environment_id: target.id,
								status: 'ENABLED',
								allocations: [
									{
										key: 'targeted',
										eppo_allocation_id: 100,
										variant_weights: [
											{
												variant_id: 'dd-on',
												value: 100,
												eppo_variant_weight_id: 77,
											},
										],
										targeting_rules: [
											{ conditions: [{ saved_filter_id: 'sf-7' }] },
										],
									},
								],
							},
						],
					},
				},
			});
		await runEppoMigrationStatusWorkflow('eppo', 'api', 'app', 'datadoghq.com');
		expect(printSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				flags: [
					expect.objectContaining({
						status: kind === 'failure' ? 'needs-review' : 'in-sync',
					}),
				],
			}),
		);
		expect(
			ddMock.history.filter((request) =>
				request.url?.endsWith('/saved-filters'),
			),
		).toHaveLength(2);
		for (const mock of [eppoMock, ddMock])
			expect(mock.history.every((request) => request.method === 'get')).toBe(
				true,
			);
	});
	it('builds explicit and inline audience lookups without accepting unrelated or ambiguous filters', () => {
		const lookups = buildEppoAudienceLookups([audience], [filter]);
		expect(lookups.savedFilterLookup.get(7)).toBe('sf-7');
		expect([...lookups.fingerprintLookup.values()]).toEqual(['sf-7']);
		expect(
			buildEppoAudienceLookups(
				[audience],
				[{ ...filter, migration_metadata: undefined }],
			).savedFilterLookup.size,
		).toBe(0);
		expect(
			buildEppoAudienceLookups(
				[audience],
				[filter, { ...filter, id: 'duplicate' }],
			).savedFilterLookup.size,
		).toBe(0);
	});
});
