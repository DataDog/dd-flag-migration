import path from 'node:path';
import chalk from 'chalk';
import ExcelJS from 'exceljs';
import type { RowColor } from '../evaluate/result-classifier.js';
import { classifyRow } from '../evaluate/result-classifier.js';
import type { EvaluationExportRow } from '../types.js';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
} from '../xlsx-helpers.js';
import type { EppoFlag, MigrationFile } from './types.js';

// ─── Migration Export ─────────────────────────────────────────────────────────

type MigrationRowStatus = 'Created' | 'Failed' | 'Skipped';

interface MigrationSheetRow {
	flag: EppoFlag;
	status: MigrationRowStatus;
	error: string;
}

function buildMigrationRows(migration: MigrationFile): MigrationSheetRow[] {
	const failedKeys = new Set(migration.failures.map((f) => f.key));
	const skippedKeys = new Set((migration.skippedFlags ?? []).map((f) => f.key));
	const errorByKey = new Map(migration.failures.map((f) => [f.key, f.error]));

	const rows: MigrationSheetRow[] = [];

	for (const flag of migration.flags) {
		if (failedKeys.has(flag.key)) {
			rows.push({
				flag,
				status: 'Failed',
				error: errorByKey.get(flag.key) ?? '',
			});
		} else if (skippedKeys.has(flag.key)) {
			rows.push({ flag, status: 'Skipped', error: '' });
		} else {
			rows.push({ flag, status: 'Created', error: '' });
		}
	}

	return rows.sort(
		(a, b) =>
			(a.flag.owner?.name ?? '').localeCompare(b.flag.owner?.name ?? '') ||
			a.flag.name.localeCompare(b.flag.name),
	);
}

const MIGRATION_STATUS_ARGB: Record<MigrationRowStatus, string> = {
	Created: ARGB.created,
	Failed: ARGB.failed,
	Skipped: ARGB.skipped,
};

