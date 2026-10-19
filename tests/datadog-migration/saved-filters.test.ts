import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../../src/datadog/api.js';
import type { DatadogOrgPair } from '../../src/datadog/orgs.js';
import type {
	DatadogStatusFlagDetail,
	SavedFilterSummary,
} from '../../src/datadog/types.js';
import { buildDatadogAllocations } from '../../src/datadog-migration/helpers/migration.js';
import {
	findOutsideSavedFilterUsage,
	isSafeAdoption,
	migrateDatadogSavedFilters,
	planSavedFilterAdoptions,
	planSavedFilterTargets,
	renderDatadogSavedFilterName,
} from '../../src/datadog-migration/saved-filters.js';

const pair: DatadogOrgPair = {
	source: {
		role: 'source',
		apiKey: 'source-api',
		appKey: 'source-app',
		site: 'source.example',
	},
	target: {
		role: 'target',
		apiKey: 'target-api',
		appKey: 'target-app',
		site: 'target.example',
	},
};

const SOURCE_LIST =
	'https://api.source.example/api/v2/feature-flags/saved-filters';
const TARGET_LIST =
	'https://api.target.example/api/v2/feature-flags/saved-filters';

function jsonApiFilter(filter: {
	id: string;
	name: string;
	description?: string;
	creation_type?: string;
	targeting_rules?: unknown[];
	migration_metadata?: unknown;
}) {
	const { id, ...attributes } = filter;
	return { id, type: 'saved-filters', attributes };
}

const betaRules = [
	{
		id: 'rule-1',
		conditions: [
			{ id: 'cond-1', operator: 'ONE_OF', attribute: 'id', value: ['user-a'] },
		],
	},
];

describe('renderDatadogSavedFilterName', () => {
	it('keeps the source name and adds an optional prefix', () => {
		expect(renderDatadogSavedFilterName('Beta users')).toBe('Beta users');
		expect(renderDatadogSavedFilterName('Beta users', 'copy')).toBe(
			'copy-Beta users',
		);
	});

	it('truncates names that exceed 200 bytes', () => {
		const name = renderDatadogSavedFilterName('a'.repeat(250), 'copy');
		expect(name).toMatch(/^copy-a+…$/);
		expect(Buffer.byteLength(name ?? '', 'utf8')).toBeLessThanOrEqual(200);
	});
});

describe('planSavedFilterTargets', () => {
	const source = (id: string, name: string): SavedFilterSummary => ({
		id,
		name,
	});

	it('reuses metadata matches and flags same-name filters as conflicts', () => {
		const plan = planSavedFilterTargets(
			[source('a', 'Alpha'), source('b', 'Bravo'), source('c', 'Charlie')],
			[
				{
					id: 'target-a',
					name: 'Renamed in target',
					migration_metadata: {
						provider: 'datadog',
						source_id: 'a',
						source_site: 'source.example',
					},
				},
				{ id: 'target-b', name: 'Bravo' },
			],
		);
		expect(plan.reused.map((item) => [item.source.id, item.target.id])).toEqual(
			[['a', 'target-a']],
		);
		expect(plan.pending.map((filter) => filter.id)).toEqual(['b', 'c']);
		expect([...plan.collisions]).toEqual(['b']);
	});
});

describe('findOutsideSavedFilterUsage', () => {
	const flag = (
		id: string,
		environments: Array<{ id: string; filterId: string; status?: string }>,
	): DatadogStatusFlagDetail => ({
		id,
		key: `${id}-key`,
		name: id,
		variants: [],
		environments: environments.map((environment) => ({
			environmentId: environment.id,
			status: 'ENABLED',
			allocations: [
				{
					key: 'rule',
					...(environment.status ? { status: environment.status } : {}),
					targeting_rules: [
						{ conditions: [{ saved_filter_id: environment.filterId }] },
					],
				},
			],
		})),
	});

	it('ignores targeting this run replaces and counts everything else', () => {
		const usage = findOutsideSavedFilterUsage(
			[
				flag('migrated', [
					{ id: 'prod', filterId: 'shared' },
					{ id: 'staging', filterId: 'shared' },
				]),
				flag('unrelated', [{ id: 'prod', filterId: 'shared' }]),
				flag('draft', [{ id: 'prod', filterId: 'shared', status: 'draft' }]),
				flag('other-filter', [{ id: 'prod', filterId: 'other' }]),
				flag('fully-migrated', [{ id: 'prod', filterId: 'shared' }]),
			],
			new Set(['shared']),
			new Map([
				['migrated', new Set(['prod'])],
				['fully-migrated', new Set(['prod'])],
			]),
		);
		expect(usage).toEqual(
			new Map([['shared', ['draft-key', 'migrated-key', 'unrelated-key']]]),
		);
	});
});

