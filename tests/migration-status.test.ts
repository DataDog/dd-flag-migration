import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import ExcelJS from 'exceljs';
import { ddClient, fetchDatadogStatusFlagDetail } from '../src/datadog/api.js';
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
	DatadogStatusFlagDetail,
	EnvironmentMapping,
} from '../src/datadog/types.js';
import type { LDEnvironment, LDFlag } from '../src/launchdarkly/types.js';
import {
	compareMigrationStatus,
	linkLaunchDarklyFlags,
} from '../src/migration-status/comparison.js';
import type {
	MigrationStatusComparisonInput,
	MigrationStatusResult,
} from '../src/migration-status/types.js';
import { writeMigrationStatusWorkbook } from '../src/migration-status/xlsx.js';

const sourceEnvironment: LDEnvironment = {
	key: 'production',
	name: 'Production',
	color: '000000',
	archived: false,
};
const datadogEnvironment: DatadogEnvironment = {
	id: 'dd-production',
	name: 'prod',
	is_production: true,
	queries: [],
};
const sourceFlag: LDFlag = {
	name: 'Checkout',
	kind: 'boolean',
	key: 'checkout',
	variations: [
		{ _id: 'false-id', value: false },
		{ _id: 'true-id', value: true },
	],
	defaults: { onVariation: 1, offVariation: 0 },
	environments: {
		production: {
			on: true,
			archived: false,
			targets: [],
			contextTargets: [],
			rules: [],
			fallthrough: { variation: 1 },
			offVariation: 0,
			prerequisites: [],
			_environmentName: 'Production',
		},
	},
	tags: [],
	archived: false,
	deprecated: false,
	temporary: false,
};
const datadogFlag: DatadogFlagEntry = {
	id: 'dd-flag',
	key: 'checkout',
	migration_metadata: {
		project_key: 'project',
		flag_key: 'checkout',
	},
};
const datadogDetail: DatadogStatusFlagDetail = {
	id: 'dd-flag',
	key: 'checkout',
	name: 'Checkout',
	variants: [
		{
			id: 'dd-false',
			key: 'false',
			name: 'false',
			value: 'false',
			migration_metadata: { source_id: 'false-id' },
		},
		{
			id: 'dd-true',
			key: 'true',
			name: 'true',
			value: 'true',
			migration_metadata: { source_id: 'true-id' },
		},
	],
	environments: [
		{
			environmentId: 'dd-production',
			status: 'ENABLED',
			defaultVariantKey: 'true',
			allocations: [],
		},
	],
};

function input(
	overrides: Partial<MigrationStatusComparisonInput> = {},
): MigrationStatusComparisonInput {
	const environmentMapping: EnvironmentMapping<string> = new Map([
		['production', [datadogEnvironment]],
	]);
	return {
		projectKey: 'project',
		projectName: 'Project',
		sourceFlags: [sourceFlag],
		sourceDetailErrors: new Map(),
		datadogFlags: [datadogFlag],
		datadogDetails: new Map([['dd-flag', datadogDetail]]),
		datadogDetailErrors: new Map(),
		selectedSourceEnvironments: [sourceEnvironment],
		environmentMapping,
		...overrides,
	};
}

