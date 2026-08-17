import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../helpers/xlsx-helpers.js';
import type { BulkEnableResult } from './types.js';

const STATUS_COLOR: Record<BulkEnableResult['status'], string> = {
	Enabled: ARGB.created,
	'Enabled (prior status unknown)': ARGB.skipped,
	'Already enabled': ARGB.skipped,
	'Approval requested': ARGB.skipped,
	'Approval requested (prior status unknown)': ARGB.skipped,
	Failed: ARGB.failed,
};

export async function exportBulkEnableChangesToXlsx(
	results: BulkEnableResult[],
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const ws = workbook.addWorksheet('Environment Changes');
	const headers = [
		'Flag Key',
		'Flag ID',
		'Flag Tags',
		'Environment Name',
		'Environment ID',
		'Production',
		'Result',
		'Status Lookup Error',
		'Enable Error',
	];

	ws.columns = [
		{ width: 32 },
		{ width: 38 },
		{ width: 36 },
		{ width: 28 },
		{ width: 38 },
		{ width: 12 },
		{ width: 38 },
		{ width: 60 },
		{ width: 60 },
	];

	addSheetHeader(
		ws,
		headers.length,
		'Bulk Feature Flag Environment Enable Report',
		`Enable operation completed on ${new Date().toLocaleString('en-US')}. Green rows were confirmed newly enabled, yellow rows were already enabled, require approval, or have an unknown prior status, and red rows failed.`,
	);
	addHeaderRow(ws, headers);

	for (const result of results
		.slice()
		.sort(
			(a, b) =>
				a.flagKey.localeCompare(b.flagKey) ||
				a.environmentName.localeCompare(b.environmentName),
		)) {
		const row = ws.addRow([
			result.flagKey,
			result.flagId,
			result.flagTags.join(', '),
			result.environmentName,
			result.environmentId,
			result.isProduction ? 'Yes' : 'No',
			result.status,
			result.statusLookupError ?? '',
			result.error ?? '',
		]);
		colorRow(row, STATUS_COLOR[result.status]);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filename = `bulk-enable-export-${timestamp}.xlsx`;
	const filepath = path.join(outputDirectory, filename);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${results.length} flag/environment result${results.length === 1 ? '' : 's'} exported`,
		),
	);
	console.log();
	return filepath;
}
