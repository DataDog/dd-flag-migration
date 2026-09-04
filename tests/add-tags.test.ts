import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import {
	mergeFlagTags,
	parseSpaceDelimitedTags,
	processAddTags,
} from '../src/add-tags/process.js';
import { exportAddTagsToXlsx } from '../src/add-tags/xlsx.js';
import type { DatadogFlagEntry } from '../src/datadog/types.js';

describe('add tags', () => {
	it('parses whitespace-delimited tags and removes duplicates', () => {
		expect(
			parseSpaceDelimitedTags(' team:payments   env:prod\nteam:payments '),
		).toEqual(['team:payments', 'env:prod']);
	});

	it('merges requested tags while preserving existing tag order', () => {
		expect(
			mergeFlagTags(
				['existing', 'team:payments'],
				['team:payments', 'env:prod'],
			),
		).toEqual({
			tags: ['existing', 'team:payments', 'env:prod'],
			addedTags: ['env:prod'],
		});
	});

	it('updates changed flags, skips unchanged flags, and continues after failures', async () => {
		const flags: DatadogFlagEntry[] = [
			{
				id: 'changed',
				key: 'changed-flag',
				tags: ['existing'],
				migration_metadata: { provider: 'launchdarkly' },
			},
			{
				id: 'unchanged',
				key: 'unchanged-flag',
				tags: ['new-tag'],
				migration_metadata: { provider: 'eppo' },
			},
			{
				id: 'failed',
				key: 'failed-flag',
				tags: [],
				migration_metadata: { provider: 'eppo' },
			},
		];
		const updateTags = jest.fn(
			async (flag: DatadogFlagEntry, _tags: string[]) => {
				if (flag.id === 'failed') throw new Error('write failed');
			},
		);
		const fetchTags = jest.fn(async (flag: DatadogFlagEntry) =>
			flag.id === 'changed'
				? ['existing', 'concurrent-tag']
				: (flag.tags ?? []),
		);

		const results = await processAddTags(flags, ['new-tag'], {
			fetchTags,
			updateTags,
		});

		expect(fetchTags).toHaveBeenCalledTimes(3);
		expect(updateTags).toHaveBeenCalledTimes(2);
		expect(updateTags).toHaveBeenNthCalledWith(1, flags[0], [
			'existing',
			'concurrent-tag',
			'new-tag',
		]);
		expect(results.map((result) => result.status)).toEqual([
			'Updated',
			'Already tagged',
			'Failed',
		]);
		expect(results[2].error).toBe('write failed');
		expect(flags[0].tags).toEqual(['existing', 'concurrent-tag', 'new-tag']);
		expect(flags[2].tags).toEqual([]);
	});

	it('writes an optional XLSX report with tag outcomes', async () => {
		const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'add-tags-'));
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const filepath = await exportAddTagsToXlsx(
				[
					{
						flagId: 'flag-id',
						flagKey: 'flag-key',
						existingTags: ['existing'],
						addedTags: ['new-tag'],
						resultingTags: ['existing', 'new-tag'],
						status: 'Updated',
					},
				],
				['new-tag'],
				outputDirectory,
			);

			expect(filepath).toMatch(/add-tags-export-.*\.xlsx$/);
			expect(fs.existsSync(filepath)).toBe(true);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Tag Changes');
			expect(worksheet?.getCell('A5').value).toBe('flag-key');
			expect(worksheet?.getCell('C5').value).toBe('Updated');
			expect(worksheet?.getCell('D5').value).toBe('new-tag');
			expect(worksheet?.getCell('E5').value).toBe('existing');
			expect(worksheet?.getCell('G5').value).toBe('existing, new-tag');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