describe('migration status comparison', () => {
	it('reports a migrated flag as in sync for the selected mapping', () => {
		const result = compareMigrationStatus(input());
		expect(result.flags[0]).toMatchObject({
			status: 'in-sync',
			environments: [{ status: 'in-sync' }],
		});
	});

	it('uses the migrated Datadog key as the default display name after a key rename', () => {
		const result = compareMigrationStatus(
			input({
				sourceFlags: [{ ...sourceFlag, name: sourceFlag.key }],
				datadogFlags: [{ ...datadogFlag, key: 'renamed-checkout' }],
				datadogDetails: new Map([
					[
						'dd-flag',
						{
							...datadogDetail,
							key: 'renamed-checkout',
							name: 'renamed-checkout',
						},
					],
				]),
			}),
		);
		expect(result.flags[0]).toMatchObject({
			status: 'in-sync',
			flagWideChanges: [],
		});
	});

	it('compares translated targeting without exposing condition values', () => {
		const targetedSource: LDFlag = {
			...sourceFlag,
			environments: {
				production: {
					...sourceFlag.environments?.production,
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'rule',
							variation: 1,
							clauses: [
								{
									_id: 'clause',
									attribute: 'key',
									op: 'in',
									values: ['private-user'],
									contextKind: 'user',
									negate: false,
								},
							],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 1 },
					offVariation: 0,
					prerequisites: [],
					_environmentName: 'Production',
				},
			},
		};
		const targetedDetail: DatadogStatusFlagDetail = {
			...datadogDetail,
			environments: [
				{
					...datadogDetail.environments[0],
					allocations: [
						{
							key: 'checkout-prod-rule-0',
							targeting_rules: [
								{
									conditions: [
										{
											attribute: 'id',
											operator: 'ONE_OF',
											value: ['private-user'],
										},
									],
								},
							],
							variant_weights: [{ variant_id: 'dd-true', value: 100 }],
						},
					],
				},
			],
		};
		const matching = compareMigrationStatus(
			input({
				sourceFlags: [targetedSource],
				datadogDetails: new Map([['dd-flag', targetedDetail]]),
			}),
		);
		expect(matching.flags[0].status).toBe('in-sync');

		const missingTargeting = structuredClone(targetedDetail);
		missingTargeting.environments[0].allocations = null;
		const missing = compareMigrationStatus(
			input({
				sourceFlags: [targetedSource],
				datadogDetails: new Map([['dd-flag', missingTargeting]]),
			}),
		);
		expect(missing.flags[0].environments[0]).toMatchObject({
			status: 'out-of-sync',
			changes: ['targeting'],
			details: 'Targeting filters or rollout weights differ.',
		});

		const changed = structuredClone(targetedDetail);
		const condition =
			changed.environments[0].allocations?.[0].targeting_rules?.[0]
				.conditions?.[0];
		if (condition) condition.value = ['different-private-user'];
		const different = compareMigrationStatus(
			input({
				sourceFlags: [targetedSource],
				datadogDetails: new Map([['dd-flag', changed]]),
			}),
		);
		expect(different.flags[0].environments[0]).toMatchObject({
			status: 'out-of-sync',
			changes: ['targeting'],
		});
		expect(different.flags[0].environments[0].details).not.toContain(
			'private-user',
		);
	});

	it('uses stable source IDs when variant renames preserve Datadog keys', () => {
		const renamedSource: LDFlag = {
			...sourceFlag,
			kind: 'multivariate',
			variations: [
				...sourceFlag.variations.slice(0, 1),
				{ _id: 'true-id', name: 'Renamed choice', value: true },
			],
		};
		const retainedKeyDetail: DatadogStatusFlagDetail = {
			...datadogDetail,
			variants: [
				...datadogDetail.variants.slice(0, 1),
				{
					...datadogDetail.variants[1],
					key: 'old-choice',
					name: 'Renamed choice',
				},
			],
			environments: [
				{
					...datadogDetail.environments[0],
					defaultVariantKey: 'old-choice',
				},
			],
		};
		const result = compareMigrationStatus(
			input({
				sourceFlags: [renamedSource],
				datadogDetails: new Map([['dd-flag', retainedKeyDetail]]),
			}),
		);
		expect(result.flags[0]).toMatchObject({
			status: 'in-sync',
			flagWideChanges: [],
			environments: [{ status: 'in-sync' }],
		});
	});

	it('reports source flags without a Datadog match once as not yet migrated', () => {
		const result = compareMigrationStatus(
			input({ datadogFlags: [], datadogDetails: new Map() }),
		);
		expect(result.flags[0]).toMatchObject({
			status: 'not-yet-migrated',
			environments: [],
		});
	});

	it('requires review for any occupied same key without an exact metadata match', () => {
		for (const conflicting of [
			{ id: 'manual', key: 'checkout' },
			{
				id: 'other-project',
				key: 'checkout',
				migration_metadata: {
					project_key: 'other-project',
					flag_key: 'checkout',
				},
			},
			{
				id: 'other-flag',
				key: 'checkout',
				migration_metadata: {
					project_key: 'project',
					flag_key: 'other-source-flag',
				},
			},
		]) {
			const links = linkLaunchDarklyFlags(
				[sourceFlag],
				[conflicting],
				'project',
			);
			expect(links[0]).toMatchObject({
				identityProblem:
					'A same-key Datadog flag exists without matching migration metadata.',
			});
		}
	});

	it('compares enablement for a disabled environment with null allocations', () => {
		const disabledSource: LDFlag = structuredClone(sourceFlag);
		if (disabledSource.environments?.production) {
			disabledSource.environments.production.on = false;
		}
		const result = compareMigrationStatus(
			input({
				sourceFlags: [disabledSource],
				datadogDetails: new Map([
					[
						'dd-flag',
						{
							...datadogDetail,
							environments: [
								{
									...datadogDetail.environments[0],
									status: 'DISABLED',
									allocations: null,
								},
							],
						},
					],
				]),
			}),
		);
		expect(result.flags[0]).toMatchObject({
			status: 'in-sync',
			environments: [{ status: 'in-sync', changes: [] }],
		});
	});

	it('treats null allocations as no explicit targeting filters', () => {
		const result = compareMigrationStatus(
			input({
				datadogDetails: new Map([
					[
						'dd-flag',
						{
							...datadogDetail,
							environments: [
								{
									...datadogDetail.environments[0],
									allocations: null,
								},
							],
						},
					],
				]),
			}),
		);
		expect(result.flags[0]).toMatchObject({
			status: 'in-sync',
			environments: [{ status: 'in-sync', changes: [] }],
		});
	});

	it('calculates partial migration only from selected mappings', () => {
		const second: DatadogEnvironment = {
			...datadogEnvironment,
			id: 'dd-eu',
			name: 'prod-eu',
		};
		const ignored: DatadogEnvironment = {
			...datadogEnvironment,
			id: 'dd-ignored',
			name: 'ignored',
		};
		const mapping: EnvironmentMapping<string> = new Map([
			['production', [datadogEnvironment, second]],
		]);
		const result = compareMigrationStatus(
			input({
				environmentMapping: mapping,
				datadogDetails: new Map([
					[
						'dd-flag',
						{
							...datadogDetail,
							environments: [
								...datadogDetail.environments,
								{
									environmentId: ignored.id,
									status: 'DISABLED',
									allocations: null,
								},
							],
						},
					],
				]),
			}),
		);
		expect(result.flags[0].status).toBe('partially-migrated');
		expect(result.flags[0].environments).toEqual([
			expect.objectContaining({
				datadogEnvironmentName: 'prod',
				status: 'in-sync',
			}),
			expect.objectContaining({
				datadogEnvironmentName: 'prod-eu',
				status: 'not-migrated',
			}),
		]);
		expect(
			result.flags[0].environments.some(
				(environment) => environment.datadogEnvironmentName === 'ignored',
			),
		).toBe(false);
	});

	it('reports enablement and flag-wide variant differences without values', () => {
		const result = compareMigrationStatus(
			input({
				datadogDetails: new Map([
					[
						'dd-flag',
						{
							...datadogDetail,
							variants: datadogDetail.variants.slice(0, 1),
							environments: [
								{
									...datadogDetail.environments[0],
									status: 'DISABLED',
								},
							],
						},
					],
				]),
			}),
		);
		expect(result.flags[0]).toMatchObject({
			status: 'out-of-sync',
			flagWideChanges: ['variants'],
			environments: [
				expect.objectContaining({
					status: 'out-of-sync',
					changes: expect.arrayContaining(['enablement']),
				}),
			],
		});
	});
});