describe('planSavedFilterAdoptions', () => {
	const rules = (values: string[]) => [
		{ conditions: [{ operator: 'ONE_OF', attribute: 'id', value: values }] },
	];

	it('marks identical targeting and outside usage per target filter', () => {
		const candidates = planSavedFilterAdoptions(
			[
				{ id: 'a', name: 'Alpha', targeting_rules: rules(['x', 'y']) },
				{ id: 'b', name: 'Bravo', targeting_rules: rules(['x']) },
			],
			[
				{ id: 'target-a', name: 'Alpha', targeting_rules: rules(['y', 'x']) },
				{ id: 'target-b', name: 'Bravo', targeting_rules: rules(['z']) },
			],
			new Map([['target-b', ['other-flag']]]),
		);
		expect(
			candidates.map(({ target, identical, outsideFlagKeys }) => ({
				target: target?.id,
				identical,
				outsideFlagKeys,
			})),
		).toEqual([
			{ target: 'target-a', identical: true, outsideFlagKeys: [] },
			{ target: 'target-b', identical: false, outsideFlagKeys: ['other-flag'] },
		]);
		expect(
			candidates.map((candidate) => isSafeAdoption(candidate, true)),
		).toEqual([true, false]);
	});

	it('blocks managed, ambiguous, and unreadable target filters', () => {
		const candidates = planSavedFilterAdoptions(
			[
				{ id: 'a', name: 'Managed', targeting_rules: rules(['x']) },
				{ id: 'b', name: 'Duplicate', targeting_rules: rules(['x']) },
				{ id: 'c', name: 'Unreadable', targeting_rules: rules(['x']) },
			],
			[
				{
					id: 'target-a',
					name: 'Managed',
					targeting_rules: rules(['x']),
					migration_metadata: {
						provider: 'launchdarkly',
						project_key: 'project',
						segment_key: 'segment',
						environment_key: 'production',
						negated: false,
					},
				},
				{ id: 'target-b1', name: 'Duplicate', targeting_rules: rules(['x']) },
				{ id: 'target-b2', name: 'Duplicate', targeting_rules: rules(['x']) },
				{ id: 'target-c', name: 'Unreadable' },
			],
			new Map(),
		);
		expect(candidates.map((candidate) => candidate.blockedReason)).toEqual([
			'managed by a launchdarkly migration',
			'2 target saved filters share this name',
			'targeting could not be read',
		]);
		expect(
			candidates.some((candidate) => isSafeAdoption(candidate, true)),
		).toBe(false);
	});

	it('treats only identical filters as safe when usage is incomplete', () => {
		const [identical, unused] = planSavedFilterAdoptions(
			[
				{ id: 'a', name: 'Alpha', targeting_rules: rules(['x']) },
				{ id: 'b', name: 'Bravo', targeting_rules: rules(['x']) },
			],
			[
				{ id: 'target-a', name: 'Alpha', targeting_rules: rules(['x']) },
				{ id: 'target-b', name: 'Bravo', targeting_rules: rules(['z']) },
			],
			new Map(),
		);
		expect(isSafeAdoption(identical, false)).toBe(true);
		expect(isSafeAdoption(unused, false)).toBe(false);
		expect(isSafeAdoption(unused, true)).toBe(true);
	});
});

