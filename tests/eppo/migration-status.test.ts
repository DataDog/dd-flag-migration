import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogStatusFlagDetail,
} from '../../src/datadog/types.js';
import type { EppoFlag } from '../../src/eppo/types.js';
import {
	compareEppoMigrationStatus,
	linkEppoFlags,
} from '../../src/migration-status/eppo-comparison.js';
import type { EppoMigrationStatusComparisonInput } from '../../src/migration-status/types.js';
import { writeMigrationStatusWorkbook } from '../../src/migration-status/xlsx.js';

const target: DatadogEnvironment = {
	id: 'dd-prod',
	name: 'Production',
	is_production: true,
	queries: [],
};
const source: EppoFlag = {
	id: 42,
	key: 'checkout',
	name: 'Checkout',
	variation_type: 'BOOLEAN',
	tag_names: [],
	created_at: '',
	updated_at: '',
	variations: [
		{ id: 1, name: 'On', variant_key: 'true' },
		{ id: 2, name: 'Off', variant_key: 'false' },
	],
	environments: [
		{ id: 10, name: 'Production', active: true, is_production: true },
	],
	allocations: [
		{
			id: 100,
			key: 'targeted',
			name: 'Targeted',
			environment_id: 10,
			type: 'FEATURE_GATE',
			percent_exposure: 0.5,
			is_default: false,
			variation_weight: [
				{ id: 1000, variation_id: 1, weight: 60 },
				{ id: 1001, variation_id: 2, weight: 40 },
			],
			targeting_rules: [
				{
					conditions: [
						{ attribute: 'country', operator: 'ONE_OF', values: ['US'] },
					],
				},
			],
		},
		{
			id: 101,
			key: 'default',
			name: 'Default',
			environment_id: 10,
			type: 'FEATURE_GATE',
			percent_exposure: 1,
			is_default: true,
			variation_weight: [{ id: 1002, variation_id: 2, weight: 100 }],
			targeting_rules: [],
		},
	],
};
const entry: DatadogFlagEntry = {
	id: 'dd-flag',
	key: source.key,
	bucketing_mode: 'EPPO',
	migration_metadata: { provider: 'eppo', source_id: '42' },
};
const detail: DatadogStatusFlagDetail = {
	id: entry.id,
	key: source.key,
	name: source.name,
	bucketingMode: 'EPPO',
	variants: [
		{
			id: 'dd-on',
			key: 'on',
			name: 'On',
			value: 'true',
			migration_metadata: { provider: 'eppo', source_id: '1' },
		},
		{
			id: 'dd-off',
			key: 'off',
			name: 'Off',
			value: 'false',
			migration_metadata: { provider: 'eppo', source_id: '2' },
		},
	],
	environments: [
		{
			environmentId: target.id,
			status: 'ENABLED',
			defaultVariantKey: 'off',
			allocations: [
				{
					key: 'targeted',
					type: 'FEATURE_GATE',
					eppo_allocation_id: 100,
					targeting_rules: [
						{
							conditions: [
								{ attribute: 'country', operator: 'ONE_OF', value: ['US'] },
							],
						},
					],
					variant_weights: [
						{ variant_id: 'dd-off', value: 40, eppo_variant_weight_id: 1001 },
						{ variant_id: 'dd-on', value: 60, eppo_variant_weight_id: 1000 },
					],
					exposure_schedule: {
						id: 'schedule',
						created_at: '2026-01-01',
						rollout_options: { strategy: 'NO_ROLLOUT' },
						rollout_steps: [{ id: 'step', exposure_ratio: 0.5 }],
					},
				},
			],
		},
	],
};
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error('Missing test fixture');
	return value;
}

function input(): EppoMigrationStatusComparisonInput {
	return {
		sourceFlags: [structuredClone(source)],
		datadogFlags: [structuredClone(entry)],
		datadogDetails: new Map([[entry.id, structuredClone(detail)]]),
		sourceDetailErrors: new Map(),
		datadogDetailErrors: new Map(),
		selectedSourceEnvironments: structuredClone(required(source.environments)),
		environmentMapping: new Map([[10, [target]]]),
	};
}
function compare(config = input()) {
	return compareEppoMigrationStatus(config).flags[0];
}
function actual(config: EppoMigrationStatusComparisonInput) {
	return required(config.datadogDetails.get(entry.id));
}

