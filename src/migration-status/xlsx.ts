import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addEnvironmentMappingSection,
	addHeaderRow,
	addSheetHeader,
	colorRow,
	safeCell,
} from '../helpers/xlsx-helpers.js';
import type {
	EnvironmentMigrationStatus,
	FlagMigrationStatus,
	MigrationStatusResult,
} from './types.js';

const FLAG_STATUS_LABELS: Record<FlagMigrationStatus, string> = {
	'not-yet-migrated': 'Not yet migrated',
	'partially-migrated': 'Partially migrated',
	'out-of-sync': 'Out of sync',
	'in-sync': 'In sync',
	'needs-review': 'Needs review',
};

const ENVIRONMENT_STATUS_LABELS: Record<EnvironmentMigrationStatus, string> = {
	'not-migrated': 'Not migrated',
	'out-of-sync': 'Out of sync',
	'in-sync': 'In sync',
	'could-not-verify': 'Could not verify',
};

export function flagStatusLabel(status: FlagMigrationStatus): string {
	return FLAG_STATUS_LABELS[status];
}

export function environmentStatusLabel(
	status: EnvironmentMigrationStatus,
): string {
	return ENVIRONMENT_STATUS_LABELS[status];
}

export function migrationStatusCounts(
	result: MigrationStatusResult,
): Record<FlagMigrationStatus, number> {
	return result.flags.reduce<Record<FlagMigrationStatus, number>>(
		(counts, flag) => {
			counts[flag.status]++;
			return counts;
		},
		{
			'not-yet-migrated': 0,
			'partially-migrated': 0,
			'out-of-sync': 0,
			'in-sync': 0,
			'needs-review': 0,
		},
	);
}

function nextAction(status: FlagMigrationStatus): string {
	switch (status) {
		case 'not-yet-migrated':
			return 'Migrate this flag.';
		case 'partially-migrated':
			return 'Re-run migration for the missing selected environments.';
		case 'out-of-sync':
			return 'Review the differences, then re-run migration.';
		case 'needs-review':
			return 'Review manually before migrating.';
		case 'in-sync':
			return 'No action needed.';
	}
}

/** Write a compact, customer-facing workbook with summary and scoped status. */
export async function writeMigrationStatusWorkbook(
	result: MigrationStatusResult,
	output: string,
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Datadog Feature Flag Migration';
	workbook.created = result.generatedAt;

	const summary = workbook.addWorksheet('Summary');
	addSheetHeader(
		summary,
		2,
		'Feature Flag Migration Status',
		'Status is calculated only for the selected LaunchDarkly-to-Datadog environment mappings. Unselected environments do not affect the results.',
	);
	addEnvironmentMappingSection(
		summary,
		2,
		'LaunchDarkly',
		result.mappings.map((mapping) => ({
			sourceLabel: mapping.sourceEnvironmentName,
			datadogLabel: mapping.datadogEnvironmentName,
		})),
	);
	addHeaderRow(summary, ['Metric', 'Value']);
	const counts = migrationStatusCounts(result);
	const summaryRows: Array<[string, string | number]> = [
		['LaunchDarkly project', `${result.projectName} (${result.projectKey})`],
		['Generated at', result.generatedAt.toISOString()],
		['LaunchDarkly flags', result.flags.length],
		['Not yet migrated', counts['not-yet-migrated']],
		['Partially migrated', counts['partially-migrated']],
		['Out of sync', counts['out-of-sync']],
		['In sync', counts['in-sync']],
		['Need review', counts['needs-review']],
	];
	for (const row of summaryRows) summary.addRow(row.map(safeCell));
	summary.addRow([]);
	summary.addRow(['Limitations', '']);
	for (const limitation of result.limitations) {
		summary.addRow(['', safeCell(limitation)]);
	}
	summary.getColumn(1).width = 30;
	summary.getColumn(2).width = 90;

	const status = workbook.addWorksheet('Flag Status');
	addSheetHeader(
		status,
		9,
		'Migration Status by Selected Environment',
		'One row is shown for each selected environment mapping of a migrated flag. Flags that are not yet migrated are shown once.',
	);
	addHeaderRow(status, [
		'Overall status',
		'Flag name',
		'LaunchDarkly key',
		'Datadog key',
		'LaunchDarkly environment',
		'Datadog environment',
		'Scope status',
		'What changed',
		'Recommended action',
	]);

	const priority: Record<FlagMigrationStatus, number> = {
		'partially-migrated': 0,
		'out-of-sync': 1,
		'not-yet-migrated': 2,
		'needs-review': 3,
		'in-sync': 4,
	};
	const flags = [...result.flags].sort(
		(a, b) =>
			priority[a.status] - priority[b.status] ||
			a.flagName.localeCompare(b.flagName),
	);
	for (const flag of flags) {
		const overall = flagStatusLabel(flag.status);
		if (!flag.datadogFlagKey) {
			const row = status.addRow(
				[
					overall,
					flag.flagName,
					flag.flagKey,
					'',
					'',
					'',
					overall,
					flag.details ?? flag.flagWideDetails.join(' '),
					nextAction(flag.status),
				].map(safeCell),
			);
			colorStatusRow(row, flag.status);
			continue;
		}
		if (flag.flagWideChanges.length > 0) {
			const row = status.addRow(
				[
					overall,
					flag.flagName,
					flag.flagKey,
					flag.datadogFlagKey,
					'Flag-wide',
					'Flag-wide',
					flag.flagWideChanges.includes('collection')
						? 'Could not verify'
						: 'Out of sync',
					flag.flagWideDetails.join(' '),
					nextAction(flag.status),
				].map(safeCell),
			);
			colorStatusRow(row, flag.status);
		}
		for (const environment of flag.environments) {
			const row = status.addRow(
				[
					overall,
					flag.flagName,
					flag.flagKey,
					flag.datadogFlagKey,
					environment.sourceEnvironmentName,
					environment.datadogEnvironmentName,
					environmentStatusLabel(environment.status),
					environment.details,
					nextAction(flag.status),
				].map(safeCell),
			);
			colorEnvironmentRow(row, environment.status);
		}
	}

	status.autoFilter = {
		from: { row: 4, column: 1 },
		to: { row: 4, column: 9 },
	};
	status.columns.forEach((column, index) => {
		column.width = index === 7 || index === 8 ? 52 : 24;
	});
	status.getColumn(2).width = 34;
	status.getColumn(3).width = 34;
	status.getColumn(4).width = 34;

	const path = resolve(output);
	await mkdir(dirname(path), { recursive: true });
	await workbook.xlsx.writeFile(path);
	return path;
}

function colorStatusRow(row: ExcelJS.Row, status: FlagMigrationStatus): void {
	if (status === 'in-sync') colorRow(row, ARGB.matchGreen);
	else if (status === 'not-yet-migrated') colorRow(row, ARGB.notInDDGray);
	else if (status === 'needs-review') colorRow(row, ARGB.skipped);
	else colorRow(row, ARGB.diffYellow);
}

function colorEnvironmentRow(
	row: ExcelJS.Row,
	status: EnvironmentMigrationStatus,
): void {
	if (status === 'in-sync') colorRow(row, ARGB.matchGreen);
	else if (status === 'not-migrated') colorRow(row, ARGB.notInDDGray);
	else colorRow(row, ARGB.diffYellow);
}
