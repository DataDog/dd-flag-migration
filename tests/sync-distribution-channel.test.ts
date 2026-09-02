import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import type { DatadogFlagEntry } from '../src/datadog/types.js';
import {
	type DistributionChannelSyncItem,
	type DistributionChannelSyncSummary,
	executeDistributionChannelSync,
} from '../src/helpers/sync-distribution-channel.js';
import { resolveDistributionChannelItems } from '../src/launchdarkly/sync-distribution-channel.js';
import type { LDFlag } from '../src/launchdarkly/types.js';
import { exportDistributionChannelSyncToXlsx } from '../src/sync-distribution-channel/xlsx.js';

const item: DistributionChannelSyncItem = {
	sourceKey: 'checkout',
	datadogKey: 'checkout',
	datadogFlagId: 'flag-1',
	currentChannel: 'SERVER',
};

describe('resolveDistributionChannelItems', () => {
	it('returns only safe same-project and exact-key manual matches', () => {
		const flags = [
			{ key: 'migrated' },
			{ key: 'manual' },
			{ key: 'foreign' },
			{ key: 'missing' },
		] as LDFlag[];
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'dd-1',
				key: 'renamed',
				distributionChannel: 'CLIENT',
				migration_metadata: {
					project_key: 'project-a',
					flag_key: 'migrated',
				},
			},
			{ id: 'dd-2', key: 'manual', distributionChannel: 'ALL' },
			{
				id: 'dd-3',
				key: 'foreign',
				distributionChannel: 'SERVER',
				migration_metadata: {
					project_key: 'project-b',
					flag_key: 'foreign',
				},
			},
		];

		expect(
			resolveDistributionChannelItems(flags, datadogFlags, 'project-a'),
		).toEqual([
			{
				sourceKey: 'manual',
				datadogKey: 'manual',
				datadogFlagId: 'dd-2',
				currentChannel: 'ALL',
			},
			{
				sourceKey: 'migrated',
				datadogKey: 'renamed',
				datadogFlagId: 'dd-1',
				currentChannel: 'CLIENT',
			},
		]);
	});
});

describe('executeDistributionChannelSync', () => {
	it('skips flags already using the target channel', async () => {
		const update = jest.fn(async () => {});
		const summary = await executeDistributionChannelSync(
			[{ ...item, currentChannel: 'SERVER' }],
			'SERVER',
			'api',
			'app',
			'test.invalid',
			false,
			{ update },
		);

		expect(summary.unchanged).toBe(1);
		expect(summary.updated).toBe(0);
		expect(update).not.toHaveBeenCalled();
	});

	it('previews changes without writing in dry-run mode', async () => {
		const update = jest.fn(async () => {});
		const summary = await executeDistributionChannelSync(
			[item],
			'CLIENT',
			'api',
			'app',
			'test.invalid',
			true,
			{ update },
		);

		expect(summary.updated).toBe(1);
		expect(summary.results[0].status).toBe('updated');
		expect(update).not.toHaveBeenCalled();
	});

	it('updates each changed flag and isolates failures', async () => {
		const update = jest.fn(
			async (
				_apiKey: string,
				_appKey: string,
				flagId: string,
			): Promise<void> => {
				if (flagId === 'flag-2') throw new Error('write denied');
			},
		);
		const summary = await executeDistributionChannelSync(
			[item, { ...item, sourceKey: 'search', datadogFlagId: 'flag-2' }],
			'ALL',
			'api',
			'app',
			'test.invalid',
			false,
			{ update },
		);

		expect(summary.updated).toBe(1);
		expect(summary.failed).toBe(1);
		expect(summary.results[1]).toMatchObject({
			status: 'failed',
			error: 'Error: write denied',
		});
		expect(update).toHaveBeenCalledTimes(2);
	});
});

describe('distribution channel spreadsheet export', () => {
	it('writes old and target channels with result labels', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'sync-distribution-channel-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		const summary: DistributionChannelSyncSummary = {
			targetChannel: 'ALL',
			dryRun: true,
			updated: 1,
			unchanged: 1,
			failed: 0,
			results: [
				{ ...item, targetChannel: 'ALL', status: 'updated' },
				{
					...item,
					sourceKey: 'already-both',
					currentChannel: 'ALL',
					targetChannel: 'ALL',
					status: 'unchanged',
				},
			],
		};

		try {
			const filepath = await exportDistributionChannelSyncToXlsx(
				summary,
				outputDirectory,
			);
			expect(filepath).toMatch(/sync-distribution-channel-export-.*\.xlsx$/);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Distribution Channels');
			expect(worksheet?.getCell('A5').value).toBe('already-both');
			expect(worksheet?.getCell('F5').value).toBe('Unchanged');
			expect(worksheet?.getCell('A6').value).toBe('checkout');
			expect(worksheet?.getCell('D6').value).toBe('SERVER');
			expect(worksheet?.getCell('E6').value).toBe('ALL');
			expect(worksheet?.getCell('F6').value).toBe('Would update');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