describe('Eppo migration status', () => {
	it('matches defaults, targeting, raw weights, exposure and Eppo IDs', () => {
		expect(compare()).toMatchObject({
			status: 'in-sync',
			environments: [{ status: 'in-sync' }],
		});
	});
	it('reports an unmigrated flag', () => {
		const config = input();
		config.datadogFlags = [];
		expect(compare(config).status).toBe('not-yet-migrated');
	});
	it('reports a missing mapped environment as partially migrated', () => {
		const config = input();
		actual(config).environments = [];
		expect(compare(config)).toMatchObject({
			status: 'partially-migrated',
			environments: [{ status: 'not-migrated' }],
		});
	});
	it.each([
		'source',
		'datadog',
		'missing',
	])('handles %s detail collection failures', (kind) => {
		const config = input();
		if (kind === 'source')
			config.sourceDetailErrors = new Map([[source.key, 'source failed']]);
		if (kind === 'datadog')
			config.datadogDetailErrors = new Map([[entry.id, 'target failed']]);
		if (kind === 'missing') config.datadogDetails = new Map();
		expect(compare(config).status).toBe('needs-review');
	});
	it.each([
		'variations',
		'environments',
		'allocations',
	] as const)('does not treat missing Eppo %s as an empty configuration', (field) => {
		const config = input();
		delete config.sourceFlags[0][field];
		expect(compare(config).status).toBe('needs-review');
	});
	it.each([
		'conflict',
		'duplicate',
		'renamed',
		'wrong-id',
	] as const)('requires review for %s identity', (kind) => {
		const config = input();
		if (kind === 'conflict')
			config.datadogFlags[0].migration_metadata = { provider: 'launchdarkly' };
		if (kind === 'duplicate')
			config.datadogFlags.push({ ...entry, id: 'duplicate' });
		if (kind === 'renamed') config.datadogFlags[0].key = 'old-key';
		if (kind === 'wrong-id')
			required(config.datadogFlags[0].migration_metadata).source_id = '999';
		expect(compare(config)).toMatchObject({
			status: 'needs-review',
			flagWideChanges: ['identity'],
		});
	});
	it('prefers stable metadata over a same-key unrelated flag', () => {
		expect(
			linkEppoFlags([source], [{ id: 'native', key: source.key }, entry])[0]
				.datadog?.id,
		).toBe(entry.id);
	});
	it.each([
		'name',
		'variants',
		'enablement',
		'default',
		'targeting',
		'exposure',
		'allocation-id',
		'weight-id',
		'override',
	])('detects %s changes', (kind) => {
		const config = input();
		const dd = actual(config);
		const env = dd.environments[0];
		const allocation = required(env.allocations)[0];
		if (kind === 'name') dd.name = 'Old checkout';
		if (kind === 'variants') dd.variants[0].value = 'false';
		if (kind === 'enablement') env.status = 'DISABLED';
		if (kind === 'default') env.defaultVariantKey = 'on';
		if (kind === 'targeting') allocation.targeting_rules = [];
		if (kind === 'exposure') allocation.exposure_schedule = null;
		if (kind === 'allocation-id') allocation.eppo_allocation_id = 999;
		if (kind === 'weight-id')
			required(allocation.variant_weights)[0].eppo_variant_weight_id = 999;
		if (kind === 'override') env.overrideVariantKey = 'on';
		expect(compare(config).status).toBe('out-of-sync');
	});
	it('preserves variant keys after a source-side rename and accepts collision-resolved flag names', () => {
		const config = input();
		required(config.sourceFlags[0].variations)[0].name = 'Enabled';
		actual(config).variants[0].name = 'Enabled';
		actual(config).name = 'Checkout (2)';
		expect(compare(config).status).toBe('in-sync');
	});
	it('compares wrapped JSON arrays semantically', () => {
		const config = input();
		config.sourceFlags[0].variation_type = 'JSON';
		required(config.sourceFlags[0].variations)[0].variant_key = '[1,2]';
		actual(config).variants[0].value = '{ "value": [1, 2] }';
		expect(compare(config).status).toBe('in-sync');
	});
	it('ignores unmapped source and target environments', () => {
		const config = input();
		required(config.sourceFlags[0].environments).push({
			id: 20,
			name: 'Staging',
			active: false,
			is_production: false,
		});
		actual(config).environments.push({
			environmentId: 'unselected',
			status: 'DISABLED',
			allocations: [],
		});
		expect(compare(config).status).toBe('in-sync');
	});
	it('handles one-to-many mappings without treating suffixed keys as drift', () => {
		const config = input();
		config.environmentMapping.set(10, [
			target,
			{ ...target, id: 'dd-prod-2', name: 'Prod 2' },
		]);
		const second = structuredClone(actual(config).environments[0]);
		second.environmentId = 'dd-prod-2';
		required(second.allocations)[0].key = 'targeted-prod-2';
		actual(config).environments.push(second);
		expect(compare(config).environments.map((env) => env.status)).toEqual([
			'in-sync',
			'in-sync',
		]);
	});
	it('checks targeting even when both environments are disabled', () => {
		const config = input();
		required(config.sourceFlags[0].environments)[0].active = false;
		actual(config).environments[0].status = 'DISABLED';
		expect(compare(config).status).toBe('in-sync');
		actual(config).environments[0].allocations = [];
		expect(compare(config).status).toBe('out-of-sync');
	});
	it('supports no default and reports an existing default that cannot be cleared', () => {
		const config = input();
		required(config.sourceFlags[0].allocations).pop();
		delete actual(config).environments[0].defaultVariantKey;
		expect(compare(config).status).toBe('in-sync');
		actual(config).environments[0].defaultVariantKey = 'off';
		expect(compare(config).environments[0].details).toContain('cannot clear');
	});
	it('compares legacy migrations without Eppo IDs but preserves allocation keys', () => {
		const config = input();
		config.datadogFlags[0].bucketing_mode = 'DATADOG';
		actual(config).bucketingMode = 'DATADOG';
		const allocation = required(actual(config).environments[0].allocations)[0];
		delete allocation.eppo_allocation_id;
		for (const weight of required(allocation.variant_weights))
			delete weight.eppo_variant_weight_id;
		expect(compare(config).status).toBe('in-sync');
		allocation.key = 'different-salt';
		expect(compare(config).status).toBe('out-of-sync');
	});
	it('does not let an unselected production default block a legacy status check', () => {
		const config = input();
		actual(config).bucketingMode = 'DATADOG';
		required(config.sourceFlags[0].environments).push({
			id: 20,
			name: 'Other prod',
			active: true,
			is_production: true,
		});
		expect(compare(config).status).toBe('in-sync');
	});
	it('requires review for missing split IDs or unsupported exposure schedules', () => {
		const config = input();
		delete required(config.sourceFlags[0].allocations)[0].variation_weight[0]
			.id;
		expect(compare(config).status).toBe('needs-review');
		const other = input();
		required(actual(other).environments[0].allocations)[0].exposure_schedule = {
			rollout_options: { strategy: 'UNIFORM_INTERVALS' },
			rollout_steps: [],
		};
		expect(compare(other).status).toBe('needs-review');
	});
	it('compares explicit audience references and refuses unresolved or negated references', () => {
		const config = input();
		const allocation = required(config.sourceFlags[0].allocations)[0];
		allocation.targeting_rules = [];
		allocation.audiences = [{ audience_id: 3, type: 'IS_IN' }];
		config.savedFilterLookup = new Map([[3, 'sf-3']]);
		required(actual(config).environments[0].allocations)[0].targeting_rules = [
			{ conditions: [{ saved_filter_id: 'sf-3' }] },
		];
		expect(compare(config).status).toBe('in-sync');
		config.savedFilterLookup = new Map();
		expect(compare(config).status).toBe('needs-review');
		config.savedFilterLookup = new Map([[3, 'sf-3']]);
		allocation.audiences[0].type = 'IS_NOT_IN';
		expect(compare(config).status).toBe('needs-review');
	});
	it('ignores disabled and zero-exposure source targeting filters', () => {
		const config = input();
		const allocations = required(config.sourceFlags[0].allocations);
		allocations.push({
			...allocations[0],
			id: 200,
			key: 'disabled',
			enabled: false,
		});
		allocations.push({
			...allocations[0],
			id: 201,
			key: 'unexposed',
			percent_exposure: 0,
		});
		expect(compare(config).status).toBe('in-sync');
	});
	it.each([
		{ rollout_options: { strategy: 'NO_ROLLOUT' }, rollout_steps: [null] },
		{
			rollout_options: { strategy: 'NO_ROLLOUT' },
			rollout_steps: [{ exposure_ratio: 0.5, is_pause_record: true }],
		},
		{
			rollout_options: { strategy: 'NO_ROLLOUT' },
			rollout_steps: [{ exposure_ratio: 0.5 }],
			absolute_start_time: '2999-01-01T00:00:00Z',
		},
		{
			rollout_options: { strategy: 'NO_ROLLOUT' },
			rollout_steps: [{ exposure_ratio: 0.5 }],
			guardrail_triggered_action: 'PAUSE',
		},
	])('requires review for unsafe schedule %j', (schedule) => {
		const config = input();
		required(actual(config).environments[0].allocations)[0].exposure_schedule =
			schedule;
		expect(compare(config).status).toBe('needs-review');
	});
	it('does not silently drop audience collection failures', () => {
		const config = input();
		config.audienceCollectionError = 'Audience API unavailable';
		expect(compare(config)).toMatchObject({
			status: 'needs-review',
			environments: [{ details: 'Audience API unavailable' }],
		});
	});
	it('writes Eppo-specific summary, columns, mapping labels and identity guidance', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eppo-status-'));
		try {
			const config = input();
			config.datadogFlags[0].key = 'old-key';
			const output = await writeMigrationStatusWorkbook(
				compareEppoMigrationStatus(config),
				path.join(directory, 'report.xlsx'),
			);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(output);
			const rows: string[] = [];
			workbook.eachSheet((sheet) =>
				sheet.eachRow((row) => rows.push(JSON.stringify(row.values))),
			);
			const text = rows.join('\n');
			expect(text).toContain('Eppo key');
			expect(text).toContain('Eppo environment');
			expect(text).toContain('Eppo flags');
			expect(text).toContain('Needs review');
			expect(text).toContain('Review the Eppo migration metadata');
			expect(text).not.toContain('LaunchDarkly');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
