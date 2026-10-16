import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
	safeCell,
} from '../helpers/xlsx-helpers.js';
import type { DatadogMigrationFile } from './types.js';

type RowStatus = 'Created' | 'Synced' | 'Failed' | 'Skipped';

export interface DatadogMigrationSheetRow {
	status: RowStatus;
	name: string;
	key: string;
	details: string;
}

export function buildDatadogMigrationRows(
	migration: DatadogMigrationFile,
): DatadogMigrationSheetRow[] {
	const errors = new Map(migration.failures.map((f) => [f.key, f.error]));
	const skipped = new Map(
		(migration.skippedFlags ?? []).map((f) => [f.key, f.reason]),
	);
	const synced = new Set(migration.syncedFlagKeys ?? []);
	const environmentIssues = new Map<string, string[]>();
	const addIssue = (key: string, issue: string) =>
		environmentIssues.set(key, [...(environmentIssues.get(key) ?? []), issue]);
	for (const f of migration.enableFailures)
		addIssue(f.key, `Could not enable in ${f.env}: ${f.error}`);
	for (const f of migration.disableFailures)
		addIssue(f.key, `Could not disable in ${f.env}: ${f.error}`);
	for (const f of migration.disableApprovalRequests)
		addIssue(f.key, `Disable in ${f.env} is awaiting approval`);

	return migration.flags.map((flag) => {
		const error = errors.get(flag.key);
		if (error !== undefined) {
			return {
				status: 'Failed',
				name: flag.name,
				key: flag.key,
				details: error,
			};
		}
		const reason = skipped.get(flag.key);
		if (reason !== undefined) {
			return {
				status: 'Skipped',
				name: flag.name,
				key: flag.key,
				details: reason,
			};
		}
		return {
			status: synced.has(flag.key) ? 'Synced' : 'Created',
			name: flag.name,
			key: flag.key,
			details: (environmentIssues.get(flag.key) ?? []).join('\n'),
		};
	});
}

const ROW_COLORS: Record<RowStatus, string> = {
	Created: ARGB.created,
	Synced: ARGB.created,
	Failed: ARGB.failed,
	Skipped: ARGB.skipped,
};

/** Export a Datadog-to-Datadog migration record to an .xlsx file. */
export async function exportDatadogMigrationToXlsx(
	migration: DatadogMigrationFile,
	directory = process.cwd(),
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Datadog Feature Flag Migration';
	const sheet = workbook.addWorksheet('Migration');
	addSheetHeader(
		sheet,
		4,
		'Datadog → Datadog Migration',
		`Flags copied from the source org (${migration.sourceSite}) to the target org (${migration.targetSite}).`,
	);
	for (const mapping of migration.environmentMapping) {
		sheet.addRow([
			safeCell(
				`${mapping.sourceEnvName} (source org) → ${mapping.datadogEnvName} (target org)`,
			),
		]);
	}
	sheet.addRow([]);
	addHeaderRow(sheet, ['Status', 'Flag name', 'Flag key', 'Details']);
	const rows = buildDatadogMigrationRows(migration);
	for (const row of rows) {
		const added = sheet.addRow(
			[row.status, row.name, row.key, row.details].map(safeCell),
		);
		colorRow(added, ROW_COLORS[row.status]);
	}
	sheet.getColumn(1).width = 12;
	sheet.getColumn(2).width = 36;
	sheet.getColumn(3).width = 36;
	sheet.getColumn(4).width = 80;

	const timestamp = migration.migratedAt.replace(/[:.]/g, '-');
	const filepath = path.join(
		directory,
		`migration-export-datadog-${timestamp}.xlsx`,
	);
	await workbook.xlsx.writeFile(filepath);
	console.log(
		chalk.green(`\n  Exported ${rows.length} flag(s) to ${filepath}`),
	);
	return filepath;
}
