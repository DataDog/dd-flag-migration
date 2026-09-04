import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import type {
	DistributionChannelSyncOutcome,
	DistributionChannelSyncSummary,
} from '../helpers/sync-distribution-channel.js';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../helpers/xlsx-helpers.js';

const STATUS_COLOR: Record<DistributionChannelSyncOutcome['status'], string> = {
	updated: ARGB.created,
	unchanged: ARGB.skipped,
	failed: ARGB.failed,
};

function resultLabel(
	outcome: DistributionChannelSyncOutcome,
	dryRun: boolean,
): string {
	if (outcome.status === 'updated') {
		return dryRun ? 'Would update' : 'Updated';
	}
	if (outcome.status === 'unchanged') return 'Unchanged';
	return 'Failed';
}

export async function exportDistributionChannelSyncToXlsx(
	summary: DistributionChannelSyncSummary,
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const worksheet = workbook.addWorksheet('Distribution Channels');
	const headers = [
		'Source Flag Key',
		'Datadog Flag Key',
		'Datadog Flag ID',
		'Previous Channel',
		'Target Channel',
		'Result',
		'Error',
	];
	worksheet.columns = [
		{ width: 32 },
		{ width: 32 },
		{ width: 38 },
		{ width: 20 },
		{ width: 20 },
		{ width: 18 },
		{ width: 60 },
	];
	addSheetHeader(
		worksheet,
		headers.length,
		'Feature Flag Distribution Channel Sync Report',
		`${summary.dryRun ? 'Dry-run preview' : 'Update'} completed on ${new Date().toLocaleString('en-US')}. Distribution channels are flag-scoped and apply across all environments.`,
	);
	addHeaderRow(worksheet, headers);

	for (const outcome of summary.results
		.slice()
		.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))) {
		const row = worksheet.addRow([
			outcome.sourceKey,
			outcome.datadogKey,
			outcome.datadogFlagId,
			outcome.currentChannel ?? 'Unknown',
			outcome.targetChannel,
			resultLabel(outcome, summary.dryRun),
			outcome.error ?? '',
		]);
		colorRow(row, STATUS_COLOR[outcome.status]);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filepath = path.join(
		outputDirectory,
		`sync-distribution-channel-export-${timestamp}.xlsx`,
	);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${summary.results.length} distribution-channel result${summary.results.length === 1 ? '' : 's'} exported`,
		),
	);
	console.log();
	return filepath;
}
