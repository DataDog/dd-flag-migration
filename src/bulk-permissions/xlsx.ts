import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../helpers/xlsx-helpers.js';
import type {
	PermissionChangeResult,
	PermissionOperation,
	TagSyncResult,
} from './types.js';

const STATUS_COLOR: Record<PermissionChangeResult['status'], string> = {
	Added: ARGB.created,
	Removed: ARGB.created,
	'Already present': ARGB.skipped,
	'Not present': ARGB.skipped,
	Failed: ARGB.failed,
};

const TAG_STATUS_COLOR: Record<TagSyncResult['status'], string> = {
	Updated: ARGB.created,
	'Already synced': ARGB.skipped,
	Failed: ARGB.failed,
};

function addTagSyncSheet(
	workbook: ExcelJS.Workbook,
	results: TagSyncResult[],
	operationLabel: string,
): void {
	if (results.length === 0) return;

	const ws = workbook.addWorksheet('Tag Sync');
	const headers = [
		'Flag Key',
		'Flag ID',
		'Targeted Team Tags',
		'Operation',
		'Result',
		'Error',
	];
	ws.columns = [
		{ width: 32 },
		{ width: 38 },
		{ width: 48 },
		{ width: 12 },
		{ width: 18 },
		{ width: 60 },
	];
	addSheetHeader(
		ws,
		headers.length,
		'Team Tag Sync Report',
		`${operationLabel} operation completed on ${new Date().toLocaleString('en-US')}. These results are independent from the permission changes on the Permission Changes sheet.`,
	);
	addHeaderRow(ws, headers);

	for (const result of results
		.slice()
		.sort((a, b) => a.flagKey.localeCompare(b.flagKey))) {
		const row = ws.addRow([
			result.flagKey,
			result.flagId,
			result.targetedTags.join(', '),
			result.operation === 'add' ? 'Add' : 'Remove',
			result.status,
			result.error ?? '',
		]);
		colorRow(row, TAG_STATUS_COLOR[result.status]);
	}
}

export async function exportBulkPermissionChangesToXlsx(
	results: PermissionChangeResult[],
	operation: PermissionOperation,
	tagSyncResults: TagSyncResult[] = [],
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const ws = workbook.addWorksheet('Permission Changes');
	const headers = [
		'Flag Key',
		'Flag ID',
		'Flag Tags',
		'Team Name',
		'Team Handle',
		'Team ID',
		'Operation',
		'Permission Policy',
		'Result',
		'Error',
	];

	ws.columns = [
		{ width: 32 },
		{ width: 38 },
		{ width: 36 },
		{ width: 28 },
		{ width: 24 },
		{ width: 38 },
		{ width: 12 },
		{ width: 20 },
		{ width: 18 },
		{ width: 60 },
	];

	const operationLabel = operation === 'add' ? 'Add teams' : 'Remove teams';
	addSheetHeader(
		ws,
		headers.length,
		'Bulk Feature Flag Permission Report',
		`${operationLabel} operation completed on ${new Date().toLocaleString('en-US')}. Green rows changed an explicit team permission, yellow rows were idempotent no-ops, and red rows failed.`,
	);
	addHeaderRow(ws, headers);

	const sortedResults = results
		.slice()
		.sort(
			(a, b) =>
				a.flagKey.localeCompare(b.flagKey) ||
				a.teamName.localeCompare(b.teamName) ||
				a.teamHandle.localeCompare(b.teamHandle),
		);
	for (const result of sortedResults) {
		const row = ws.addRow([
			result.flagKey,
			result.flagId,
			result.flagTags.join(', '),
			result.teamName,
			result.teamHandle,
			result.teamId,
			result.operation === 'add' ? 'Add' : 'Remove',
			result.relation ?? '',
			result.status,
			result.error ?? '',
		]);
		colorRow(row, STATUS_COLOR[result.status]);
	}
	addTagSyncSheet(workbook, tagSyncResults, operationLabel);

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filename = `bulk-permissions-export-${timestamp}.xlsx`;
	const filepath = path.join(outputDirectory, filename);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${results.length} flag/team result${results.length === 1 ? '' : 's'} exported${tagSyncResults.length > 0 ? `; ${tagSyncResults.length} tag-sync result${tagSyncResults.length === 1 ? '' : 's'} exported` : ''}`,
		),
	);
	console.log();
	return filepath;
}
