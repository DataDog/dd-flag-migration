/**
 * Interactive Eppo migrations ask for a default variant when Eppo's
 * production environment has none.
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
import type { EppoFlag } from '../../src/eppo/types.js';

const DD_SITE = 'test.invalid';
const DD_BASE = `https://api.${DD_SITE}`;
const EPPO_BASE = 'https://eppo.cloud';
const FLAG_ID = 'dd-flag-1';
const DEFAULT_PROMPT =
	'Choose the variant that matches the fallback value in your code:';

/** Answers to default-variant prompts, in order; null skips the flag. */
const defaultAnswers: Array<string | null> = [];
const prompts: Array<{ message: string; choices: unknown[] }> = [];

jest.unstable_mockModule('../../src/components/Select.js', () => ({
	select: async ({
		message,
		choices,
	}: {
		message: string;
		choices: unknown[];
	}) => {
		prompts.push({ message, choices });
		if (message === DEFAULT_PROMPT) {
			if (defaultAnswers.length === 0) throw new Error('Unexpected prompt');
			return defaultAnswers.shift();
		}
		if (message.startsWith('Migrate ')) return 'migrate';
		throw new Error(`Unexpected prompt: ${message}`);
	},
}));
jest.unstable_mockModule('../../src/components/FilterableCheckbox.js', () => ({
	filterableCheckbox: async ({
		message,
		choices,
	}: {
		message: string;
		choices: Array<{ value: unknown }>;
	}) =>
		// Link each Eppo environment to the first Datadog environment left.
		message.startsWith('Select matching')
			? [choices[0].value]
			: choices.map((choice) => choice.value),
}));
jest.unstable_mockModule('../../src/components/Confirm.js', () => ({
	confirm: async () => false,
}));

const { ddClient } = await import('../../src/datadog/api.js');
const { eppoClient } = await import('../../src/eppo/api.js');
const { runEppoMigration } = await import('../../src/eppo/migrate.js');

function eppoFlag(): EppoFlag {
	return {
		id: 1,
		key: 'checkout-redesign',
		name: 'Checkout Redesign',
		variation_type: 'BOOLEAN',
		tag_names: [],
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		variations: [
			{ id: 100, name: 'On', variant_key: 'true', is_active: true },
			{ id: 200, name: 'Off', variant_key: 'false', is_active: true },
		],
		environments: [
			{ id: 10, name: 'Production', active: true, is_production: true },
			{ id: 20, name: 'Staging', active: true, is_production: false },
		],
		// Only internal users are targeted; nobody else has a default.
		allocations: [
			{
				id: 7001,
				key: 'internal-users',
				name: 'Internal users',
				environment_id: 10,
				type: 'FEATURE_GATE',
				enabled: true,
				percent_exposure: 1,
				is_default: false,
				variation_weight: [{ id: 901, variation_id: 100, weight: 100 }],
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'team', values: ['internal'] },
						],
					},
				],
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

