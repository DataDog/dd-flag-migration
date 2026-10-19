import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import type {
	DatadogFlagEntry,
	DatadogStatusAllocation,
	DatadogStatusFlagDetail,
} from '../src/datadog/types.js';
import {
	canonicalEnvironmentTargeting,
	compareOrgs,
	flagNamesMatch,
	linkOrgFlags,
	linkSavedFilters,
} from '../src/org-diff/comparison.js';
import type { OrgDiffInput } from '../src/org-diff/types.js';
import { writeOrgDiffWorkbook } from '../src/org-diff/xlsx.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const pair = {
	sourceEnvironmentId: 'source-prod',
	sourceEnvironmentName: 'Production',
	targetEnvironmentId: 'target-prod',
	targetEnvironmentName: 'Production',
};

function allocation(
	overrides: Partial<DatadogStatusAllocation> & { key: string },
): DatadogStatusAllocation {
	return {
		type: 'FEATURE_GATE',
		status: 'published',
		targeting_rules: [],
		variant_weights: [],
		...overrides,
	};
}

/** Build matching flag details in both orgs; variant UUIDs differ per org. */
function flagDetail(
	org: 'source' | 'target',
	overrides: Partial<DatadogStatusFlagDetail> = {},
	environment: Partial<DatadogStatusFlagDetail['environments'][number]> = {},
): DatadogStatusFlagDetail {
	return {
		id: `${org}-flag`,
		key: 'example-flag',
		name: 'Example Flag',
		description: 'Shared description',
		valueType: 'BOOLEAN',
		distributionChannel: 'ALL',
		tags: ['team:example', 'service:web'],
		variants: [
			{ id: `${org}-on`, key: 'on', name: 'On', value: 'true' },
			{ id: `${org}-off`, key: 'off', name: 'Off', value: 'false' },
		],
		environments: [
			{
				environmentId: `${org}-prod`,
				status: 'ENABLED',
				defaultVariantKey: 'off',
				allocations: [
					allocation({
						key: `${org}-specific-key`,
						name: `${org} filter`,
						targeting_rules: [
							{
								conditions: [
									{
										operator: 'ONE_OF',
										attribute: 'country',
										value: ['us', 'ca'],
									},
								],
							},
						],
						variant_weights: [{ variant_id: `${org}-on`, value: 100 }],
					}),
				],
				...environment,
			},
		],
		...overrides,
	};
}

function flagEntry(
	org: 'source' | 'target',
	key = 'example-flag',
): DatadogFlagEntry {
	return { id: `${org}-flag`, key, name: 'Example Flag' };
}

function input(overrides: Partial<OrgDiffInput> = {}): OrgDiffInput {
	return {
		sourceSite: 'source.example',
		targetSite: 'target.example',
		sourceFlags: [flagEntry('source')],
		targetFlags: [flagEntry('target')],
		sourceDetails: new Map([['source-flag', flagDetail('source')]]),
		targetDetails: new Map([['target-flag', flagDetail('target')]]),
		sourceDetailErrors: new Map(),
		targetDetailErrors: new Map(),
		environmentPairs: [pair],
		...overrides,
	};
}

function onlyFlag(overrides: Partial<OrgDiffInput> = {}) {
	return compareOrgs(input(overrides)).flags[0];
}

// ─── Linking ──────────────────────────────────────────────────────────────────

describe('linkOrgFlags', () => {
	it('pairs flags by key and keeps unpaired flags from both orgs', () => {
		const links = linkOrgFlags(
			[flagEntry('source'), { id: 'source-only', key: 'source-only' }],
			[flagEntry('target'), { id: 'target-only', key: 'target-only' }],
		);
		expect(
			links.map((link) => [link.key, link.source?.id, link.target?.id]),
		).toEqual([
			['example-flag', 'source-flag', 'target-flag'],
			['source-only', 'source-only', undefined],
			['target-only', undefined, 'target-only'],
		]);
	});
});

describe('linkSavedFilters', () => {
	it('links by migration metadata in either direction, then by unique name', () => {
		const links = linkSavedFilters(
			[
				{ id: 's1', name: 'Copied to target' },
				{
					id: 's2',
					name: 'Copied from target',
					migration_metadata: {
						provider: 'datadog',
						source_id: 't2',
						source_site: 'target.example',
					},
				},
				{ id: 's3', name: 'Same name' },
				{ id: 's4', name: 'Duplicate' },
			],
			[
				{
					id: 't1',
					name: 'Renamed',
					migration_metadata: {
						provider: 'datadog',
						source_id: 's1',
						source_site: 'source.example',
					},
				},
				{ id: 't2', name: 'Something else' },
				{ id: 't3', name: 'Same name' },
				{ id: 't4', name: 'Duplicate' },
				{ id: 't5', name: 'Duplicate' },
			],
		);
		expect(links).toEqual(
			new Map([
				['s1', 't1'],
				['s2', 't2'],
				['s3', 't3'],
			]),
		);
	});
});

