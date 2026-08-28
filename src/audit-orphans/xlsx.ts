import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	fillSolid,
} from '../helpers/xlsx-helpers.js';
import type { LaunchDarklyFlagComparison } from './launchdarkly.js';

const KEY_COLUMN_WIDTH = 40;
const SPACER_COLUMN_WIDTH = KEY_COLUMN_WIDTH * 0.25;

export interface FlagComparisonReportDetails {
	comparison: LaunchDarklyFlagComparison;
	projectKey: string;
	datadogSite: string;
	datadogFlagCount: number;
	launchDarklyFlagCount: number;
	runAt: Date;
}

export async function exportFlagComparisonToXlsx(
	details: FlagComparisonReportDetails,
	outputDirectory = process.cwd(),
): Promise<string> {
	const {
		comparison,
		projectKey,
		datadogSite,
		datadogFlagCount,
		launchDarklyFlagCount,
		runAt,
	} = details;
	const { datadogExclusiveKeys, launchDarklyExclusiveKeys } = comparison;

	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Datadog Feature Flag Migration Tool';
	workbook.created = runAt;

	const worksheet = workbook.addWorksheet('Exclusive Flags');
	worksheet.columns = [
		{ width: KEY_COLUMN_WIDTH },
		{ width: SPACER_COLUMN_WIDTH },
		{ width: KEY_COLUMN_WIDTH },
	];

	const runLabel = runAt.toLocaleString('en-US');
	addSheetHeader(
		worksheet,
		3,
		'Feature Flag Comparison Report — LaunchDarkly ↔ Datadog',
		`Comparison run on ${runLabel} for LaunchDarkly project ${projectKey} and Datadog site ${datadogSite}. Compared ${datadogFlagCount} active Datadog flag(s) with ${launchDarklyFlagCount} LaunchDarkly flag(s). Matching uses equal keys and project-scoped migration metadata so intentionally renamed migrated flags are not reported as exclusive.`,
	);
	addHeaderRow(worksheet, [
		`Datadog Exclusive (${datadogExclusiveKeys.length})`,
		'',
		`LaunchDarkly Exclusive (${launchDarklyExclusiveKeys.length})`,
	]);

	const headerRow = worksheet.getRow(4);
	headerRow.getCell(2).fill = fillSolid(ARGB.white);

	const rowCount = Math.max(
		datadogExclusiveKeys.length,
		launchDarklyExclusiveKeys.length,
	);
	for (let index = 0; index < rowCount; index++) {
		worksheet.addRow([
			datadogExclusiveKeys[index] ?? '',
			'',
			launchDarklyExclusiveKeys[index] ?? '',
		]);
	}

	const timestamp = runAt.toISOString().replace(/[:.]/g, '-');
	const filename = `flag-comparison-${timestamp}.xlsx`;
	const filepath = path.join(outputDirectory, filename);
	await workbook.xlsx.writeFile(filepath);

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${datadogExclusiveKeys.length} Datadog-exclusive and ${launchDarklyExclusiveKeys.length} LaunchDarkly-exclusive flag(s) exported`,
		),
	);
	console.log();
	return filepath;
}