describe('interactive Eppo migration without a production default', () => {
	let ddMock: AxiosMockAdapter;
	let eppoMock: AxiosMockAdapter;

	beforeEach(() => {
		ddMock = new AxiosMockAdapter(ddClient as never);
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		defaultAnswers.length = 0;
		prompts.length = 0;
		process.env.EPPO_API_KEY = 'eppo-api-key';
		jest.spyOn(process.stdout, 'write').mockReturnValue(true as never);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
	});

	afterEach(() => {
		ddMock.restore();
		eppoMock.restore();
		jest.restoreAllMocks();
		delete process.env.EPPO_API_KEY;
	});

	function mockSources(existing?: Record<string, unknown>): void {
		eppoMock
			.onGet(`${EPPO_BASE}/api/v1/feature-flags`)
			.reply(200, [eppoFlag()]);
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
					variants: [
						{
							id: 'on-id',
							key: 'on',
							name: 'On',
							value: 'true',
							migration_metadata: { provider: 'eppo', source_id: '100' },
						},
						{
							id: 'off-id',
							key: 'off',
							name: 'Off',
							value: 'false',
							migration_metadata: { provider: 'eppo', source_id: '200' },
						},
					],
					feature_flag_environments: [],
				},
			},
		});
		ddMock.onPost(`${DD_BASE}/api/v2/feature-flags`).reply(201, {
			data: { id: FLAG_ID, attributes: { key: 'checkout-redesign' } },
		});
		ddMock.onPut(/.*/).reply(200, {});
		ddMock.onPost(/.*/).reply(200, {});
	}

	async function run(): Promise<void> {
		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			tagMode: 'replace',
		});
	}

	function createRequest(): Record<string, unknown> | undefined {
		const post = ddMock.history.post.find(
			(r) => r.url === `${DD_BASE}/api/v2/feature-flags`,
		);
		return post ? JSON.parse(post.data as string).data.attributes : undefined;
	}

	it('creates the flag with the chosen default for every environment without one', async () => {
		mockSources();
		defaultAnswers.push('off');
		await run();

		const defaultPrompts = prompts.filter((p) => p.message === DEFAULT_PROMPT);
		expect(defaultPrompts).toHaveLength(1);
		expect(defaultPrompts[0].choices).toEqual([
			{ name: 'On', value: 'on', description: 'true' },
			{ name: 'Off', value: 'off', description: 'false' },
			{ name: 'Skip this flag', value: null },
		]);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining('Unmatched subjects in Production, Staging'),
		);
		expect(createRequest()).toMatchObject({
			bucketing_mode: 'EPPO',
			default_variant_key: 'off',
		});
		// Staging's default equals the flag-level one, so no extra sync is needed.
		expect(
			ddMock.history.put.filter((r) => r.url?.endsWith('/allocations')),
		).toEqual([]);
		expect(ddMock.history.post.map((r) => r.url)).toEqual(
			expect.arrayContaining([
				`${DD_BASE}/api/v2/feature-flags/${FLAG_ID}/environments/dd-prod/enable`,
				`${DD_BASE}/api/v2/feature-flags/${FLAG_ID}/environments/dd-staging/enable`,
			]),
		);
	});

	it('skips the flag without writing when the user skips it', async () => {
		mockSources();
		defaultAnswers.push(null);
		await run();

		expect(createRequest()).toBeUndefined();
		expect(ddMock.history.put).toHaveLength(0);
	});

	it('asks again for a flag migrated before Eppo bucketing', async () => {
		mockSources({
			key: 'checkout-redesign',
			name: 'Checkout Redesign',
			bucketing_mode: 'DATADOG',
			migration_metadata: { provider: 'eppo', source_id: '1' },
		});
		defaultAnswers.push('off');
		await run();

		expect(prompts.filter((p) => p.message === DEFAULT_PROMPT)).toHaveLength(1);
		const syncs = ddMock.history.put.filter((r) =>
			r.url?.endsWith('/allocations'),
		);
		expect(syncs.map((r) => r.params)).toEqual([
			{ default_variant_key: 'off' },
			{ default_variant_key: 'off' },
		]);
	});

	it('automatically restores an archived Eppo flag without an additional prompt', async () => {
		mockSources({
			key: 'checkout-redesign',
			name: 'Checkout Redesign',
			archived_at: '2026-10-22T00:00:00Z',
			bucketing_mode: 'EPPO',
			migration_metadata: { provider: 'eppo', source_id: '1' },
		});

		await run();

		expect(prompts.map((prompt) => prompt.message)).toEqual([
			'Migrate 1 flag(s) to Datadog?',
		]);
		expect(ddMock.history.post[0].url).toBe(
			`${DD_BASE}/api/v2/feature-flags/${FLAG_ID}/unarchive`,
		);
		expect(createRequest()).toBeUndefined();
		expect(
			ddMock.history.put.filter((request) =>
				request.url?.endsWith('/allocations'),
			),
		).toHaveLength(2);
	});

	it('does not ask about an EPPO flag, which keeps its Datadog defaults', async () => {
		mockSources({
			key: 'checkout-redesign',
			name: 'Checkout Redesign',
			bucketing_mode: 'EPPO',
			migration_metadata: { provider: 'eppo', source_id: '1' },
		});
		await run();

		expect(prompts.filter((p) => p.message === DEFAULT_PROMPT)).toHaveLength(0);
		const syncs = ddMock.history.put.filter((r) =>
			r.url?.endsWith('/allocations'),
		);
		expect(syncs).toHaveLength(2);
		expect(syncs.every((r) => r.params === undefined)).toBe(true);
	});
});
