import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import { formatAxiosError } from '../helpers/format-axios-error.js';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../helpers/xlsx-helpers.js';
import type { TargetingAttributeEnvironmentResult } from './process.js';

export interface TargetingAttributeInspectionFailure {
	flagId: string;
	flagKey: string;
	error: unknown;
}

const STATUS_COLOR: Record<
	TargetingAttributeEnvironmentResult['status'] | 'Inspection failed',
	string
> = {
	Updated: ARGB.created,
	'Approval requested': ARGB.skipped,
	Failed: ARGB.failed,
	'Inspection failed': ARGB.failed,
};

export async function exportTargetingAttributeCleanupToXlsx(
	results: TargetingAttributeEnvironmentResult[],
	organizationName: string,
	inspectionFailures: TargetingAttributeInspectionFailure[] = [],
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const worksheet = workbook.addWorksheet('Targeting Attribute Changes');
	const headers = [
		'Flag Key',
		'Flag ID',
		'Environment Name',
		'Environment ID',
		'Targeting Filter Name',
		'Targeting Filter Key',
		'Previous Attribute',
		'Updated Attribute',
		'Result',
		'Warning',
		'Error',
	];
	worksheet.columns = [
		{ width: 36 },
		{ width: 38 },
		{ width: 28 },
		{ width: 38 },
		{ width: 36 },
		{ width: 48 },
		{ width: 42 },
		{ width: 42 },
		{ width: 22 },
		{ width: 54 },
		{ width: 60 },
	];
	addSheetHeader(
		worksheet,
		headers.length,
		`Targeting Attribute Cleanup Report for ${organizationName}`,
		`Cleanup completed on ${new Date().toLocaleString('en-US')}. Green rows were updated, yellow rows require approval, and red rows failed or could not be inspected.`,
	);
	addHeaderRow(worksheet, headers);

	for (const result of results
		.slice()
		.sort(
			(a, b) =>
				a.flag.key.localeCompare(b.flag.key) ||
				a.environment.environmentName.localeCompare(
					b.environment.environmentName,
				),
		)) {
		for (const change of result.environment.changes) {
			const row = worksheet.addRow([
				result.flag.key,
				result.flag.id,
				result.environment.environmentName,
				result.environment.environmentId,
				change.allocationName,
				change.allocationKey,
				change.previousAttribute,
				change.updatedAttribute,
				result.status,
				result.status === 'Approval requested'
					? 'Change submitted and awaiting approval'
					: '',
				result.error === undefined ? '' : formatAxiosError(result.error),
			]);
			colorRow(row, STATUS_COLOR[result.status]);
		}
	}

	for (const failure of inspectionFailures
		.slice()
		.sort((a, b) => a.flagKey.localeCompare(b.flagKey))) {
		const row = worksheet.addRow([
			failure.flagKey,
			failure.flagId,
			'',
			'',
			'',
			'',
			'',
			'',
			'Inspection failed',
			'Flag was not inspected; no changes were attempted',
			formatAxiosError(failure.error),
		]);
		colorRow(row, STATUS_COLOR['Inspection failed']);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filepath = path.join(
		outputDirectory,
		`clean-targeting-attributes-export-${timestamp}.xlsx`,
	);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${results.reduce((count, result) => count + result.environment.changes.length, 0)} attribute result(s) and ${inspectionFailures.length} inspection failure(s) exported`,
		),
	);
	console.log();
	return filepath;
}