// ─── Comparison ───────────────────────────────────────────────────────────────

describe('compareOrgs', () => {
	it('reports matching configuration as in sync despite different IDs and keys', () => {
		const flag = onlyFlag();
		expect(flag).toMatchObject({
			status: 'in-sync',
			flagWideChanges: [],
			environments: [{ status: 'in-sync' }],
		});
	});

	it('reports flags that exist in only one org', () => {
		const result = compareOrgs(
			input({
				sourceFlags: [flagEntry('source'), { id: 'a', key: 'only-source' }],
				targetFlags: [flagEntry('target'), { id: 'b', key: 'only-target' }],
			}),
		);
		expect(
			Object.fromEntries(
				result.flags.map((flag) => [flag.flagKey, flag.status]),
			),
		).toEqual({
			'example-flag': 'in-sync',
			'only-source': 'only-in-source',
			'only-target': 'only-in-target',
		});
	});

	it.each<[string, Partial<DatadogStatusFlagDetail>]>([
		['name', { name: 'Renamed Flag' }],
		['description', { description: 'Different' }],
		['value-type', { valueType: 'STRING' }],
		['json-schema', { jsonSchema: '{"type":"object"}' }],
		['distribution-channel', { distributionChannel: 'CLIENT' }],
		['tags', { tags: ['team:example'] }],
	])('detects a %s difference', (change, overrides) => {
		const flag = onlyFlag({
			targetDetails: new Map([
				['target-flag', flagDetail('target', overrides)],
			]),
		});
		expect(flag.status).toBe('differs');
		expect(flag.flagWideChanges).toEqual([change]);
	});

	it.each([
		['1', '1.0'],
		['true', ' true '],
		['{"a":1,"b":2}', '{"b":2,"a":1}'],
	])('compares STRING variant values literally: %s / %s', (sourceValue, targetValue) => {
		const source = flagDetail('source', { valueType: 'STRING' });
		const target = flagDetail('target', { valueType: 'STRING' });
		source.variants[0].value = sourceValue;
		target.variants[0].value = targetValue;
		const flag = onlyFlag({
			sourceDetails: new Map([[source.id, source]]),
			targetDetails: new Map([[target.id, target]]),
		});
		expect(flag.status).toBe('differs');
		expect(flag.flagWideChanges).toEqual(['variants']);
	});

	it('ignores JSON formatting in schemas and JSON variants', () => {
		const source = flagDetail('source', {
			valueType: 'JSON',
			jsonSchema: '{"type":"object","required":["a"]}',
		});
		const target = flagDetail('target', {
			valueType: 'JSON',
			jsonSchema: '{ "required": ["a"], "type": "object" }',
		});
		source.variants[0].value = '{"a":1,"b":2}';
		target.variants[0].value = '{"b":2, "a":1}';
		expect(
			onlyFlag({
				sourceDetails: new Map([[source.id, source]]),
				targetDetails: new Map([[target.id, target]]),
			}).status,
		).toBe('in-sync');
	});

	it('reports schema removal even when both environments are disabled', () => {
		const source = flagDetail(
			'source',
			{ valueType: 'JSON' },
			{ status: 'DISABLED' },
		);
		const target = flagDetail(
			'target',
			{
				valueType: 'JSON',
				jsonSchema: '{"type":"object"}',
			},
			{ status: 'DISABLED' },
		);
		expect(
			onlyFlag({
				sourceDetails: new Map([[source.id, source]]),
				targetDetails: new Map([[target.id, target]]),
			}),
		).toMatchObject({ status: 'differs', flagWideChanges: ['json-schema'] });
	});

	it('ignores tag order and collision-suffixed names', () => {
		expect(flagNamesMatch('Example Flag', 'Example Flag (2)')).toBe(true);
		const flag = onlyFlag({
			targetDetails: new Map([
				[
					'target-flag',
					flagDetail('target', {
						name: 'Example Flag (1)',
						tags: ['service:web', 'team:example'],
					}),
				],
			]),
		});
		expect(flag.status).toBe('in-sync');
	});

	it('describes variant differences without exposing values', () => {
		const target = flagDetail('target');
		target.variants = [
			{ id: 'target-on', key: 'on', name: 'On', value: '"changed"' },
			{ id: 'target-extra', key: 'extra', name: 'Extra', value: 'true' },
		];
		target.environments[0].allocations = [
			allocation({
				key: 'k',
				targeting_rules: [
					{
						conditions: [
							{ operator: 'ONE_OF', attribute: 'country', value: ['us', 'ca'] },
						],
					},
				],
				variant_weights: [{ variant_id: 'target-on', value: 100 }],
			}),
		];
		const flag = onlyFlag({
			targetDetails: new Map([['target-flag', target]]),
		});
		expect(flag.flagWideChanges).toEqual(['variants']);
		expect(flag.flagWideDetails).toEqual([
			'Variant "on" differs.',
			'Variant "off" exists only in the source org.',
			'Variant "extra" exists only in the target org.',
		]);
		expect(flag.flagWideDetails.join(' ')).not.toContain('changed');
	});

	it('compares variants with different keys under their matched source key', () => {
		const target = flagDetail(
			'target',
			{},
			{ defaultVariantKey: 'variation-1' },
		);
		target.variants = [
			{ id: 'target-on', key: 'variation-0', name: 'On', value: 'true' },
			{ id: 'target-off', key: 'variation-1', name: 'Off', value: 'false' },
		];
		const flag = onlyFlag({
			targetDetails: new Map([['target-flag', target]]),
		});
		expect(flag).toMatchObject({
			status: 'in-sync',
			flagWideChanges: [],
			environments: [{ status: 'in-sync' }],
		});
	});

	it('detects enablement, default, override, and targeting differences', () => {
		const disabled = onlyFlag({
			targetDetails: new Map([
				['target-flag', flagDetail('target', {}, { status: 'DISABLED' })],
			]),
		});
		expect(disabled.environments[0].changes).toEqual(['enablement']);

		const defaults = onlyFlag({
			targetDetails: new Map([
				['target-flag', flagDetail('target', {}, { defaultVariantKey: 'on' })],
			]),
		});
		expect(defaults.environments[0].changes).toEqual(['default']);

		const override = onlyFlag({
			targetDetails: new Map([
				['target-flag', flagDetail('target', {}, { overrideVariantKey: 'on' })],
			]),
		});
		expect(override.environments[0].changes).toEqual(['override']);

		const targeting = onlyFlag({
			targetDetails: new Map([
				[
					'target-flag',
					flagDetail(
						'target',
						{},
						{
							allocations: [
								allocation({
									key: 'k',
									variant_weights: [
										{ variant_id: 'target-on', value: 50 },
										{ variant_id: 'target-off', value: 50 },
									],
								}),
							],
						},
					),
				],
			]),
		});
		expect(targeting.environments[0].changes).toEqual(['targeting']);
		expect(targeting.status).toBe('differs');
	});

	it('does not compare targeting when both orgs are disabled', () => {
		const flag = onlyFlag({
			sourceDetails: new Map([
				['source-flag', flagDetail('source', {}, { status: 'DISABLED' })],
			]),
			targetDetails: new Map([
				[
					'target-flag',
					flagDetail('target', {}, { status: 'DISABLED', allocations: [] }),
				],
			]),
		});
		expect(flag.environments[0]).toMatchObject({
			status: 'in-sync',
			details: 'Disabled in both orgs; targeting was not compared.',
		});
	});

	it('marks progressive rollouts as needing review', () => {
		const flag = onlyFlag({
			targetDetails: new Map([
				[
					'target-flag',
					flagDetail(
						'target',
						{},
						{
							allocations: [allocation({ key: 'canary', type: 'CANARY' })],
						},
					),
				],
			]),
		});
		expect(flag.status).toBe('needs-review');
		expect(flag.environments[0].status).toBe('could-not-verify');
	});

	it('compares saved filter references through the link table', () => {
		const withFilter = (org: 'source' | 'target', filterId: string) =>
			flagDetail(
				org,
				{},
				{
					allocations: [
						allocation({
							key: 'segment',
							targeting_rules: [
								{ conditions: [{ saved_filter_id: filterId }] },
							],
							variant_weights: [{ variant_id: `${org}-on`, value: 100 }],
						}),
					],
				},
			);
		const base = {
			sourceDetails: new Map([['source-flag', withFilter('source', 'sf-a')]]),
			targetDetails: new Map([['target-flag', withFilter('target', 'sf-b')]]),
		};
		expect(
			onlyFlag({ ...base, savedFilterLinks: new Map([['sf-a', 'sf-b']]) })
				.status,
		).toBe('in-sync');
		expect(onlyFlag(base).status).toBe('differs');
	});

	it('marks flags with detail errors as needing review', () => {
		const flag = onlyFlag({
			targetDetails: new Map(),
			targetDetailErrors: new Map([['target-flag', 'GET failed — 500']]),
		});
		expect(flag).toMatchObject({
			status: 'needs-review',
			flagWideChanges: ['collection'],
		});
	});
});

