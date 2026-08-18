import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import {
	BULK_ENABLE_FILTER_CATEGORIES,
	ENABLED_IN_ALL_FILTER_ID,
	flagEnablementCategories,
	NEEDS_ENABLING_FILTER_ID,
} from '../src/bulk-enable/filtering.js';
import { processBulkEnablePairs } from '../src/bulk-enable/process.js';
import { exportBulkEnableChangesToXlsx } from '../src/bulk-enable/xlsx.js';
import { itemMatchesFilters } from '../src/components/filter-matching.js';
import type {
	DatadogEnvironment,
	DatadogFlagEntry,
} from '../src/datadog/types.js';

const flags: DatadogFlagEntry[] = [
	{
		id: 'flag-1',
		key: 'flag-one',
		tags: ['team:one'],
		migration_metadata: { provider: 'launchdarkly' },
	},
	{
		id: 'flag-2',
		key: 'flag-two',
		tags: ['team:two'],
		migration_metadata: { provider: 'eppo' },
	},
];

const environments: DatadogEnvironment[] = [
	{ id: 'env-1', name: 'Development', is_production: false, queries: [] },
	{ id: 'env-2', name: 'Production', is_production: true, queries: [] },
];

describe('bulk enable filtering', () => {
	it('separates flags needing work from flags enabled in every selected environment', () => {
		const needsEnabling: DatadogFlagEntry = {
			...flags[0],
			environmentStatuses: new Map([
				['env-1', 'ENABLED'],
				['env-2', 'DISABLED'],
			]),
		};
		const enabledInAll: DatadogFlagEntry = {
			...flags[1],
			environmentStatuses: new Map([
				['env-1', 'ENABLED'],
				['env-2', 'ENABLED'],
				['unselected-env', 'DISABLED'],
			]),
		};

		const needsCategories = flagEnablementCategories(
			needsEnabling,
			environments,
		);
		const enabledCategories = flagEnablementCategories(
			enabledInAll,
			environments,
		);

		expect(needsCategories).toEqual([NEEDS_ENABLING_FILTER_ID]);
		expect(enabledCategories).toEqual([ENABLED_IN_ALL_FILTER_ID]);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: needsCategories },
				new Set([NEEDS_ENABLING_FILTER_ID]),
				BULK_ENABLE_FILTER_CATEGORIES,
			),
		).toBe(true);
		expect(
			itemMatchesFilters(
				{ migrated: true, categories: enabledCategories },
				new Set([NEEDS_ENABLING_FILTER_ID]),
				BULK_ENABLE_FILTER_CATEGORIES,
			),
		).toBe(false);
	});

	it('keeps flags with missing status data in needs-enabling', () => {
		expect(flagEnablementCategories(flags[0], environments)).toEqual([
			NEEDS_ENABLING_FILTER_ID,
		]);
		expect(
			flagEnablementCategories(
				{
					...flags[0],
					environmentStatuses: new Map([['env-1', 'ENABLED']]),
				},
				environments,
			),
		).toEqual([NEEDS_ENABLING_FILTER_ID]);
	});
});

