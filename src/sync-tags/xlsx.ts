import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import type { TagSyncOutcome, TagSyncSummary } from '../helpers/sync-tags.js';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../helpers/xlsx-helpers.js';

const STATUS_COLOR: Record<TagSyncOutcome['status'], string> = {
	synced: ARGB.created,
	unchanged: ARGB.skipped,
	failed: ARGB.failed,
};

function resultLabel(outcome: TagSyncOutcome, dryRun: boolean): string {
	if (outcome.status === 'synced') {
		return dryRun ? 'Would sync' : 'Synced';
	}
	if (outcome.status === 'unchanged') return 'Unchanged';
	return 'Failed';
}

/**
 * Write a tag-sync report in the current directory (or a caller-supplied
 * output directory). The primary sheet includes every Datadog tag operation;
 * an optional second sheet documents source flags that could not be matched to
 * an existing Datadog flag.
 */
export async function exportTagSyncToXlsx(
	summary: TagSyncSummary,
	outputDirectory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const ws = workbook.addWorksheet('Tag Sync');
	const headers = [
		'Source Flag Key',
		'Datadog Flag Key',
		'Datadog Flag ID',
		'Sync Strategy',
		'Result',
		'Source Tags',
		'Existing Datadog Tags',
		'Target Datadog Tags',
		'Added Tags',
		'Removed Tags',
		'Error',
	];

	ws.columns = [
		{ width: 32 },
		{ width: 32 },
		{ width: 38 },
		{ width: 20 },
		{ width: 18 },
		{ width: 48 },
		{ width: 48 },
		{ width: 48 },
		{ width: 48 },
		{ width: 48 },
		{ width: 60 },
	];

	const operation = summary.dryRun ? 'Dry-run tag sync' : 'Tag sync';
	addSheetHeader(
		ws,
		headers.length,
		'Feature Flag Tag Sync Report',
		`${operation} completed on ${new Date().toLocaleString('en-US')} using ${summary.mode === 'additive' ? 'Additive Merge' : 'Full Replace'}. Green rows changed tags (or would change them in a dry run), yellow rows were already in sync, and red rows failed.`,
	);
	addHeaderRow(ws, headers);

	for (const outcome of summary.results
		.slice()
		.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))) {
		const row = ws.addRow([
			outcome.sourceKey,
			outcome.datadogKey,
			outcome.datadogFlagId,
			outcome.mode === 'additive' ? 'Additive Merge' : 'Full Replace',
			resultLabel(outcome, summary.dryRun),
			outcome.sourceTags.join(', '),
			outcome.existingTags.join(', '),
			outcome.targetTags.join(', '),
			outcome.added.join(', '),
			outcome.removed.join(', '),
			outcome.error ?? '',
		]);
		colorRow(row, STATUS_COLOR[outcome.status]);
	}

	if (summary.skippedFlags.length > 0) {
		const skippedWs = workbook.addWorksheet('Skipped Flags');
		const skippedHeaders = ['Source Flag Key', 'Result', 'Reason'];
		skippedWs.columns = [{ width: 32 }, { width: 18 }, { width: 72 }];
		addSheetHeader(
			skippedWs,
			skippedHeaders.length,
			'Feature Flag Tag Sync Skipped Flags',
			'Source flags are skipped when no safe matching Datadog flag exists. No Datadog tag write was attempted for these rows.',
		);
		addHeaderRow(skippedWs, skippedHeaders);
		for (const skipped of summary.skippedFlags
			.slice()
			.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))) {
			const row = skippedWs.addRow([
				skipped.sourceKey,
				'Skipped',
				skipped.reason,
			]);
			colorRow(row, ARGB.skipped);
		}
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filename = `sync-tags-export-${timestamp}.xlsx`;
	const filepath = path.join(outputDirectory, filename);
	await workbook.xlsx.writeFile(filepath);

	const rowCount = summary.results.length + summary.skippedFlags.length;
	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${rowCount} tag-sync result${rowCount === 1 ? '' : 's'} exported`,
		),
	);
	console.log();
	return filepath;
}