describe('canonicalEnvironmentTargeting', () => {
	const token = (id: string) => id;
	const variants = new Map([
		['v-on', 'on'],
		['v-off', 'off'],
	]);

	it('ignores condition, rule, and value order and zero weights', () => {
		const a = canonicalEnvironmentTargeting(
			{
				environmentId: 'e',
				status: 'ENABLED',
				allocations: [
					allocation({
						key: 'a',
						targeting_rules: [
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'x', value: ['1', '2'] },
									{ operator: 'ONE_OF', attribute: 'y', value: ['3'] },
								],
							},
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'z', value: ['4'] },
								],
							},
						],
						variant_weights: [
							{ variant_id: 'v-on', value: 100 },
							{ variant_id: 'v-off', value: 0 },
						],
					}),
				],
			},
			variants,
			token,
		);
		const b = canonicalEnvironmentTargeting(
			{
				environmentId: 'e',
				status: 'ENABLED',
				allocations: [
					allocation({
						key: 'b',
						targeting_rules: [
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'z', value: ['4'] },
								],
							},
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'y', value: ['3'] },
									{ operator: 'ONE_OF', attribute: 'x', value: ['2', '1'] },
								],
							},
						],
						variant_weights: [{ variant_key: 'on', value: 100 }],
					}),
				],
			},
			variants,
			token,
		);
		expect(a).toBe(b);
	});

	it('treats a trailing catch-all that serves the default as no targeting', () => {
		const withCatchAll = canonicalEnvironmentTargeting(
			{
				environmentId: 'e',
				status: 'ENABLED',
				defaultVariantKey: 'off',
				allocations: [
					allocation({
						key: 'fallthrough',
						variant_weights: [{ variant_id: 'v-off', value: 100 }],
					}),
					allocation({
						key: 'unreachable',
						targeting_rules: [
							{
								conditions: [
									{ operator: 'ONE_OF', attribute: 'x', value: ['1'] },
								],
							},
						],
						variant_weights: [{ variant_id: 'v-on', value: 100 }],
					}),
				],
			},
			variants,
			token,
		);
		const empty = canonicalEnvironmentTargeting(
			{
				environmentId: 'e',
				status: 'ENABLED',
				defaultVariantKey: 'off',
				allocations: null,
			},
			variants,
			token,
		);
		expect(withCatchAll).toBe(empty);
	});
});