describe('bulk enable processing', () => {
	it('processes pairs sequentially, skips enabled pairs, and continues after failures', async () => {
		const events: string[] = [];
		const results = await processBulkEnablePairs(flags, environments, {
			fetchStatuses: async (flag) => {
				events.push(`status:${flag.id}`);
				return flag.id === 'flag-1'
					? new Map([['env-1', 'ENABLED' as const]])
					: new Map();
			},
			enable: async (flag, environment) => {
				events.push(`enable:${flag.id}:${environment.id}`);
				if (flag.id === 'flag-2' && environment.id === 'env-1') {
					return 'approval_requested';
				}
				if (flag.id === 'flag-2' && environment.id === 'env-2') {
					throw new Error('pair failed');
				}
				return 'enabled';
			},
			onProgress: ({ flag, environment, index, total }) => {
				events.push(`progress:${flag.id}:${environment.id}:${index}/${total}`);
			},
		});

		expect(events).toEqual([
			'status:flag-1',
			'progress:flag-1:env-1:1/4',
			'progress:flag-1:env-2:2/4',
			'enable:flag-1:env-2',
			'status:flag-2',
			'progress:flag-2:env-1:3/4',
			'enable:flag-2:env-1',
			'progress:flag-2:env-2:4/4',
			'enable:flag-2:env-2',
		]);
		expect(results.map((result) => result.status)).toEqual([
			'Already enabled',
			'Enabled',
			'Approval requested',
			'Failed',
		]);
		expect(results[3].error).toBe('Error: pair failed');
	});

	it('reports lookup uncertainty on successful, approval, and failed writes', async () => {
		const uncertainEnvironments: DatadogEnvironment[] = [
			...environments,
			{ id: 'env-3', name: 'Staging', is_production: false, queries: [] },
		];
		const results = await processBulkEnablePairs(
			[flags[0]],
			uncertainEnvironments,
			{
				fetchStatuses: async () => {
					throw new Error('status unavailable');
				},
				enable: async (_flag, environment) => {
					if (environment.id === 'env-2') return 'approval_requested';
					if (environment.id === 'env-3') throw new Error('enable failed');
					return 'enabled';
				},
			},
		);

		expect(results.map((result) => result.status)).toEqual([
			'Enabled (prior status unknown)',
			'Approval requested (prior status unknown)',
			'Failed',
		]);
		expect(results.map((result) => result.statusLookupError)).toEqual([
			'Error: status unavailable',
			'Error: status unavailable',
			'Error: status unavailable',
		]);
		expect(results[2].error).toBe('Error: enable failed');
	});
});

describe('bulk enable spreadsheet export', () => {
	it('writes flag/environment outcomes to an xlsx workbook', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'bulk-enable-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const filepath = await exportBulkEnableChangesToXlsx(
				[
					{
						flagId: 'flag-id',
						flagKey: 'flag-key',
						flagTags: ['project:health-100'],
						environmentId: 'env-id',
						environmentName: 'Production',
						isProduction: true,
						status: 'Enabled (prior status unknown)',
						statusLookupError: 'status unavailable',
					},
					{
						flagId: 'flag-id',
						flagKey: 'flag-key',
						flagTags: ['project:health-100'],
						environmentId: 'approval-env-id',
						environmentName: 'Staging',
						isProduction: false,
						status: 'Approval requested',
					},
					{
						flagId: 'flag-id',
						flagKey: 'flag-key',
						flagTags: ['project:health-100'],
						environmentId: 'failed-env-id',
						environmentName: 'Zeta',
						isProduction: false,
						status: 'Failed',
						statusLookupError: 'status lookup failed',
						error: 'enable failed',
					},
				],
				outputDirectory,
			);

			expect(filepath).toMatch(/bulk-enable-export-.*\.xlsx$/);
			expect(fs.existsSync(filepath)).toBe(true);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Environment Changes');
			expect(worksheet?.getCell('A5').value).toBe('flag-key');
			expect(worksheet?.getCell('C5').value).toBe('project:health-100');
			expect(worksheet?.getCell('D5').value).toBe('Production');
			expect(worksheet?.getCell('F5').value).toBe('Yes');
			expect(worksheet?.getCell('G5').value).toBe(
				'Enabled (prior status unknown)',
			);
			expect(worksheet?.getCell('H5').value).toBe('status unavailable');
			expect(worksheet?.getCell('D6').value).toBe('Staging');
			expect(worksheet?.getCell('G6').value).toBe('Approval requested');
			expect(worksheet?.getCell('G7').value).toBe('Failed');
			expect(worksheet?.getCell('H7').value).toBe('status lookup failed');
			expect(worksheet?.getCell('I7').value).toBe('enable failed');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
