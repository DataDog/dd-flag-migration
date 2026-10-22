/**
 * End-to-end Eppo migrations with Eppo-compatible bucketing: what is sent to
 * Datadog, in which order, and which existing flags are refused.
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
import type { EppoFlag } from '../../src/eppo/types.js';

const DD_SITE = 'test.invalid';
const DD_BASE = `https://api.${DD_SITE}`;
const EPPO_BASE = 'https://eppo.cloud';
const FLAG_ID = 'dd-flag-1';

interface Report {
	summary: { created: number; synced: number; errored: number };
	failures: Array<{ key: string; error: string }>;
	legacyBucketingKeys?: string[];
	requests?: Array<{
		method: string;
		path: string;
		body: unknown;
	}>;
}

function eppoFlag(): EppoFlag {
	return {
		id: 1,
		key: 'checkout-redesign',
		name: 'Checkout Redesign',
		variation_type: 'STRING',
		tag_names: [],
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		variations: [
			{ id: 100, name: 'Control', variant_key: 'control', is_active: true },
			{ id: 200, name: 'Treatment', variant_key: 'treatment', is_active: true },
		],
		environments: [
			{ id: 10, name: 'Production', active: true, is_production: true },
			{ id: 20, name: 'Staging', active: false, is_production: false },
		],
		allocations: [
			{
				id: 7001,
				key: 'experiment-alloc',
				name: 'Experiment',
				environment_id: 10,
				type: 'EXPERIMENT',
				enabled: true,
				percent_exposure: 0.5,
				is_default: false,
				variation_weight: [
					{ id: 901, variation_id: 200, weight: 1 },
					{ id: 902, variation_id: 100, weight: 3 },
				],
				targeting_rules: [],
			},
			{
				id: 7002,
				key: 'prod-default',
				name: 'Default',
				environment_id: 10,
				type: 'FEATURE_GATE',
				enabled: true,
				percent_exposure: 1,
				is_default: true,
				variation_weight: [{ id: 903, variation_id: 100, weight: 100 }],
				targeting_rules: [],
			},
			{
				id: 7003,
				key: 'staging-default',
				name: 'Default',
				environment_id: 20,
				type: 'FEATURE_GATE',
				enabled: true,
				percent_exposure: 1,
				is_default: true,
				variation_weight: [{ id: 904, variation_id: 200, weight: 100 }],
				targeting_rules: [],
			},
		],
	};
}

function ddEnvironment(id: string, name: string, isProduction: boolean) {
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

const migratedVariants = [
	{
		id: 'control-id',
		key: 'control',
		name: 'Control',
		value: 'control',
		migration_metadata: { provider: 'eppo', source_id: '100' },
	},
	{
		id: 'treatment-id',
		key: 'treatment',
		name: 'Treatment',
		value: 'treatment',
		migration_metadata: { provider: 'eppo', source_id: '200' },
	},
];

function parseReport(writes: string[]): Report {
	for (let i = writes.length - 1; i >= 0; i--) {
		const trimmed = writes[i].trimStart();
		if (trimmed.startsWith('{') && trimmed.includes('"summary"')) {
			return JSON.parse(writes[i]);
		}
	}
	throw new Error('No JSON output was written');
}

describe('Eppo migration with Eppo-compatible bucketing', () => {
	let ddMock: AxiosMockAdapter;
	let eppoMock: AxiosMockAdapter;
	let stdoutWrites: string[];
	/** Datadog writes in the order they were sent. */
	let writes: Array<{ method: string; url: string; body: unknown }>;

	beforeEach(() => {
		ddMock = new AxiosMockAdapter(ddClient as never);
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		stdoutWrites = [];
		writes = [];
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
	});

	afterEach(() => {
		ddMock.restore();
		eppoMock.restore();
		jest.restoreAllMocks();
		process.exitCode = undefined;
		delete process.env.EPPO_API_KEY;
	});

	function mockSources(
		flag: EppoFlag,
		existing?: Record<string, unknown>,
	): void {
		eppoMock.onGet(`${EPPO_BASE}/api/v1/feature-flags`).reply(200, [flag]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: existing
				? [{ id: FLAG_ID, type: 'feature-flags', attributes: existing }]
				: [],
			meta: { page: { total: existing ? 1 : 0 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [
				ddEnvironment('dd-prod', 'Production', true),
				ddEnvironment('dd-staging', 'Staging', false),
			],
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/${FLAG_ID}`).reply(200, {
			data: {
				id: FLAG_ID,
				type: 'feature-flags',
				attributes: {
					variants: migratedVariants,
					feature_flag_environments: [],
				},
			},
		});
		const record =
			(status: number, data: unknown = {}) =>
			(config: { method?: string; url?: string; data?: unknown }) => {
				writes.push({
					method: (config.method ?? '').toUpperCase(),
					url: (config.url ?? '').replace(DD_BASE, ''),
					body:
						typeof config.data === 'string'
							? JSON.parse(config.data)
							: undefined,
				});
				return [status, data] as [number, unknown];
			};
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags`)
			.reply(
				record(201, { data: { id: FLAG_ID, attributes: { key: flag.key } } }),
			);
		ddMock.onPut(/.*/).reply(record(200));
		ddMock.onPost(/.*/).reply(record(200));
	}

	async function run(dryRun: boolean, flag = eppoFlag()): Promise<Report> {
		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, dryRun, {
			tagMode: 'replace',
			nonInteractive: {
				envMap: [
					['Production', 'Production'],
					['Staging', 'Staging'],
				],
				flagKeys: [flag.key],
			},
		});
		return parseReport(stdoutWrites);
	}

	const expectedProdAllocations = [
		{
			name: 'Experiment',
			key: 'experiment-alloc',
			type: 'FEATURE_GATE',
			variant_weights: [
				{ variant_key: 'treatment', value: 1, eppo_variant_weight_id: 901 },
				{ variant_key: 'control', value: 3, eppo_variant_weight_id: 902 },
			],
			exposure_schedule: {
				rollout_options: { strategy: 'NO_ROLLOUT', scheduled_start: 'now' },
				rollout_steps: [
					{
						exposure_ratio: 0.5,
						interval_ms: null,
						is_pause_record: false,
						grouped_step_index: 0,
					},
				],
			},
			eppo_allocation_id: 7001,
		},
	];

	describe('a new flag', () => {
		it('dry run shows the Eppo fields and the create → PUT → enable order', async () => {
			mockSources(eppoFlag());
			const report = await run(true);

			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			const flagRequests = (report.requests ?? []).filter((r) =>
				r.path.startsWith('/api/v2/feature-flags'),
			);
			expect(flagRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
				'POST /api/v2/feature-flags',
				'PUT /api/v2/feature-flags/checkout-redesign/environments/dd-staging/allocations?default_variant_key=treatment',
				'POST /api/v2/feature-flags/checkout-redesign/environments/dd-prod/enable',
			]);

			const attributes = (
				flagRequests[0].body as {
					data: { attributes: Record<string, unknown> };
				}
			).data.attributes;
			expect(attributes).toMatchObject({
				key: 'checkout-redesign',
				bucketing_mode: 'EPPO',
				default_variant_key: 'control',
				migration_metadata: {
					provider: 'eppo',
					source_id: '1',
					source_key: 'checkout-redesign',
				},
				variants: [
					{
						key: 'control',
						name: 'Control',
						value: 'control',
						migration_metadata: {
							provider: 'eppo',
							source_id: '100',
							source_key: 'control',
						},
					},
					{
						key: 'treatment',
						name: 'Treatment',
						value: 'treatment',
						migration_metadata: {
							provider: 'eppo',
							source_id: '200',
							source_key: 'treatment',
						},
					},
				],
				allocations: [
					{ environment_id: 'dd-prod', ...expectedProdAllocations[0] },
				],
			});
			expect(JSON.stringify(attributes)).not.toContain('sourceId');
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('sets differing environment defaults before enabling', async () => {
			mockSources(eppoFlag());
			const report = await run(false);

			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
				'POST /api/v2/feature-flags',
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
				`POST /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
			]);
			const stagingSync = ddMock.history.put.find((r) =>
				r.url?.includes('/dd-staging/allocations'),
			);
			expect(stagingSync?.params).toEqual({ default_variant_key: 'treatment' });
		});

		it.each([
			true,
			false,
		])('fails without writing when production has no default (active=%s)', async (active) => {
			const flag = eppoFlag();
			flag.allocations = flag.allocations?.filter((a) => a.id !== 7002);
			if (flag.environments?.[0]) flag.environments[0].active = active;
			mockSources(flag);
			const report = await run(false, flag);

			expect(report.summary).toMatchObject({ created: 0, errored: 1 });
			expect(report.failures).toEqual([
				{
					key: 'checkout-redesign',
					error:
						'Flag "checkout-redesign" (Production): Eppo serves no default; unmatched subjects receive the SDK fallback value, which Datadog cannot represent. Set a default variation in Eppo, or run the migration interactively to choose one, and re-run the migration.',
				},
			]);
			expect(writes).toEqual([]);
			expect(process.exitCode).toBe(1);
		});
	});

	describe('an existing Datadog flag with the same key', () => {
		it('refuses to overwrite a native flag', async () => {
			mockSources(eppoFlag(), {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: 'DATADOG',
			});
			const report = await run(false);

			expect(report.failures).toEqual([
				{
					key: 'checkout-redesign',
					error: expect.stringContaining('was not migrated from Eppo'),
				},
			]);
			expect(writes).toEqual([]);
		});

		it.each([
			'EPPO',
			'DATADOG',
		])('refuses a linked %s flag whose key differs', async (bucketingMode) => {
			const flag = eppoFlag();
			flag.key = 'checkout-redesign-v2';
			mockSources(flag, {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: bucketingMode,
				migration_metadata: {
					provider: 'eppo',
					source_id: '1',
					source_key: 'checkout-redesign',
				},
			});
			const report = await run(false, flag);

			expect(report.failures).toEqual([
				{
					key: 'checkout-redesign-v2',
					error: expect.stringContaining(
						'linked to the Datadog flag "checkout-redesign", whose key differs',
					),
				},
			]);
			expect(writes).toEqual([]);
		});

		it('re-syncs an EPPO flag with Eppo IDs in every mapped environment', async () => {
			mockSources(eppoFlag(), {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: 'EPPO',
				migration_metadata: {
					provider: 'eppo',
					source_id: '1',
					source_key: 'checkout-redesign',
				},
			});
			const report = await run(false);

			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			expect(report.legacyBucketingKeys).toBeUndefined();
			const allocationWrites = writes.filter((w) =>
				w.url.endsWith('/allocations'),
			);
			expect(allocationWrites.map((w) => w.url)).toEqual([
				`/api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/allocations`,
				`/api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
			]);
			const prodBody = allocationWrites[0].body as {
				data: Array<{ attributes: Record<string, unknown> }>;
			};
			expect(prodBody.data[0].attributes).toMatchObject({
				eppo_allocation_id: 7001,
				variant_weights: [
					{
						variant_id: 'treatment-id',
						value: 1,
						eppo_variant_weight_id: 901,
					},
					{ variant_id: 'control-id', value: 3, eppo_variant_weight_id: 902 },
				],
			});
			// Targeting is written everywhere before any environment is enabled.
			const order = writes.map((w) => w.url);
			const lastAllocation = order.lastIndexOf(
				`/api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
			);
			expect(lastAllocation).toBeGreaterThan(-1);
			expect(
				order.indexOf(
					`/api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
				),
			).toBeGreaterThan(lastAllocation);
			expect(order).toContain(
				`/api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/disable`,
			);
		});

		it.each([
			true,
			false,
		])('syncs inactive environments when no environment is active (dryRun=%s)', async (dryRun) => {
			const flag = eppoFlag();
			for (const env of flag.environments ?? []) env.active = false;
			mockSources(flag, {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: 'EPPO',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			});
			const report = await run(dryRun, flag);

			expect(report.failures).toEqual([]);
			const paths = dryRun
				? (report.requests ?? [])
						.filter((r) => r.method === 'PUT')
						.map((r) => r.path)
				: writes.filter((w) => w.method === 'PUT').map((w) => w.url);
			expect(paths).toEqual(
				expect.arrayContaining([
					`/api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/allocations${dryRun ? '?default_variant_key=control' : ''}`,
					`/api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations${dryRun ? '?default_variant_key=treatment' : ''}`,
				]),
			);
			// No variant deletes in this branch.
			expect(ddMock.history.delete).toHaveLength(0);
		});

		it('keeps the Datadog defaults of an EPPO flag whose production default was removed', async () => {
			const flag = eppoFlag();
			flag.allocations = flag.allocations?.filter((a) => a.id !== 7002);
			mockSources(flag, {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: 'EPPO',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			});
			const report = await run(false, flag);

			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			const prodSync = ddMock.history.put.find((r) =>
				r.url?.endsWith('/dd-prod/allocations'),
			);
			expect(prodSync).toBeDefined();
			expect(prodSync?.params).toBeUndefined();
		});

		it('fails a flag migrated before Eppo bucketing whose production has no default', async () => {
			const flag = eppoFlag();
			flag.allocations = flag.allocations?.filter((a) => a.id !== 7002);
			mockSources(flag, {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: 'DATADOG',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			});
			const report = await run(false, flag);

			expect(report.failures).toEqual([
				{
					key: 'checkout-redesign',
					error: expect.stringContaining(
						'(Production): Eppo serves no default',
					),
				},
			]);
			expect(writes).toEqual([]);
		});

		it('re-syncs a flag migrated before Eppo bucketing without Eppo IDs', async () => {
			mockSources(eppoFlag(), {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				bucketing_mode: 'DATADOG',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			});
			const report = await run(true);

			expect(report.failures).toEqual([]);
			expect(report.legacyBucketingKeys).toEqual(['checkout-redesign']);
			const prodSync = (report.requests ?? []).find((r) =>
				r.path.includes('/dd-prod/allocations'),
			);
			expect(prodSync?.body).toEqual([
				{
					name: 'Experiment',
					key: 'experiment-alloc',
					type: 'FEATURE_GATE',
					variant_weights: [
						{ variant_key: 'treatment', value: 1 },
						{ variant_key: 'control', value: 3 },
					],
					exposure_schedule: expectedProdAllocations[0].exposure_schedule,
				},
			]);
			expect(JSON.stringify(report.requests)).not.toContain('eppo_');
		});
	});
});