describe('migrateDatadogSavedFilters', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
		mock.onGet(SOURCE_LIST).reply(200, {
			data: [
				jsonApiFilter({
					id: 'source-new',
					name: 'Beta users',
					description: 'Early access',
					creation_type: 'RULES',
					targeting_rules: betaRules,
				}),
				jsonApiFilter({
					id: 'source-existing',
					name: 'Internal users',
					creation_type: 'RULES',
					targeting_rules: betaRules,
				}),
				jsonApiFilter({
					id: 'source-conflict',
					name: 'Shared name',
					creation_type: 'LIST',
					targeting_rules: betaRules,
				}),
				jsonApiFilter({
					id: 'source-unreferenced',
					name: 'Unused',
					creation_type: 'RULES',
					targeting_rules: betaRules,
				}),
			],
			meta: { total: 4 },
		});
		mock.onGet(`${SOURCE_LIST}/source-archived`).reply(200, {
			data: jsonApiFilter({
				id: 'source-archived',
				name: 'Archived filter',
				creation_type: 'RULES',
				targeting_rules: betaRules,
			}),
		});
		mock.onGet(TARGET_LIST).reply(200, {
			data: [
				jsonApiFilter({
					id: 'target-existing',
					name: 'Internal users',
					migration_metadata: {
						provider: 'datadog',
						source_id: 'source-existing',
						source_site: 'source.example',
					},
				}),
				jsonApiFilter({ id: 'target-shared', name: 'Shared name' }),
			],
			meta: { total: 2 },
		});
	});

	afterEach(() => {
		mock.restore();
	});

	const refs = [
		'source-new',
		'source-existing',
		'source-conflict',
		'source-archived',
	];

	it('creates new filters, updates copied ones, and skips conflicts', async () => {
		let createdIndex = 0;
		mock
			.onPost(TARGET_LIST)
			.reply(() => [201, { data: { id: `target-created-${createdIndex++}` } }]);
		mock.onPut(`${TARGET_LIST}/target-existing`).reply(200, {});

		const result = await migrateDatadogSavedFilters({
			pair,
			refs,
			dryRun: false,
			nonInteractive: true,
		});

		expect(mock.history.get[0].params).toEqual({
			offset: 0,
			include_rules: true,
		});
		const posts = mock.history.post.map((request) => JSON.parse(request.data));
		expect(posts).toEqual([
			{
				data: {
					type: 'saved-filters',
					attributes: {
						name: 'Beta users',
						description: 'Early access',
						creation_type: 'RULES',
						targeting_rules: [
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'id', value: ['user-a'] },
								],
							},
						],
						migration_metadata: {
							provider: 'datadog',
							source_id: 'source-new',
							source_site: 'source.example',
						},
					},
				},
			},
			expect.objectContaining({
				data: expect.objectContaining({
					attributes: expect.objectContaining({ name: 'Archived filter' }),
				}),
			}),
		]);
		expect(mock.history.put).toHaveLength(1);
		expect(JSON.parse(mock.history.put[0].data).data.attributes.name).toBe(
			'Internal users',
		);
		expect(result.savedFilterIdMap).toEqual(
			new Map([
				['source-new', 'target-created-0'],
				['source-archived', 'target-created-1'],
				['source-existing', 'target-existing'],
			]),
		);
		expect(result.stats).toMatchObject({
			discovered: 4,
			created: 2,
			reused: 1,
			updated: 1,
			skipped: 1,
		});
		expect(
			mock.history.get.map((request) => request.headers?.['dd-api-key']),
		).toEqual(['source-api', 'target-api', 'source-api']);
	});

	it('plans requests without writing during a dry run', async () => {
		const result = await migrateDatadogSavedFilters({
			pair,
			refs,
			dryRun: true,
			nonInteractive: true,
		});

		expect(mock.history.post).toHaveLength(0);
		expect(mock.history.put).toHaveLength(0);
		expect(
			result.dryRunRequests.map(
				(request) => `${request.method} ${request.path}`,
			),
		).toEqual([
			'POST /api/v2/feature-flags/saved-filters',
			'POST /api/v2/feature-flags/saved-filters',
			'PUT /api/v2/feature-flags/saved-filters/target-existing',
		]);
		expect(result.savedFilterIdMap.get('source-new')).toBe(
			'dry-run-saved-filter-0',
		);
		expect(result.savedFilterIdMap.get('source-existing')).toBe(
			'target-existing',
		);
		expect(result.savedFilterIdMap.has('source-conflict')).toBe(false);
	});

	it('skips dependent flags when a reused filter update is denied', async () => {
		mock.onPut(`${TARGET_LIST}/target-existing`).reply(403, {
			errors: ['permission denied'],
		});

		const result = await migrateDatadogSavedFilters({
			pair,
			refs: ['source-existing'],
			dryRun: false,
			nonInteractive: true,
		});

		expect(result.savedFilterIdMap.has('source-existing')).toBe(false);
		expect(result.stats.updated).toBe(0);
		expect(result.stats.failures).toEqual([
			expect.objectContaining({ savedFilterId: 'source-existing' }),
		]);
		expect(
			buildDatadogAllocations(
				{
					id: 'flag',
					key: 'flag',
					name: 'Flag',
					variants: [{ id: 'on', key: 'on', name: 'On', value: 'true' }],
					environments: [
						{
							environmentId: 'source-prod',
							status: 'ENABLED',
							allocations: [
								{
									key: 'beta',
									variant_weights: [{ variant_id: 'on', value: 100 }],
									targeting_rules: [
										{ conditions: [{ saved_filter_id: 'source-existing' }] },
									],
								},
							],
						},
					],
				},
				new Map([
					[
						'source-prod',
						[
							{
								id: 'target-prod',
								name: 'Production',
								queries: ['prod'],
								is_production: true,
							},
						],
					],
				]),
				result.savedFilterIdMap,
			),
		).toEqual({
			flagSkip: 'Saved filter source-existing could not be migrated',
		});
	});

	it.each([
		false,
		true,
	])('does not reuse stale targeting when source rules are unavailable (dryRun=%s)', async (dryRun) => {
		mock.onGet(SOURCE_LIST).reply(200, {
			data: [
				jsonApiFilter({
					id: 'source-existing',
					name: 'Internal users',
					targeting_rules: [],
				}),
			],
			meta: { total: 1 },
		});
		const result = await migrateDatadogSavedFilters({
			pair,
			refs: ['source-existing'],
			dryRun,
			nonInteractive: true,
		});

		expect(result.savedFilterIdMap.has('source-existing')).toBe(false);
		expect(result.stats).toMatchObject({ updated: 0, skipped: 1 });
		expect(mock.history.put).toHaveLength(0);
		expect(result.dryRunRequests).toHaveLength(0);
	});

	it('returns an empty result when no filters are referenced', async () => {
		const result = await migrateDatadogSavedFilters({
			pair,
			refs: [],
			dryRun: false,
		});
		expect(result.savedFilterIdMap.size).toBe(0);
		expect(mock.history.get).toHaveLength(0);
	});
});