// ─── Workbook ─────────────────────────────────────────────────────────────────

describe('writeOrgDiffWorkbook', () => {
	it('writes a summary and one tab per environment pair without variant values', async () => {
		const target = flagDetail('target', {}, { status: 'DISABLED' });
		target.variants[0].value = 'secret-value';
		const result = compareOrgs(
			input({
				sourceFlags: [
					{ ...flagEntry('source'), name: '=Example Flag' },
					{ id: 'only', key: 'only-source', name: 'Only Source' },
				],
				sourceDetails: new Map([
					['source-flag', flagDetail('source', { name: '=Example Flag' })],
				]),
				targetDetails: new Map([['target-flag', target]]),
				environmentPairs: [{ ...pair, sourceEnvironmentName: '+Production' }],
			}),
		);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'org-diff-'));
		const output = path.join(directory, 'diff.xlsx');
		try {
			await writeOrgDiffWorkbook(result, output);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(output);
			expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
				'Summary',
				'+Production ↔ Production',
			]);
			const values = workbook.worksheets.flatMap((sheet) =>
				sheet
					.getSheetValues()
					.flatMap((row) => (Array.isArray(row) ? row : []))
					.filter((value) => value !== undefined && value !== null)
					.map(String),
			);
			expect(values).toContain('Only in source org');
			expect(values).toContain('Differs');
			expect(values).toContain("'=Example Flag");
			expect(values).toContain("'+Production");
			expect(values.join(' ')).not.toContain('secret-value');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
