import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../xlsx-helpers.js';
import type { LDFlag, LDMigrationFile } from './types.js';

// ─── LaunchDarkly Migration Export ───────────────────────────────────────────

type LDMigrationRowStatus = 'Created' | 'Synced' | 'Failed' | 'Skipped';

interface LDMigrationSheetRow {
	flag: LDFlag;
	status: LDMigrationRowStatus;
	error: string;
}

function buildLDMigrationRows(
	migration: LDMigrationFile,
): LDMigrationSheetRow[] {
	const failedKeys = new Set(migration.failures.map((f) => f.key));
	const skippedKeys = new Set((migration.skippedFlags ?? []).map((f) => f.key));
	const syncedKeys = new Set(migration.syncedFlagKeys ?? []);
	const errorByKey = new Map(migration.failures.map((f) => [f.key, f.error]));

	const rows: LDMigrationSheetRow[] = [];

	for (const flag of migration.flags) {
		if (failedKeys.has(flag.key)) {
			rows.push({
				flag,
				status: 'Failed',
				error: errorByKey.get(flag.key) ?? '',
			});
		} else if (skippedKeys.has(flag.key)) {
			rows.push({ flag, status: 'Skipped', error: '' });
		} else if (syncedKeys.has(flag.key)) {
			rows.push({ flag, status: 'Synced', error: '' });
		} else {
			rows.push({ flag, status: 'Created', error: '' });
		}
	}

	return rows.sort((a, b) => a.flag.name.localeCompare(b.flag.name));
}

const LD_MIGRATION_STATUS_ARGB: Record<LDMigrationRowStatus, string> = {
	Created: ARGB.created,
	Synced: ARGB.created,
	Failed: ARGB.failed,
	Skipped: ARGB.skipped,
};

function formatLDMaintainer(_flag: LDFlag): string {
	return '';
}

function formatLDVariations(flag: LDFlag): string {
	return flag.variations.map((v) => v.name ?? String(v.value)).join(', ');
}

function mapLDFlagKind(flag: LDFlag): string {
	if (flag.kind === 'boolean') return 'boolean';
	const val = flag.variations[0]?.value;
	if (typeof val === 'number') return 'number';
	if (typeof val === 'string') return 'string';
	if (typeof val === 'object' && val !== null) return 'json';
	return flag.kind;
}

export async function exportLDMigrationToXlsx(
	migration: LDMigrationFile,
): Promise<void> {
	const workbook = new ExcelJS.Workbook();
	const ws = workbook.addWorksheet('Migration Results');

	const headers = [
		'Flag Name',
		'Flag Key',
		'Flag Kind',
		'Variations',
		'Maintainer',
		'Tags',
		'Temporary',
		'Migration Status',
		'Error',
		'Action Required',
	];

	ws.columns = [
		{ width: 30 }, // Flag Name
		{ width: 30 }, // Flag Key
		{ width: 12 }, // Flag Kind
		{ width: 24 }, // Variations
		{ width: 24 }, // Maintainer
		{ width: 20 }, // Tags
		{ width: 10 }, // Temporary
		{ width: 18 }, // Migration Status
		{ width: 40 }, // Error
		{ width: 50 }, // Action Required
	];

	const migratedAt = new Date(migration.migratedAt);
	const dateLabel = migratedAt.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});

	addSheetHeader(
		ws,
		headers.length,
		'Flag Migration Report — LaunchDarkly → Datadog',
		`Migration completed on ${dateLabel}. Flags with status 'Created' require a code change: update your flag evaluation calls to reference the Datadog flag key shown in the 'Action Required' column. Flags with status 'Skipped' were not migrated (unsupported operator or archived).`,
	);
	addHeaderRow(ws, headers);

	const rows = buildLDMigrationRows(migration);

	for (const { flag, status, error } of rows) {
		const actionRequired =
			status === 'Created'
				? `Update your code to reference Datadog flag key: ${flag.key}`
				: '';

		const dataRow = ws.addRow([
			flag.name,
			flag.key,
			mapLDFlagKind(flag),
			formatLDVariations(flag),
			formatLDMaintainer(flag),
			flag.tags.join(', '),
			flag.temporary ? 'Yes' : 'No',
			status,
			error,
			actionRequired,
		]);
		colorRow(dataRow, LD_MIGRATION_STATUS_ARGB[status]);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filename = `migration-export-${timestamp}.xlsx`;
	const filepath = path.join(process.cwd(), filename);
	await workbook.xlsx.writeFile(filepath);

	const counts = {
		created: rows.filter((r) => r.status === 'Created').length,
		synced: rows.filter((r) => r.status === 'Synced').length,
		failed: rows.filter((r) => r.status === 'Failed').length,
		skipped: rows.filter((r) => r.status === 'Skipped').length,
	};

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${rows.length} flag${rows.length === 1 ? '' : 's'} exported (${counts.created} created, ${counts.synced} synced, ${counts.failed} failed, ${counts.skipped} skipped)`,
		),
	);
	console.log();
}