describe('Datadog migration status detail reader', () => {
	const mock = new AxiosMockAdapter(ddClient);
	afterEach(() => mock.reset());

	it('uses GET and preserves targeting filter bodies', async () => {
		mock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/dd-flag')
			.reply(200, {
				data: {
					id: 'dd-flag',
					attributes: {
						key: 'checkout',
						name: 'Checkout',
						variants: datadogDetail.variants,
						feature_flag_environments: [
							{
								environment_id: 'dd-production',
								status: 'ENABLED',
								default_variant_key: 'true',
								allocations: [
									{
										id: 'filter',
										attributes: {
											key: 'checkout-prod-rule-0',
											targeting_rules: [
												{
													conditions: [
														{
															attribute: 'id',
															operator: 'ONE_OF',
															value: ['private-user'],
														},
													],
												},
											],
											variant_weights: [{ variant_id: 'dd-true', value: 100 }],
										},
									},
								],
							},
						],
					},
				},
			});
		const detail = await fetchDatadogStatusFlagDetail('api', 'app', 'dd-flag');
		expect(
			detail.environments[0].allocations?.[0].targeting_rules?.[0]
				.conditions?.[0].value,
		).toEqual(['private-user']);
		expect(detail.environments[0].defaultVariantKey).toBe('true');
		expect(mock.history.get).toHaveLength(1);
		expect(mock.history.post).toHaveLength(0);
		expect(mock.history.put).toHaveLength(0);
	});

	it('resolves the live default_variant_id response shape', async () => {
		mock
			.onGet('https://api.datadoghq.com/api/v2/feature-flags/dd-flag')
			.reply(200, {
				data: {
					id: 'dd-flag',
					attributes: {
						key: 'checkout',
						name: 'Checkout',
						variants: datadogDetail.variants,
						feature_flag_environments: [
							{
								environment_id: 'dd-production',
								status: 'ENABLED',
								default_variant_id: 'dd-false',
								allocations: [],
							},
						],
					},
				},
			});

		const detail = await fetchDatadogStatusFlagDetail('api', 'app', 'dd-flag');

		expect(detail.environments[0].defaultVariantKey).toBe('false');
	});
});

