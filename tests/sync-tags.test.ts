import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import {
	computeTargetTags,
	type TagSyncMode,
	type TagSyncSummary,
} from '../src/helpers/sync-tags.js';
import { exportTagSyncToXlsx } from '../src/sync-tags/xlsx.js';

describe('computeTargetTags', () => {
	describe('additive merge', () => {
		const mode: TagSyncMode = 'additive';

		it('unions source tags with existing tags', () => {
			const { target, added, removed } = computeTargetTags(
				mode,
				['env:prod', 'team:backend'],
				['env:prod', 'owner:alice'],
			);
			expect(target.sort()).toEqual(
				['env:prod', 'team:backend', 'owner:alice'].sort(),
			);
			expect(added).toEqual(['team:backend']);
			expect(removed).toEqual([]);
		});

		it('never removes tags that exist only in Datadog', () => {
			const { target, removed } = computeTargetTags(
				mode,
				[],
				['owner:alice', 'env:prod'],
			);
			expect(target.sort()).toEqual(['owner:alice', 'env:prod'].sort());
			expect(removed).toEqual([]);
		});

		it('deduplicates overlapping tags', () => {
			const { target, added } = computeTargetTags(
				mode,
				['env:prod'],
				['env:prod'],
			);
			expect(target).toEqual(['env:prod']);
			expect(added).toEqual([]);
		});

		it('reports no changes when source is a subset of existing', () => {
			const { added, removed } = computeTargetTags(
				mode,
				['env:prod'],
				['env:prod', 'owner:alice'],
			);
			expect(added).toEqual([]);
			expect(removed).toEqual([]);
		});
	});

	describe('full replace', () => {
		const mode: TagSyncMode = 'replace';

		it('replaces Datadog tags with exactly the source tags', () => {
			const { target, added, removed } = computeTargetTags(
				mode,
				['env:prod', 'team:backend'],
				['env:prod', 'owner:alice'],
			);
			expect(target.sort()).toEqual(['env:prod', 'team:backend'].sort());
			expect(added).toEqual(['team:backend']);
			expect(removed).toEqual(['owner:alice']);
		});

		it('removes all tags when source is empty', () => {
			const { target, added, removed } = computeTargetTags(
				mode,
				[],
				['owner:alice', 'env:prod'],
			);
			expect(target).toEqual([]);
			expect(added).toEqual([]);
			expect(removed.sort()).toEqual(['owner:alice', 'env:prod'].sort());
		});

		it('adds all source tags when Datadog has none', () => {
			const { target, added, removed } = computeTargetTags(
				mode,
				['env:prod', 'team:backend'],
				[],
			);
			expect(target.sort()).toEqual(['env:prod', 'team:backend'].sort());
			expect(added.sort()).toEqual(['env:prod', 'team:backend'].sort());
			expect(removed).toEqual([]);
		});

		it('deduplicates source tags', () => {
			const { target } = computeTargetTags(mode, ['env:prod', 'env:prod'], []);
			expect(target).toEqual(['env:prod']);
		});

		it('reports no changes when source equals existing', () => {
			const { added, removed } = computeTargetTags(
				mode,
				['env:prod', 'owner:alice'],
				['owner:alice', 'env:prod'],
			);
			expect(added).toEqual([]);
			expect(removed).toEqual([]);
		});
	});
});

describe('tag sync spreadsheet export', () => {
	it('writes outcomes and skipped flags to an xlsx workbook', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'sync-tags-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		const summary: TagSyncSummary = {
			mode: 'replace',
			dryRun: false,
			synced: 1,
			unchanged: 1,
			failed: 1,
			skipped: 1,
			results: [
				{
					sourceKey: 'b-synced',
					datadogKey: 'dd-b',
					datadogFlagId: 'flag-b',
					mode: 'replace',
					status: 'synced',
					sourceTags: ['project:one', 'team:backend'],
					existingTags: ['project:one', 'owner:alice'],
					targetTags: ['project:one', 'team:backend'],
					added: ['team:backend'],
					removed: ['owner:alice'],
				},
				{
					sourceKey: 'a-unchanged',
					datadogKey: 'dd-a',
					datadogFlagId: 'flag-a',
					mode: 'replace',
					status: 'unchanged',
					sourceTags: ['project:one'],
					existingTags: ['project:one'],
					targetTags: ['project:one'],
					added: [],
					removed: [],
				},
				{
					sourceKey: 'c-failed',
					datadogKey: 'dd-c',
					datadogFlagId: 'flag-c',
					mode: 'replace',
					status: 'failed',
					sourceTags: ['project:one'],
					existingTags: ['owner:alice'],
					targetTags: ['project:one'],
					added: ['project:one'],
					removed: ['owner:alice'],
					error: 'Datadog write failed',
				},
			],
			skippedFlags: [
				{
					sourceKey: 'd-skipped',
					reason: 'no matching flag exists in Datadog yet',
				},
			],
		};

		try {
			const filepath = await exportTagSyncToXlsx(summary, outputDirectory);

			expect(filepath).toMatch(/sync-tags-export-.*\.xlsx$/);
			expect(fs.existsSync(filepath)).toBe(true);

			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Tag Sync');
			expect(worksheet?.getCell('A5').value).toBe('a-unchanged');
			expect(worksheet?.getCell('E5').value).toBe('Unchanged');
			expect(worksheet?.getCell('A6').value).toBe('b-synced');
			expect(worksheet?.getCell('B6').value).toBe('dd-b');
			expect(worksheet?.getCell('E6').value).toBe('Synced');
			expect(worksheet?.getCell('I6').value).toBe('team:backend');
			expect(worksheet?.getCell('J6').value).toBe('owner:alice');
			expect(worksheet?.getCell('A7').value).toBe('c-failed');
			expect(worksheet?.getCell('E7').value).toBe('Failed');
			expect(worksheet?.getCell('K7').value).toBe('Datadog write failed');

			const skippedWorksheet = workbook.getWorksheet('Skipped Flags');
			expect(skippedWorksheet?.getCell('A5').value).toBe('d-skipped');
			expect(skippedWorksheet?.getCell('B5').value).toBe('Skipped');
			expect(skippedWorksheet?.getCell('C5').value).toBe(
				'no matching flag exists in Datadog yet',
			);
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
