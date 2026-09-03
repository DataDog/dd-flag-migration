import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../helpers/xlsx-helpers.js';
import type { AddTagsResult } from './process.js';

const STATUS_COLOR: Record<AddTagsResult['status'], string> = {
	Updated: ARGB.created,
	'Already tagged': ARGB.skipped,
	Failed: ARGB.failed,
};

export async function exportAddTagsToXlsx(
	results: AddTagsResult[],
	requestedTags: string[],
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const worksheet = workbook.addWorksheet('Tag Changes');
	const headers = [
		'Flag Key',
		'Flag ID',
		'Result',
		'Requested Tags',
		'Existing Tags',
		'Added Tags',
		'Resulting Tags',
		'Error',
	];

	worksheet.columns = [
		{ width: 32 },
		{ width: 38 },
		{ width: 18 },
		{ width: 48 },
		{ width: 48 },
		{ width: 48 },
		{ width: 48 },
		{ width: 60 },
	];

	addSheetHeader(
		worksheet,
		headers.length,
		'Feature Flag Add Tags Report',
		`Tag additions completed on ${new Date().toLocaleString('en-US')}. Green rows were updated, yellow rows already contained every requested tag, and red rows failed.`,
	);
	addHeaderRow(worksheet, headers);

	for (const result of results
		.slice()
		.sort((a, b) => a.flagKey.localeCompare(b.flagKey))) {
		const row = worksheet.addRow([
			result.flagKey,
			result.flagId,
			result.status,
			requestedTags.join(', '),
			result.existingTags.join(', '),
			result.addedTags.join(', '),
			result.resultingTags.join(', '),
			result.error ?? '',
		]);
		colorRow(row, STATUS_COLOR[result.status]);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filepath = path.join(
		outputDirectory,
		`add-tags-export-${timestamp}.xlsx`,
	);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${results.length} flag result${results.length === 1 ? '' : 's'} exported`,
		),
	);
	console.log();
	return filepath;
}
