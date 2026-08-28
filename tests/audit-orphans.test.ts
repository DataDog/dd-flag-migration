import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import { compareLaunchDarklyFlagKeys } from '../src/audit-orphans/launchdarkly.js';
import { exportFlagComparisonToXlsx } from '../src/audit-orphans/xlsx.js';
import type { DatadogFlagEntry } from '../src/datadog/types.js';
import type { LDFlag } from '../src/launchdarkly/types.js';

function ldFlag(key: string): LDFlag {
	return {
		key,
		name: key,
		kind: 'boolean',
		variations: [],
		defaults: { onVariation: 0, offVariation: 1 },
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};
}

describe('compareLaunchDarklyFlagKeys', () => {
	it('lists keys exclusive to each provider', () => {
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'shared',
				key: 'shared',
			},
			{
				id: 'dd-only',
				key: 'dd-only',
			},
		];

		expect(
			compareLaunchDarklyFlagKeys(
				datadogFlags,
				[ldFlag('shared'), ldFlag('ld-only')],
				'store',
			),
		).toEqual({
			datadogExclusiveKeys: ['dd-only'],
			launchDarklyExclusiveKeys: ['ld-only'],
		});
	});

	it('matches a renamed Datadog flag using migration metadata', () => {
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'renamed',
				key: 'renamed-in-dd',
				migration_metadata: { project_key: 'store', flag_key: 'source-key' },
			},
		];

		expect(
			compareLaunchDarklyFlagKeys(
				datadogFlags,
				[ldFlag('source-key')],
				'store',
			),
		).toEqual({
			datadogExclusiveKeys: [],
			launchDarklyExclusiveKeys: [],
		});
	});

	it('does not use migration metadata from another project', () => {
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'other',
				key: 'renamed-in-dd',
				migration_metadata: {
					project_key: 'other-project',
					flag_key: 'source-key',
				},
			},
		];

		expect(
			compareLaunchDarklyFlagKeys(
				datadogFlags,
				[ldFlag('source-key')],
				'store',
			),
		).toEqual({
			datadogExclusiveKeys: ['renamed-in-dd'],
			launchDarklyExclusiveKeys: ['source-key'],
		});
	});

	it('sorts both exclusive key lists', () => {
		expect(
			compareLaunchDarklyFlagKeys(
				[
					{ id: 'z', key: 'z-dd' },
					{ id: 'a', key: 'a-dd' },
				],
				[ldFlag('z-ld'), ldFlag('a-ld')],
				'store',
			),
		).toEqual({
			datadogExclusiveKeys: ['a-dd', 'z-dd'],
			launchDarklyExclusiveKeys: ['a-ld', 'z-ld'],
		});
	});
});

describe('flag comparison spreadsheet export', () => {
	it('writes exclusive keys in columns separated by a 25%-width spacer', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'flag-comparison-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const runAt = new Date('2026-08-27T21:10:00.000Z');
			const filepath = await exportFlagComparisonToXlsx(
				{
					comparison: {
						datadogExclusiveKeys: ['dd-one', 'dd-two'],
						launchDarklyExclusiveKeys: ['ld-one'],
					},
					projectKey: 'store',
					datadogSite: 'us5.datadoghq.com',
					datadogFlagCount: 10,
					launchDarklyFlagCount: 9,
					runAt,
				},
				outputDirectory,
			);

			expect(filepath).toBe(
				path.join(
					outputDirectory,
					'flag-comparison-2026-08-27T21-10-00-000Z.xlsx',
				),
			);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Exclusive Flags');
			if (!worksheet) {
				throw new Error('Expected the Exclusive Flags worksheet');
			}

			expect(worksheet.getCell('A1').value).toBe(
				'Feature Flag Comparison Report — LaunchDarkly ↔ Datadog',
			);
			expect(worksheet.getCell('A2').value).toContain(
				'LaunchDarkly project store',
			);
			expect(worksheet.getCell('A2').value).toContain('us5.datadoghq.com');
			expect(worksheet.getCell('A4').value).toBe('Datadog Exclusive (2)');
			expect(worksheet.getCell('B4').value).toBe('');
			expect(worksheet.getCell('C4').value).toBe('LaunchDarkly Exclusive (1)');
			expect(worksheet.getColumn(2).width).toBe(
				(worksheet.getColumn(1).width ?? 0) * 0.25,
			);
			expect(worksheet.getCell('A5').value).toBe('dd-one');
			expect(worksheet.getCell('C5').value).toBe('ld-one');
			expect(worksheet.getCell('A6').value).toBe('dd-two');
			expect(worksheet.getCell('C6').value).toBe('');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
