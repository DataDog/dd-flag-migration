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
	restoredKeys?: string[];
	replacedKeys?: string[];
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
		existing?:
			| Record<string, unknown>
			| Array<{
					id: string;
					attributes: Record<string, unknown>;
			  }>,
	): void {
		const existingFlags = Array.isArray(existing)
			? existing
			: existing
				? [{ id: FLAG_ID, attributes: existing }]
				: [];
		eppoMock.onGet(`${EPPO_BASE}/api/v1/feature-flags`).reply(200, [flag]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: existingFlags.map((entry) => ({ ...entry, type: 'feature-flags' })),
			meta: { page: { total: existingFlags.length } },
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

	async function run(
		dryRun: boolean,
		flag = eppoFlag(),
		replaceLegacyFlags?: boolean,
	): Promise<Report> {
		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, dryRun, {
			tagMode: 'replace',
			replaceLegacyFlags,
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
				'PUT /api/v2/feature-flags/checkout-redesign/environments/dd-prod/allocations?default_variant_key=control',
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
			expect(attributes).not.toHaveProperty('default_variant_key');
			expect(JSON.stringify(attributes)).not.toContain('sourceId');
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('sets every environment default before enabling', async () => {
			mockSources(eppoFlag());
			const report = await run(false);

			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
				'POST /api/v2/feature-flags',
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/allocations`,
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
				`POST /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
			]);
			expect(ddMock.history.put.map((r) => r.params)).toEqual([
				{ default_variant_key: 'control' },
				{ default_variant_key: 'treatment' },
			]);
		});

		it.each([
			true,
			false,
		])('creates the flag without a production default when Eppo has none (active=%s)', async (active) => {
			const flag = eppoFlag();
			flag.allocations = flag.allocations?.filter((a) => a.id !== 7002);
			if (flag.environments?.[0]) flag.environments[0].active = active;
			mockSources(flag);
			const report = await run(false, flag);

			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			const create = ddMock.history.post.find(
				(r) => r.url === `${DD_BASE}/api/v2/feature-flags`,
			);
			expect(
				JSON.parse(create?.data as string).data.attributes,
			).not.toHaveProperty('default_variant_key');
			// Production keeps no default, so unmatched subjects get the SDK
			// fallback as in Eppo; only staging's default is set.
			expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
				'POST /api/v2/feature-flags',
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
				...(active
					? [
							`POST /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
						]
					: []),
			]);
		});
	});

	describe('an archived Datadog flag migrated from Eppo', () => {
		function archivedAttributes(): Record<string, unknown> {
			return {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				archived_at: '2026-10-22T00:00:00Z',
				bucketing_mode: 'EPPO',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			};
		}

		it.each([
			{ dryRun: false, active: true },
			{ dryRun: true, active: true },
			{ dryRun: false, active: false },
			{ dryRun: true, active: false },
		])('automatically restores before syncing (dryRun=$dryRun, active=$active)', async ({
			dryRun,
			active,
		}) => {
			const flag = eppoFlag();
			if (flag.environments?.[0]) flag.environments[0].active = active;
			mockSources(flag, archivedAttributes());

			const report = await run(dryRun, flag);

			expect(report.failures).toEqual([]);
			expect(report.summary).toMatchObject({
				created: 0,
				synced: 1,
				errored: 0,
			});
			expect(report.restoredKeys).toEqual([flag.key]);
			expect(ddMock.history.get[0].params).toEqual({ limit: 50, offset: 0 });
			const requests = dryRun
				? (report.requests ?? [])
				: writes.map((write) => ({ ...write, path: write.url }));
			expect(requests[0]).toMatchObject({
				method: 'POST',
				path: `/api/v2/feature-flags/${FLAG_ID}/unarchive`,
				body: {},
			});
			expect(
				requests.filter((request) => request.path.endsWith('/unarchive')),
			).toHaveLength(1);
			expect(
				requests.some((request) => request.path === '/api/v2/feature-flags'),
			).toBe(false);
			const allocationRequests = requests.filter((request) =>
				request.path.includes('/allocations'),
			);
			expect(allocationRequests).toHaveLength(2);
			for (const request of allocationRequests) {
				expect(request.path).toContain(
					`/feature-flags/${FLAG_ID}/environments/`,
				);
			}
			const paths = requests.map((request) => request.path);
			const enableIndex = paths.findIndex((requestPath) =>
				requestPath.endsWith('/enable'),
			);
			if (active) {
				expect(enableIndex).toBeGreaterThan(
					paths.lastIndexOf(allocationRequests[1].path),
				);
			} else {
				expect(enableIndex).toBe(-1);
				expect(
					paths.filter((requestPath) => requestPath.endsWith('/disable')),
				).toHaveLength(2);
			}
			if (dryRun) {
				expect(writes).toEqual([]);
				expect(allocationRequests[0].body).toEqual(expectedProdAllocations);
			} else {
				expect(allocationRequests[0].body).toMatchObject({
					data: [
						{
							attributes: {
								key: 'experiment-alloc',
								eppo_allocation_id: 7001,
								variant_weights: [
									{ variant_id: 'treatment-id', eppo_variant_weight_id: 901 },
									{ variant_id: 'control-id', eppo_variant_weight_id: 902 },
								],
							},
						},
					],
				});
			}
		});

		it.each([
			false,
			true,
		])('prefers an active match regardless of list order (archivedFirst=%s)', async (archivedFirst) => {
			const active = {
				id: FLAG_ID,
				attributes: { ...archivedAttributes(), archived_at: null },
			};
			const archived = {
				id: 'archived-flag',
				attributes: archivedAttributes(),
			};
			mockSources(
				eppoFlag(),
				archivedFirst ? [archived, active] : [active, archived],
			);

			const report = await run(false);

			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			expect(report.restoredKeys).toBeUndefined();
			expect(writes.some((write) => write.url.endsWith('/unarchive'))).toBe(
				false,
			);
			expect(writes.every((write) => write.url.includes(FLAG_ID))).toBe(true);
		});

		it('does not restore an archived flag over a native active flag', async () => {
			mockSources(eppoFlag(), [
				{ id: 'archived-flag', attributes: archivedAttributes() },
				{
					id: FLAG_ID,
					attributes: { key: 'checkout-redesign', bucketing_mode: 'DATADOG' },
				},
			]);

			const report = await run(false);

			expect(report.failures[0].error).toContain('was not migrated from Eppo');
			expect(writes).toEqual([]);
		});

		it.each([
			{ provider: 'launchdarkly', source_id: '1' },
			{ provider: 'datadog', source_id: '1' },
			{ provider: 'eppo', source_id: 'different-flag' },
			{ provider: 'eppo', source_key: 'checkout-redesign' },
			{},
		])('never restores a key-only match with metadata %j', async (metadata) => {
			mockSources(eppoFlag(), {
				...archivedAttributes(),
				migration_metadata: metadata,
			});

			const report = await run(false);

			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			expect(report.restoredKeys).toBeUndefined();
			expect(writes.some((write) => write.url.endsWith('/unarchive'))).toBe(
				false,
			);
		});

		it.each([
			false,
			true,
		])('fails ambiguous archived matches without writing (dryRun=%s)', async (dryRun) => {
			mockSources(eppoFlag(), [
				{ id: FLAG_ID, attributes: archivedAttributes() },
				{ id: 'second-archived-flag', attributes: archivedAttributes() },
			]);

			const report = await run(dryRun);

			expect(report.summary).toMatchObject({
				created: 0,
				synced: 0,
				errored: 1,
			});
			expect(report.failures[0].error).toContain(
				'multiple archived Datadog flags',
			);
			expect(report.failures[0].error).toContain('second-archived-flag');
			expect(report.requests ?? []).toEqual([]);
			expect(writes).toEqual([]);
		});

		it('refuses to restore a linked flag whose immutable key differs', async () => {
			mockSources(eppoFlag(), { ...archivedAttributes(), key: 'original-key' });

			const report = await run(false);

			expect(report.failures[0].error).toContain('whose key differs');
			expect(writes).toEqual([]);
		});

		it.each([
			201, 202, 403, 409, 500,
		])('does not sync or create a replacement if restoration returns %s', async (status) => {
			mockSources(eppoFlag(), archivedAttributes());
			ddMock
				.onPost(/.*/)
				.reply(status, { errors: [{ detail: 'Restoration blocked' }] });

			const report = await run(false);

			expect(report.summary).toMatchObject({
				created: 0,
				synced: 0,
				errored: 1,
			});
			expect(report.failures[0].error).toContain(
				'Failed to restore archived flag',
			);
			if (status === 201 || status === 202) {
				expect(report.failures[0].error).toContain('requires approval');
			}
			expect(report.restoredKeys).toBeUndefined();
			expect(ddMock.history.post.map((request) => request.url)).toEqual([
				`${DD_BASE}/api/v2/feature-flags/${FLAG_ID}/unarchive`,
			]);
			expect(ddMock.history.put).toHaveLength(0);
			expect(ddMock.history.delete).toHaveLength(0);
		});

		it('records a successful restoration even when the subsequent sync fails', async () => {
			mockSources(eppoFlag(), archivedAttributes());
			ddMock.onPut(/.*/).reply(500, { errors: [{ detail: 'Sync failed' }] });

			const report = await run(false);

			expect(report.summary).toMatchObject({
				created: 0,
				synced: 0,
				errored: 1,
			});
			expect(report.restoredKeys).toEqual(['checkout-redesign']);
			expect(report.failures[0].error).toContain('Sync failed');
			expect(ddMock.history.post.map((request) => request.url)).toEqual([
				`${DD_BASE}/api/v2/feature-flags/${FLAG_ID}/unarchive`,
			]);
		});

		it('does not restore a flag that fails source validation', async () => {
			const flag = eppoFlag();
			for (const weight of flag.allocations?.[0].variation_weight ?? [])
				weight.weight = 0;
			mockSources(flag, archivedAttributes());

			const report = await run(false, flag);

			expect(report.summary.errored).toBe(1);
			expect(report.restoredKeys).toBeUndefined();
			expect(writes).toEqual([]);
		});
	});

	describe('a Datadog flag migrated before Eppo bucketing', () => {
		const LEGACY_ID = 'legacy-flag';

		function legacyAttributes(): Record<string, unknown> {
			return {
				key: 'checkout-redesign',
				name: 'Checkout Redesign',
				archived_at: '2026-10-22T00:00:00Z',
				bucketing_mode: 'DATADOG',
				migration_metadata: { provider: 'eppo', source_id: '1' },
			};
		}

		const legacyDetailUrl = `${DD_BASE}/api/v2/feature-flags/${LEGACY_ID}`;
		const legacyPolicyUrl = `${DD_BASE}/api/v2/restriction_policy/feature-flag:${LEGACY_ID}`;

		function mockLegacy(
			flag = eppoFlag(),
			attributes = legacyAttributes(),
			detailOverrides: Record<string, unknown> = {},
		): void {
			mockSources(flag, [{ id: LEGACY_ID, attributes }]);
			ddMock.onGet(legacyPolicyUrl).reply(404);
			ddMock.onGet(legacyDetailUrl).reply(200, {
				data: {
					id: LEGACY_ID,
					type: 'feature-flags',
					attributes: {
						...attributes,
						require_approval: false,
						variants: migratedVariants,
						feature_flag_environments: [
							{
								environment_id: 'dd-prod',
								status: 'DISABLED',
								allocations: [
									{ id: 'legacy-alloc-1', key: 'experiment-alloc' },
								],
							},
							{
								environment_id: 'dd-staging',
								status: 'DISABLED',
								allocations: [],
							},
							{
								environment_id: 'dd-unmapped',
								status: 'DISABLED',
								allocations: [{ id: 'legacy-alloc-2', key: 'qa-alloc' }],
							},
						],
						...detailOverrides,
					},
				},
			});
		}

		const clearPaths = [
			`/api/v2/feature-flags/${LEGACY_ID}/environments/dd-prod/allocations`,
			`/api/v2/feature-flags/${LEGACY_ID}/environments/dd-unmapped/allocations`,
		];

		it('replaces an archived flag with a new EPPO flag after clearing its targeting filters', async () => {
			mockLegacy();
			const report = await run(false, eppoFlag(), true);

			expect(report.failures).toEqual([]);
			expect(report.summary).toMatchObject({
				created: 1,
				synced: 0,
				errored: 0,
			});
			expect(report.replacedKeys).toEqual(['checkout-redesign']);
			expect(report.restoredKeys).toBeUndefined();
			expect(report.legacyBucketingKeys).toBeUndefined();
			expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
				...clearPaths.map((p) => `PUT ${p}`),
				'POST /api/v2/feature-flags',
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/allocations`,
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
				`POST /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
			]);
			expect(writes[0].body).toEqual({ data: [] });
			expect(writes[1].body).toEqual({ data: [] });
			const attributes = (
				writes[2].body as { data: { attributes: Record<string, unknown> } }
			).data.attributes;
			expect(attributes).toMatchObject({
				key: 'checkout-redesign',
				bucketing_mode: 'EPPO',
				migration_metadata: { provider: 'eppo', source_id: '1' },
				allocations: [
					{ environment_id: 'dd-prod', ...expectedProdAllocations[0] },
				],
			});
		});

		it('previews the replacement in a dry run without writing', async () => {
			mockLegacy();
			const report = await run(true, eppoFlag(), true);

			expect(report.failures).toEqual([]);
			expect(report.summary.created).toBe(1);
			expect(report.replacedKeys).toEqual(['checkout-redesign']);
			expect(writes).toEqual([]);
			const flagRequests = (report.requests ?? []).filter((r) =>
				r.path.startsWith('/api/v2/feature-flags'),
			);
			expect(flagRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
				...clearPaths.map((p) => `PUT ${p}`),
				'POST /api/v2/feature-flags',
				'PUT /api/v2/feature-flags/checkout-redesign/environments/dd-prod/allocations?default_variant_key=control',
				'PUT /api/v2/feature-flags/checkout-redesign/environments/dd-staging/allocations?default_variant_key=treatment',
				'POST /api/v2/feature-flags/checkout-redesign/environments/dd-prod/enable',
			]);
			expect(flagRequests[0].body).toEqual([]);
		});

		it('replaces a flag whose key differs, using the Eppo key', async () => {
			mockLegacy(eppoFlag(), { ...legacyAttributes(), key: 'original-key' });
			const report = await run(false, eppoFlag(), true);

			expect(report.failures).toEqual([]);
			expect(report.replacedKeys).toEqual(['checkout-redesign']);
			const create = writes.find((w) => w.url === '/api/v2/feature-flags');
			expect(
				(create?.body as { data: { attributes: { key: string } } }).data
					.attributes.key,
			).toBe('checkout-redesign');
		});

		it.each([
			undefined,
			false,
		])('restores it with Datadog bucketing when replaceLegacyFlags=%s', async (replaceLegacyFlags) => {
			mockLegacy();
			const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
			const report = await run(false, eppoFlag(), replaceLegacyFlags);

			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			expect(report.restoredKeys).toEqual(['checkout-redesign']);
			expect(report.legacyBucketingKeys).toEqual(['checkout-redesign']);
			expect(report.replacedKeys).toBeUndefined();
			expect(writes[0].url).toBe(
				`/api/v2/feature-flags/${LEGACY_ID}/unarchive`,
			);
			expect(writes.some((w) => w.url === '/api/v2/feature-flags')).toBe(false);
			const hint = logSpy.mock.calls.some((args) =>
				String(args[0]).includes('Pass --replace-legacy-flags'),
			);
			expect(hint).toBe(replaceLegacyFlags === undefined);
		});

		it.each([
			201, 202, 403, 500,
		])('creates no replacement if clearing targeting filters returns %s', async (status) => {
			mockLegacy();
			ddMock
				.onPut(/.*/)
				.reply(status, { errors: [{ detail: 'Clearing blocked' }] });
			const report = await run(false, eppoFlag(), true);

			expect(report.summary).toMatchObject({
				created: 0,
				synced: 0,
				errored: 1,
			});
			expect(report.failures[0].error).toContain(
				'Failed to clear the targeting filters of flag',
			);
			expect(report.failures[0].error).toContain('No replacement was created');
			if (status === 201 || status === 202) {
				expect(report.failures[0].error).toContain('requires approval');
			}
			expect(report.replacedKeys).toBeUndefined();
			expect(ddMock.history.put.map((r) => r.url)).toEqual([
				`${DD_BASE}${clearPaths[0]}`,
			]);
			expect(ddMock.history.post).toHaveLength(0);
		});

		it('reports cleared targeting filters when creating the replacement fails', async () => {
			mockLegacy();
			ddMock
				.onPost(`${DD_BASE}/api/v2/feature-flags`)
				.reply(500, { errors: [{ detail: 'Create failed' }] });
			const report = await run(false, eppoFlag(), true);

			expect(report.summary.errored).toBe(1);
			expect(report.failures[0].error).toContain('Create failed');
			expect(report.failures[0].error).toContain('were cleared in 2 env(s)');
			expect(report.failures[0].error).not.toContain('This migration archived');
			expect(report.replacedKeys).toBeUndefined();
		});

		function activeLegacyAttributes(): Record<string, unknown> {
			return { ...legacyAttributes(), archived_at: null };
		}

		it.each([
			[false, 'dd-unmapped'],
			[true, 'dd-unmapped'],
			[false, 'dd-staging'],
		] as const)('blocks a replacement (dryRun=%s) that would leave %s offline', async (dryRun, environmentId) => {
			mockLegacy(eppoFlag(), activeLegacyAttributes(), {
				feature_flag_environments: [
					{
						environment_id: environmentId,
						status: 'ENABLED',
						allocations: null,
					},
				],
			});
			const report = await run(dryRun, eppoFlag(), true);

			expect(report.failures[0].error).toContain(
				`replacement would not enable (${environmentId})`,
			);
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
			expect(report.requests ?? []).toHaveLength(0);
		});

		it.each([
			true,
			undefined,
		])('blocks replacement if require_approval is %s', async (requireApproval) => {
			mockLegacy(eppoFlag(), activeLegacyAttributes(), {
				require_approval: requireApproval,
			});
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain(
				requireApproval
					? 'requires approval for changes'
					: 'replacement preflight',
			);
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('blocks replacement of an archived flag with a restriction policy', async () => {
			mockLegacy();
			ddMock.onGet(legacyPolicyUrl).reply(200, {
				data: {
					attributes: {
						bindings: [{ relation: 'editor', principals: ['team:editors'] }],
					},
				},
			});
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain('has a restriction policy');
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it.each([
			200, 403,
		])('does not archive when the policy cannot be verified (HTTP %s)', async (status) => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			ddMock
				.onGet(legacyPolicyUrl)
				.reply(status, { errors: [{ detail: 'Policy unavailable' }] });
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain(
				status === 200 ? 'missing bindings' : 'Policy unavailable',
			);
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it.each([
			'2',
			undefined,
		])('does not replace a same-key flag with Eppo source ID %s', async (sourceId) => {
			mockLegacy(eppoFlag(), {
				...activeLegacyAttributes(),
				migration_metadata: { provider: 'eppo', source_id: sourceId },
			});
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain(
				'does not have the matching Eppo source ID',
			);
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('does not replace an alias match when another active flag owns the replacement key', async () => {
			mockSources(eppoFlag(), [
				{
					id: FLAG_ID,
					attributes: { key: 'checkout-redesign', name: 'Native flag' },
				},
				{
					id: LEGACY_ID,
					attributes: {
						...activeLegacyAttributes(),
						key: 'original-key',
						migration_metadata: {
							provider: 'eppo',
							source_id: '1',
							source_key: 'checkout-redesign',
						},
					},
				},
			]);
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain(
				'already uses the replacement key or Eppo source ID',
			);
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('leaves an active flag unchanged if reading cleanup details fails', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			ddMock
				.onGet(legacyDetailUrl)
				.reply(500, { errors: [{ detail: 'Flag detail unavailable' }] });
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain('Flag detail unavailable');
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('does not archive if the source ID no longer matches in the flag detail', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes(), {
				migration_metadata: { provider: 'eppo', source_id: '2' },
			});
			const report = await run(false, eppoFlag(), true);

			expect(report.failures[0].error).toContain(
				'no longer matches the expected key and Eppo source ID',
			);
			expect(ddMock.history.post).toHaveLength(0);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('archives an active flag before replacing it', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes(), {
				feature_flag_environments: [
					{
						environment_id: 'dd-prod',
						status: 'ENABLED',
						allocations: [{ id: 'legacy-alloc-1', key: 'experiment-alloc' }],
					},
					{
						environment_id: 'dd-unmapped',
						status: 'DISABLED',
						allocations: [{ id: 'legacy-alloc-2', key: 'qa-alloc' }],
					},
				],
			});
			const report = await run(false, eppoFlag(), true);

			expect(report.failures).toEqual([]);
			expect(report.summary).toMatchObject({ created: 1, synced: 0 });
			expect(report.replacedKeys).toEqual(['checkout-redesign']);
			expect(report.legacyBucketingKeys).toBeUndefined();
			expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
				`POST /api/v2/feature-flags/${LEGACY_ID}/archive`,
				...clearPaths.map((p) => `PUT ${p}`),
				'POST /api/v2/feature-flags',
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/allocations`,
				`PUT /api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/allocations`,
				`POST /api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
			]);
			expect(
				(writes[3].body as { data: { attributes: Record<string, unknown> } })
					.data.attributes,
			).toMatchObject({ key: 'checkout-redesign', bucketing_mode: 'EPPO' });
		});

		it('previews archiving an active flag in a dry run', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			const report = await run(true, eppoFlag(), true);

			expect(report.failures).toEqual([]);
			expect(report.replacedKeys).toEqual(['checkout-redesign']);
			expect(writes).toEqual([]);
			expect(
				(report.requests ?? [])
					.filter((r) => r.path.startsWith('/api/v2/feature-flags'))
					.slice(0, 4)
					.map((r) => `${r.method} ${r.path}`),
			).toEqual([
				`POST /api/v2/feature-flags/${LEGACY_ID}/archive`,
				...clearPaths.map((p) => `PUT ${p}`),
				'POST /api/v2/feature-flags',
			]);
		});

		it.each([
			201, 202, 403, 500,
		])('does not proceed if archiving an active flag returns %s', async (status) => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			ddMock
				.onPost(/.*/)
				.reply(status, { errors: [{ detail: 'Archive blocked' }] });
			const report = await run(false, eppoFlag(), true);

			expect(report.summary).toMatchObject({ created: 0, errored: 1 });
			expect(report.failures[0].error).toContain(
				'Failed to confirm the archive of flag "checkout-redesign" (legacy-flag)',
			);
			expect(report.failures[0].error).toContain(
				"Verify the old flag's archive status",
			);
			if (status === 201 || status === 202) {
				expect(report.failures[0].error).toContain('requires approval');
			}
			expect(ddMock.history.post.map((r) => r.url)).toEqual([
				`${DD_BASE}/api/v2/feature-flags/${LEGACY_ID}/archive`,
			]);
			expect(ddMock.history.put).toHaveLength(0);
		});

		it('reports that an active flag was archived when clearing fails', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			ddMock.onPut(/.*/).reply(201, {});
			const report = await run(false, eppoFlag(), true);

			expect(report.summary.errored).toBe(1);
			const { error } = report.failures[0];
			expect(error).toContain('requires approval');
			expect(error).toContain('No replacement was created');
			expect(error).toContain(
				'This migration archived flag "checkout-redesign" (legacy-flag), so it serves no value until it is replaced.',
			);
			expect(error).not.toContain('were cleared');
			expect(error).toContain('Re-run the migration');
			expect(ddMock.history.post.map((r) => r.url)).toEqual([
				`${DD_BASE}/api/v2/feature-flags/${LEGACY_ID}/archive`,
			]);
		});

		it('reports archived and cleared state when creating the replacement of an active flag fails', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			ddMock
				.onPost(`${DD_BASE}/api/v2/feature-flags`)
				.reply(500, { errors: [{ detail: 'Create failed' }] });
			const report = await run(false, eppoFlag(), true);

			const { error } = report.failures[0];
			expect(error).toContain('Create failed');
			expect(error).toContain('This migration archived flag');
			expect(error).toContain('were cleared in 2 env(s)');
			expect(report.replacedKeys).toBeUndefined();
		});

		it('reports a created replacement when a later default update fails', async () => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			ddMock
				.onPut(/.*/)
				.reply((config) =>
					config.url?.startsWith(`${legacyDetailUrl}/`)
						? [200, {}]
						: [500, { errors: [{ detail: 'Default update failed' }] }],
				);
			const report = await run(false, eppoFlag(), true);

			const { error } = report.failures[0];
			expect(error).toContain('Default update failed');
			expect(error).toContain('This migration archived flag');
			expect(error).toContain(`The replacement (${FLAG_ID}) was created`);
			expect(error).toContain('Re-run the migration to finish syncing it');
			expect(report.replacedKeys).toEqual(['checkout-redesign']);
			expect(
				ddMock.history.post.some((request) => request.url?.endsWith('/enable')),
			).toBe(false);
		});

		it.each([
			undefined,
			false,
		])('keeps Datadog bucketing for an active flag when replaceLegacyFlags=%s', async (replaceLegacyFlags) => {
			mockLegacy(eppoFlag(), activeLegacyAttributes());
			const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
			const report = await run(false, eppoFlag(), replaceLegacyFlags);

			expect(report.failures).toEqual([]);
			expect(report.summary.synced).toBe(1);
			expect(report.legacyBucketingKeys).toEqual(['checkout-redesign']);
			expect(report.replacedKeys).toBeUndefined();
			expect(writes.some((w) => w.url.endsWith('/archive'))).toBe(false);
			expect(writes.some((w) => w.url === '/api/v2/feature-flags')).toBe(false);
			const hint = logSpy.mock.calls.some((args) =>
				String(args[0]).includes('Pass --replace-legacy-flags'),
			);
			expect(hint).toBe(replaceLegacyFlags === undefined);
		});

		it('restores an archived EPPO replacement instead of its legacy predecessor', async () => {
			mockSources(eppoFlag(), [
				{ id: LEGACY_ID, attributes: legacyAttributes() },
				{
					id: FLAG_ID,
					attributes: { ...legacyAttributes(), bucketing_mode: 'EPPO' },
				},
			]);
			const report = await run(false, eppoFlag(), true);

			expect(report.failures).toEqual([]);
			expect(report.restoredKeys).toEqual(['checkout-redesign']);
			expect(report.replacedKeys).toBeUndefined();
			expect(writes[0].url).toBe(`/api/v2/feature-flags/${FLAG_ID}/unarchive`);
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