describe('migration status workbook', () => {
	it('writes environment-scoped sheets without exporting variant values', async () => {
		const formulaSourceEnvironment = {
			...sourceEnvironment,
			name: '=Production',
		};
		const formulaDatadogEnvironment = {
			...datadogEnvironment,
			name: '+prod',
		};
		const result = compareMigrationStatus(
			input({
				sourceFlags: [{ ...sourceFlag, name: '=Checkout' }],
				datadogFlags: [],
				datadogDetails: new Map(),
				selectedSourceEnvironments: [formulaSourceEnvironment],
				environmentMapping: new Map([
					['production', [formulaDatadogEnvironment]],
				]),
			}),
		);
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'migration-status-'),
		);
		const output = path.join(directory, 'status.xlsx');
		try {
			await writeMigrationStatusWorkbook(result, output);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(output);
			expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
				'Summary',
				'+prod',
			]);
			const values = workbook.worksheets.flatMap((sheet) =>
				(sheet.getSheetValues() as unknown[]).flatMap((row) =>
					Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [],
				),
			);
			expect(values).toContain("'=Checkout");
			expect(values).toContain("'=Production (LaunchDarkly) → +prod (DD)");
			expect(values.join('\n')).not.toContain('private-user');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('separates status and summary counts by Datadog environment', async () => {
		const result: MigrationStatusResult = {
			projectKey: 'project',
			projectName: 'Project',
			generatedAt: new Date('2026-09-16T12:00:00Z'),
			mappings: [
				{
					sourceEnvironmentKey: 'production',
					sourceEnvironmentName: 'Production',
					datadogEnvironmentId: 'dd-production',
					datadogEnvironmentName: 'Production',
				},
				{
					sourceEnvironmentKey: 'alpha',
					sourceEnvironmentName: 'Alpha',
					datadogEnvironmentId: 'dd-alpha',
					datadogEnvironmentName: 'Alpha',
				},
			],
			flags: [
				{
					flagKey: 'checkout',
					flagName: 'Checkout',
					datadogFlagKey: 'checkout',
					status: 'out-of-sync',
					flagWideChanges: [],
					flagWideDetails: [],
					environments: [
						{
							sourceEnvironmentKey: 'production',
							sourceEnvironmentName: 'Production',
							datadogEnvironmentId: 'dd-production',
							datadogEnvironmentName: 'Production',
							status: 'in-sync',
							changes: [],
							details: 'Configuration matches.',
						},
						{
							sourceEnvironmentKey: 'alpha',
							sourceEnvironmentName: 'Alpha',
							datadogEnvironmentId: 'dd-alpha',
							datadogEnvironmentName: 'Alpha',
							status: 'out-of-sync',
							changes: ['default'],
							details: 'Default variant differs.',
						},
					],
				},
			],
			limitations: [],
		};
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'migration-status-'),
		);
		const output = path.join(directory, 'status.xlsx');
		try {
			await writeMigrationStatusWorkbook(result, output);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(output);
			expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
				'Summary',
				'Production',
				'Alpha',
			]);
			const productionValues = (
				workbook.getWorksheet('Production')?.getSheetValues() as unknown[]
			).flatMap((row) =>
				Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [],
			);
			const alphaValues = (
				workbook.getWorksheet('Alpha')?.getSheetValues() as unknown[]
			).flatMap((row) =>
				Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [],
			);
			expect(productionValues).toContain('In sync: 1');
			expect(productionValues).toContain('In sync');
			expect(productionValues).not.toContain('Out of sync');
			expect(productionValues).not.toContain('Default variant differs.');
			expect(alphaValues).toContain('Out of sync: 1');
			expect(alphaValues).toContain('Out of sync');
			expect(alphaValues).toContain('Default variant differs.');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
