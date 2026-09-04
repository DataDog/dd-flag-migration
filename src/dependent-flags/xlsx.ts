import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import { ARGB, addHeaderRow, colorRow } from '../helpers/xlsx-helpers.js';
import {
	compareDependentFlagRows,
	type DependentFlagReportRow,
} from './report.js';

export const DEPENDENT_FLAG_HEADERS = [
	'LD Project',
	'Datadog Org',
	'LD Environment',
	'LD Environment Key',
	'LD Dependent Flag',
	'LD Dependent Flag Key',
	'LD Prerequisite Flag',
	'LD Prerequisite Flag Key',
	'Required Variation Index',
	'Required Variation Name',
	'Required Variation Value',
	'Owner in LD',
	'Code Update',
	'Verified in DD',
] as const;

function formatVariationValue(value: unknown): string | number | boolean {
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (value === undefined) return '';
	return JSON.stringify(value);
}

export async function exportDependentFlagsToXlsx(
	rows: DependentFlagReportRow[],
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const worksheet = workbook.addWorksheet('Dependent Flags');

	worksheet.columns = [
		{ width: 34 },
		{ width: 24 },
		{ width: 24 },
		{ width: 24 },
		{ width: 38 },
		{ width: 38 },
		{ width: 38 },
		{ width: 38 },
		{ width: 24 },
		{ width: 28 },
		{ width: 36 },
		{ width: 28 },
		{ width: 24 },
		{ width: 24 },
	];

	addHeaderRow(worksheet, [...DEPENDENT_FLAG_HEADERS]);
	worksheet.autoFilter = {
		from: { row: 1, column: 1 },
		to: { row: 1, column: DEPENDENT_FLAG_HEADERS.length },
	};

	for (const result of rows.slice().sort(compareDependentFlagRows)) {
		const row = worksheet.addRow([
			result.projectKey,
			result.datadogOrg,
			result.environmentName,
			result.environmentKey,
			result.dependentFlagName,
			result.dependentFlagKey,
			result.prerequisiteFlagName,
			result.prerequisiteFlagKey,
			result.requiredVariationIndex,
			result.requiredVariationName,
			formatVariationValue(result.requiredVariationValue),
			result.owner,
			'',
			'',
		]);
		row.alignment = { vertical: 'top', wrapText: true };
		if (result.unresolved) colorRow(row, ARGB.failed);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filepath = path.join(
		outputDirectory,
		`dependent-flags-export-${timestamp}.xlsx`,
	);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${rows.length} dependent-flag relationship${rows.length === 1 ? '' : 's'} exported`,
		),
	);
	console.log();
	return filepath;
}
