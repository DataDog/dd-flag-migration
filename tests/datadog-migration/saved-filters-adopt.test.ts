import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import type AxiosMockAdapter from 'axios-mock-adapter';
import type { DatadogOrgPair } from '../../src/datadog/orgs.js';
import type { DatadogFlagEntry } from '../../src/datadog/types.js';

const selectAnswers: string[] = [];
const selectMessages: string[] = [];

jest.unstable_mockModule('../../src/components/Select.js', () => ({
	select: async (opts: { message: string }) => {
		selectMessages.push(opts.message);
		const answer = selectAnswers.shift();
		if (answer === undefined) throw new Error(`Unexpected: ${opts.message}`);
		return answer;
	},
}));
jest.unstable_mockModule('../../src/components/Input.js', () => ({
	input: async () => 'copy',
}));

const { default: MockAdapter } = await import('axios-mock-adapter');
const { ddClient } = await import('../../src/datadog/api.js');
const { migrateDatadogSavedFilters } = await import(
	'../../src/datadog-migration/saved-filters.js'
);

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
const TARGET_FLAGS = 'https://api.target.example/api/v2/feature-flags';

const sourceRules = [
	{ conditions: [{ operator: 'ONE_OF', attribute: 'id', value: ['user-a'] }] },
];
const targetRules = [
	{ conditions: [{ operator: 'ONE_OF', attribute: 'id', value: ['user-b'] }] },
];

function jsonApiFilter(filter: {
	id: string;
	name: string;
	targeting_rules?: unknown[];
}) {
	const { id, ...attributes } = filter;
	return {
		id,
		type: 'saved-filters',
		attributes: { creation_type: 'RULES', ...attributes },
	};
}

function targetFlagDetail(id: string, environmentId: string, filterId: string) {
	return {
		data: {
			id,
			attributes: {
				key: `${id}-key`,
				name: id,
				variants: [{ id: 'on', key: 'on', name: 'On', value: 'true' }],
				feature_flag_environments: [
					{
						environment_id: environmentId,
						status: 'ENABLED',
						allocations: [
							{
								key: 'rule',
								targeting_rules: [
									{ conditions: [{ saved_filter_id: filterId }] },
								],
								variant_weights: [{ variant_id: 'on', value: 100 }],
							},
						],
					},
				],
			},
		},
	};
}

const targetFlags: DatadogFlagEntry[] = [
	{ id: 'migrated-flag', key: 'migrated-flag-key' },
	{ id: 'unrelated-flag', key: 'unrelated-flag-key' },
];

describe('migrateDatadogSavedFilters adoption', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		selectAnswers.length = 0;
		selectMessages.length = 0;
		mock = new MockAdapter(ddClient as never);
		mock.onGet(SOURCE_LIST).reply(200, {
			data: [
				jsonApiFilter({
					id: 'source-shared',
					name: 'Shared name',
					targeting_rules: sourceRules,
				}),
			],
			meta: { total: 1 },
		});
		mock.onGet(TARGET_LIST).reply(200, {
			data: [jsonApiFilter({ id: 'target-shared', name: 'Shared name' })],
			meta: { total: 1 },
		});
		mock.onGet(`${TARGET_LIST}/target-shared`).reply(200, {
			data: jsonApiFilter({
				id: 'target-shared',
				name: 'Shared name',
				targeting_rules: targetRules,
			}),
		});
		mock
			.onGet(`${TARGET_FLAGS}/migrated-flag`)
			.reply(
				200,
				targetFlagDetail('migrated-flag', 'target-prod', 'target-shared'),
			);
	});

	afterEach(() => {
		mock.restore();
	});

	function useUnrelatedFlag(filterId: string) {
		mock
			.onGet(`${TARGET_FLAGS}/unrelated-flag`)
			.reply(200, targetFlagDetail('unrelated-flag', 'target-prod', filterId));
	}

	function run(dryRun = false) {
		return migrateDatadogSavedFilters({
			pair,
			refs: ['source-shared'],
			dryRun,
			adoption: {
				targetFlags,
				rewrittenTargeting: new Map([
					['migrated-flag', new Set(['target-prod'])],
				]),
			},
		});
	}

	it('adopts a filter used only by flags this run rewrites without asking again', async () => {
		useUnrelatedFlag('another-filter');
		mock.onPut(`${TARGET_LIST}/target-shared`).reply(200, {});
		selectAnswers.push('adopt');

		const result = await run();

		expect(selectMessages).toHaveLength(1);
		expect(JSON.parse(mock.history.put[0].data).data.attributes).toEqual({
			name: 'Shared name',
			creation_type: 'RULES',
			targeting_rules: sourceRules,
			migration_metadata: {
				provider: 'datadog',
				source_id: 'source-shared',
				source_site: 'source.example',
			},
		});
		expect(result.savedFilterIdMap).toEqual(
			new Map([['source-shared', 'target-shared']]),
		);
		expect(result.stats).toMatchObject({ adopted: 1, skipped: 0 });
	});

	it('skips a filter used by other flags when only safe filters are adopted', async () => {
		useUnrelatedFlag('target-shared');
		selectAnswers.push('adopt', 'safe-skip');

		const result = await run();

		expect(selectMessages).toEqual([
			'How would you like to handle these conflicts?',
			'Which saved filters should be adopted?',
		]);
		expect(mock.history.put).toHaveLength(0);
		expect(result.savedFilterIdMap.size).toBe(0);
		expect(result.stats).toMatchObject({ adopted: 0, skipped: 1 });
	});

	it('prefixes a filter used by other flags when asked', async () => {
		useUnrelatedFlag('target-shared');
		mock.onPost(TARGET_LIST).reply(201, { data: { id: 'target-created' } });
		selectAnswers.push('adopt', 'safe-prefix');

		const result = await run();

		expect(mock.history.put).toHaveLength(0);
		expect(JSON.parse(mock.history.post[0].data).data.attributes.name).toBe(
			'copy-Shared name',
		);
		expect(result.savedFilterIdMap.get('source-shared')).toBe('target-created');
	});

	it('adopts a filter used by other flags when the user confirms', async () => {
		useUnrelatedFlag('target-shared');
		mock.onPut(`${TARGET_LIST}/target-shared`).reply(200, {});
		selectAnswers.push('adopt', 'all');

		const result = await run();

		expect(mock.history.put).toHaveLength(1);
		expect(result.stats.adopted).toBe(1);
	});

	it('only adopts identical filters when target flags cannot be checked', async () => {
		mock.onGet(`${TARGET_FLAGS}/unrelated-flag`).reply(500);
		selectAnswers.push('adopt', 'safe-skip');

		const result = await run();

		expect(mock.history.put).toHaveLength(0);
		expect(result.stats).toMatchObject({ adopted: 0, skipped: 1 });
	});

	it('plans the adoption without writing during a dry run', async () => {
		useUnrelatedFlag('another-filter');
		selectAnswers.push('adopt');

		const result = await run(true);

		expect(mock.history.put).toHaveLength(0);
		expect(
			result.dryRunRequests.map(
				(request) => `${request.method} ${request.path}`,
			),
		).toEqual(['PUT /api/v2/feature-flags/saved-filters/target-shared']);
		expect(result.savedFilterIdMap.get('source-shared')).toBe('target-shared');
		expect(result.stats.adopted).toBe(1);
	});
});
