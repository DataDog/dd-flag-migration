import fs from 'node:fs';
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
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
} from '../../src/datadog/types.js';

const answers: string[] = [];
const prompts: string[] = [];
const outcomes: Array<{ status: string; message: string }> = [];

jest.unstable_mockModule('../../src/components/Select.js', () => ({
	select: async ({ message }: { message: string }) => {
		prompts.push(message);
		const answer = answers.shift();
		if (answer === undefined) throw new Error(`Unexpected prompt: ${message}`);
		return answer;
	},
}));
jest.unstable_mockModule('../../src/components/Input.js', () => ({
	input: async () => 'copy',
}));
jest.unstable_mockModule('../../src/components/MigrationRunner.js', () => ({
	migrationRunner: () => ({
		beginFlag: () => undefined,
		printMessage: () => undefined,
		finalize: () => undefined,
		settleFlag: (result: { status: string; message: string }) =>
			outcomes.push(result),
	}),
}));
jest.unstable_mockModule('../../src/datadog-migration/environments.js', () => ({
	selectSourceEnvironments: async (environments: DatadogEnvironment[]) =>
		environments,
	linkDatadogEnvironments: async (
		_source: DatadogEnvironment[],
		target: DatadogEnvironment[],
	) => new Map([['source-prod', target]]),
	resolveDatadogEnvMap: () => {
		throw new Error('Unexpected non-interactive invocation');
	},
}));
jest.unstable_mockModule(
	'../../src/datadog-migration/flag-selection.js',
	() => ({
		selectDatadogFlags: async ({
			choices,
		}: {
			choices: Array<{ value: DatadogFlagEntry }>;
		}) => choices.map((choice) => choice.value),
	}),
);

const { default: MockAdapter } = await import('axios-mock-adapter');
const { ddClient } = await import('../../src/datadog/api.js');
const { runDatadogMigration } = await import(
	'../../src/datadog-migration/migrate.js'
);

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

type SkipCause = 'experiment' | 'missing-filter' | 'filter-write-failure';

function filter(id: string, name: string) {
	return {
		id,
		attributes: {
			name,
			creation_type: 'RULES',
			targeting_rules: [
				{
					conditions: [{ operator: 'ONE_OF', attribute: 'id', value: [id] }],
				},
			],
		},
	};
}

describe('saved filter adoption before flag migration', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		answers.length = 0;
		prompts.length = 0;
		outcomes.length = 0;
		mock = new MockAdapter(ddClient as never);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
		jest.spyOn(process.stdout, 'write').mockReturnValue(true);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true);
	});

	afterEach(() => {
		mock.restore();
		jest.restoreAllMocks();
		process.exitCode = undefined;
	});

	function inventory(cause: SkipCause) {
		for (const [base, org] of [
			[sourceBase, 'source'],
			[targetBase, 'target'],
		] as const) {
			mock.onGet(base).reply(200, {
				data: [
					{ id: `${org}-flag`, attributes: { key: 'config', name: 'Config' } },
				],
				meta: { page: { total: 1 } },
			});
			mock.onGet(`${base}/environments`).reply(200, {
				data: [
					{
						id: `${org}-prod`,
						attributes: {
							name: 'Production',
							is_production: true,
							queries: ['prod'],
						},
					},
				],
			});
			mock.onGet(`${base}/${org}-flag`).reply(200, {
				data: {
					id: `${org}-flag`,
					attributes: {
						key: 'config',
						name: 'Config',
						value_type: 'BOOLEAN',
						variants: [
							{ id: `${org}-variant`, key: 'on', name: 'On', value: 'true' },
						],
						feature_flag_environments: [
							{
								environment_id: `${org}-prod`,
								status: 'ENABLED',
								allocations: [
									{
										key: 'rule',
										type: 'FEATURE_GATE',
										...(org === 'source' && cause === 'experiment'
											? { experiment_id: 'source-experiment' }
											: {}),
										targeting_rules: [
											{
												conditions: [
													{ saved_filter_id: `${org}-filter` },
													...(org === 'source' && cause !== 'experiment'
														? [{ saved_filter_id: 'source-unavailable' }]
														: []),
												],
											},
										],
										variant_weights: [
											{ variant_id: `${org}-variant`, value: 100 },
										],
									},
								],
							},
						],
					},
				},
			});
			const filters = [filter(`${org}-filter`, 'Shared')];
			if (org === 'source' && cause === 'filter-write-failure') {
				filters.push(filter('source-unavailable', 'Unavailable'));
			}
			mock.onGet(`${base}/saved-filters`).reply(200, {
				data: filters,
				meta: { total: filters.length },
			});
			mock.onGet(`${base}/saved-filters/${org}-filter`).reply(200, {
				data: filter(`${org}-filter`, 'Shared'),
			});
		}
		mock.onGet(`${sourceBase}/saved-filters/source-unavailable`).reply(404);
		mock.onPut(`${targetBase}/saved-filters/target-filter`).reply(200, {});
		mock
			.onPost(`${targetBase}/saved-filters`)
			.reply((request) =>
				JSON.parse(request.data).data.attributes.name === 'copy-Shared'
					? [201, { data: { id: 'prefixed-copy' } }]
					: [403, { errors: ['permission denied'] }],
			);
	}

	it.each([
		{ cause: 'experiment', dryRun: false },
		{ cause: 'experiment', dryRun: true },
		{ cause: 'missing-filter', dryRun: false },
		{ cause: 'missing-filter', dryRun: true },
		{ cause: 'filter-write-failure', dryRun: false },
	] as const)("does not overwrite a selected flag's filter before it is skipped: %j", async ({
		cause,
		dryRun,
	}) => {
		inventory(cause);
		answers.push('migrate', 'adopt', 'safe-prefix');

		await runDatadogMigration(pair, dryRun, { tagMode: 'replace' });

		expect(prompts).toContain('Which saved filters should be adopted?');
		expect(answers).toHaveLength(0);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].status).toBe('skipped');
		expect(outcomes[0].message).toContain(
			cause === 'experiment'
				? 'experiment'
				: 'source-unavailable could not be migrated',
		);
		expect(mock.history.put).toHaveLength(0);
		if (dryRun) {
			expect(mock.history.post).toHaveLength(0);
			const report = JSON.parse(
				String(jest.mocked(fs.writeFileSync).mock.calls[0][1]),
			);
			expect(report.requests).toHaveLength(1);
			expect(report.requests[0]).toMatchObject({
				method: 'POST',
				path: '/api/v2/feature-flags/saved-filters',
				body: { data: { attributes: { name: 'copy-Shared' } } },
			});
		} else {
			expect(
				mock.history.post.some(
					(request) =>
						JSON.parse(request.data).data.attributes.name === 'copy-Shared',
				),
			).toBe(true);
		}
	});
});
