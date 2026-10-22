import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import {
	type Assignment,
	compareFlagForSubjects,
} from '../src/evaluate/flag-comparison.js';
import {
	exportFlagEvaluationToXlsx,
	flagEvaluationExportFilename,
} from '../src/evaluate/flag-xlsx.js';
import { ARGB } from '../src/helpers/xlsx-helpers.js';

const assigned = (value: unknown, allocation: string): Assignment => ({
	assigned: true,
	value,
	variant: String(value),
	allocation,
});

const INFO = {
	sourceLabel: 'Eppo',
	sourceFlagKey: 'checkout',
	sourceEnvironment: 'Production',
	datadogEnvironment: 'Production',
	ddEnv: 'prod',
	bucketingMode: 'EPPO',
	distributionChannel: 'server',
};

function fillOf(row: ExcelJS.Row): string | undefined {
	const fill = row.getCell(1).fill;
	return fill?.type === 'pattern' ? fill.fgColor?.argb : undefined;
}

describe('exportFlagEvaluationToXlsx', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-xlsx-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes a summary and one colored row per evaluation, mismatches first', async () => {
		const result = await compareFlagForSubjects({
			flagKey: 'checkout',
			environment: 'Production → Production',
			subjectKeys: ['=match', 'differs', 'one-sided'],
			contexts: [{ label: 'country=US', attributes: { country: 'US' } }],
			evaluateSource: () => assigned(true, 'rollout'),
			evaluateDatadog: (subjectKey) =>
				subjectKey === 'differs'
					? assigned(false, 'default')
					: subjectKey === 'one-sided'
						? {
								assigned: false,
								value: undefined,
								variant: null,
								allocation: null,
								detail: 'DISABLED',
							}
						: assigned(true, 'rollout'),
		});

		const filepath = await exportFlagEvaluationToXlsx(
			result,
			INFO,
			path.join(dir, 'out.xlsx'),
		);
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.readFile(filepath);

		expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
			'Summary',
			'Evaluations',
		]);
		const summary = workbook.getWorksheet('Summary');
		const summaryRows: unknown[][] = [];
		summary?.eachRow((row) =>
			summaryRows.push([row.getCell(1).value, row.getCell(2).value]),
		);
		expect(summaryRows).toContainEqual([
			'Datadog environment',
			'Production (DD_ENV prod)',
		]);
		expect(summaryRows).toContainEqual(['Evaluations', 3]);
		expect(summaryRows).toContainEqual(['Mismatches', 2]);
		// Eppo served the rollout to every subject; Datadog to one of them.
		expect(summaryRows).toContainEqual(['rollout → true', 3]);
		expect(summaryRows).toContainEqual(['rollout → true', 1]);
		expect(summaryRows).toContainEqual(['default → false', 1]);

		const sheet = workbook.getWorksheet('Evaluations');
		if (!sheet) throw new Error('missing Evaluations sheet');
		expect(sheet.getRow(4).getCell(1).value).toBe('Subject Key');
		expect(sheet.autoFilter).toBe('A4:J4');
		expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });

		const rows = [5, 6, 7].map((n) => sheet.getRow(n));
		expect(
			rows.map((row) => [row.getCell(1).value, row.getCell(10).value]),
		).toEqual([
			['differs', 'Different value'],
			['one-sided', 'Only Eppo assigned'],
			// Leading "=" is escaped so the cell is not read as a formula.
			["'=match", 'Match'],
		]);
		expect(rows.map(fillOf)).toEqual([
			ARGB.errorRed,
			ARGB.diffYellow,
			ARGB.matchGreen,
		]);
		expect(rows[0].getCell(3).value).toBe('{"country":"US"}');
		expect(rows[1].getCell(8).value).toBe('(no assignment: DISABLED)');
	});
});

describe('flagEvaluationExportFilename', () => {
	it('makes the flag key safe for a filename', () => {
		expect(
			flagEvaluationExportFilename(
				'team/checkout flag',
				new Date('2026-10-22T15:00:00.000Z'),
			),
		).toBe('flag-evaluation-team_checkout_flag-2026-10-22T15-00-00-000Z.xlsx');
	});
});