export async function exportMigrationToXlsx(
	migration: MigrationFile,
): Promise<void> {
	const workbook = new ExcelJS.Workbook();
	const ws = workbook.addWorksheet('Migration Results');

	const headers = [
		'Flag Name',
		'Flag Key',
		'Flag Type',
		'Variations',
		'Team',
		'Tags',
		'Migration Status',
		'Error',
		'Action Required',
	];

	ws.columns = [
		{ width: 30 }, // Flag Name
		{ width: 30 }, // Flag Key
		{ width: 12 }, // Flag Type
		{ width: 24 }, // Variations
		{ width: 20 }, // Team
		{ width: 20 }, // Tags
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
		'Flag Migration Report — Eppo → Datadog',
		`Migration completed on ${dateLabel}. Flags with status 'Created' require a code change: update your flag evaluation calls to reference the Datadog flag key shown in the 'Action Required' column. Flags with status 'Skipped' were not migrated (unsupported type or targeting).`,
	);
	addHeaderRow(ws, headers);

	const rows = buildMigrationRows(migration);

	for (const { flag, status, error } of rows) {
		const variations =
			flag.variations?.map((v) => v.variant_key).join(', ') ?? '';
		const actionRequired =
			status === 'Created'
				? `Update your code to reference Datadog flag key: ${flag.key}`
				: '';

		const dataRow = ws.addRow([
			flag.name,
			flag.key,
			flag.variation_type,
			variations,
			flag.owner?.name ?? '',
			flag.tag_names.join(', '),
			status,
			error,
			actionRequired,
		]);
		colorRow(dataRow, MIGRATION_STATUS_ARGB[status]);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filename = `migration-export-${timestamp}.xlsx`;
	const filepath = path.join(process.cwd(), filename);
	await workbook.xlsx.writeFile(filepath);

	const counts = {
		created: rows.filter((r) => r.status === 'Created').length,
		failed: rows.filter((r) => r.status === 'Failed').length,
		skipped: rows.filter((r) => r.status === 'Skipped').length,
	};

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${rows.length} flag${rows.length === 1 ? '' : 's'} exported (${counts.created} created, ${counts.failed} failed, ${counts.skipped} skipped)`,
		),
	);
	console.log();
}

// ─── Evaluation Export ────────────────────────────────────────────────────────

const CLASSIFIED_ROW_ARGB: Record<RowColor, string> = {
	match: ARGB.matchGreen,
	notMigrated: ARGB.matchGreen,
	diff: ARGB.diffYellow,
	drift: ARGB.diffYellow,
	notInDD: ARGB.notInDDGray,
	notInProvider: ARGB.notInDDGray,
	error: ARGB.errorRed,
};

export async function exportEvaluationToXlsx(
	evalRows: EvaluationExportRow[],
	providerLabel: string,
	migratedAt: string,
	projectInfo?: { key: string; name: string },
): Promise<void> {
	const workbook = new ExcelJS.Workbook();
	const ws = workbook.addWorksheet('Evaluation Results');

	const headers = [
		'Flag Key',
		'Flag Name',
		'Team',
		'Test Case',
		`${providerLabel} Result`,
		'Datadog Result',
		'Match',
		'Migration Status',
		'DD Enabled',
		'Notes',
	];

	ws.columns = [
		{ width: 30 }, // Flag Key
		{ width: 30 }, // Flag Name
		{ width: 20 }, // Team
		{ width: 30 }, // Test Case
		{ width: 16 }, // Provider Result
		{ width: 16 }, // Datadog Result
		{ width: 10 }, // Match
		{ width: 18 }, // Migration Status
		{ width: 12 }, // DD Enabled
		{ width: 40 }, // Notes
	];

	const migratedDate = new Date(migratedAt).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
	const evalDate = new Date().toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});

	const projectClause = projectInfo
		? ` (project: ${projectInfo.name} / ${projectInfo.key})`
		: '';
	addSheetHeader(
		ws,
		headers.length,
		`Flag Evaluation Report — ${providerLabel} → Datadog`,
		`Evaluation run on ${evalDate} against migration from ${migratedDate}${projectClause}. Green rows indicate matching results between ${providerLabel} and Datadog. Yellow rows differ and may require investigation before removing the ${providerLabel} flag. Teams listed in the 'Team' column are responsible for verifying their flags and updating code to use the Datadog flag key.`,
	);
	addHeaderRow(ws, headers);

	const provider: 'launchdarkly' | 'eppo' =
		providerLabel.toLowerCase() === 'eppo' ? 'eppo' : 'launchdarkly';

	const sorted = [...evalRows].sort(
		(a, b) =>
			a.team.localeCompare(b.team) || a.flagName.localeCompare(b.flagName),
	);

	const classifications = sorted.map((r) =>
		classifyRow({
			flagKey: r.flagKey,
			inMigrationFile: r.inMigrationFile,
			ddStatus: r.ddStatus,
			providerStatus: r.providerStatus,
			providerError: r.error,
			match: r.match,
			ddMigrationMetadata: r.ddMigrationMetadata,
			provider,
		}),
	);

	for (let i = 0; i < sorted.length; i++) {
		const row = sorted[i];
		const classified = classifications[i];

		const match =
			classified.color === 'error'
				? 'Error'
				: row.ddStatus !== 'assigned'
					? '—'
					: row.match
						? 'Yes'
						: 'No';
		const ddEnabled =
			row.ddEnabled === null ? '—' : row.ddEnabled ? 'Yes' : 'No';
		const migStatus = row.inMigrationFile
			? row.migrationStatus.charAt(0).toUpperCase() +
				row.migrationStatus.slice(1)
			: '—';

		const dataRow = ws.addRow([
			row.flagKey,
			row.flagName,
			row.team,
			row.testCaseLabel,
			row.providerResult,
			row.ddResult,
			match,
			migStatus,
			ddEnabled,
			classified.notes,
		]);
		colorRow(dataRow, CLASSIFIED_ROW_ARGB[classified.color]);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const filename = `evaluation-export-${timestamp}.xlsx`;
	const filepath = path.join(process.cwd(), filename);
	await workbook.xlsx.writeFile(filepath);

	const matchCount = classifications.filter(
		(c) => c.color === 'match' || c.color === 'notMigrated',
	).length;
	const diffCount = classifications.filter(
		(c) => c.color === 'diff' || c.color === 'drift',
	).length;
	const errorCount = classifications.filter((c) => c.color === 'error').length;

	console.log();
	console.log(chalk.green('  Spreadsheet saved!'));
	console.log(`  ${chalk.cyan(filepath)}`);
	console.log(
		chalk.gray(
			`  ${sorted.length} evaluation(s) exported (${matchCount} match, ${diffCount} differ, ${errorCount} error)`,
		),
	);
	console.log();
}
