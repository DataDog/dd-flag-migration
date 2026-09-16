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
	EnvironmentStatusResult,
	FlagMigrationStatus,
	FlagStatusResult,
	MigrationStatusMapping,
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

type EnvironmentSheetStatus =
	| EnvironmentMigrationStatus
	| 'not-yet-migrated'
	| 'needs-review';

const ENVIRONMENT_SHEET_STATUS_LABELS: Record<EnvironmentSheetStatus, string> =
	{
		...ENVIRONMENT_STATUS_LABELS,
		'not-yet-migrated': 'Not yet migrated',
		'needs-review': 'Needs review',
	};

const ENVIRONMENT_SHEET_STATUS_PRIORITY: Record<
	EnvironmentSheetStatus,
	number
> = {
	'not-yet-migrated': 0,
	'not-migrated': 0,
	'out-of-sync': 1,
	'needs-review': 2,
	'could-not-verify': 2,
	'in-sync': 3,
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

interface EnvironmentSheetDefinition {
	id: string;
	name: string;
	sourceEnvironmentNames: string[];
	worksheetName: string;
}

interface EnvironmentSheetRow {
	flagKey: string;
	status: EnvironmentSheetStatus;
	flagName: string;
	datadogFlagKey: string;
	sourceEnvironmentName: string;
	datadogEnvironmentName: string;
	details: string;
}

function environmentNextAction(status: EnvironmentSheetStatus): string {
	switch (status) {
		case 'not-yet-migrated':
			return 'Migrate this flag.';
		case 'not-migrated':
			return 'Re-run migration for this environment.';
		case 'out-of-sync':
			return 'Review the differences, then re-run migration.';
		case 'needs-review':
		case 'could-not-verify':
			return 'Review manually before migrating.';
		case 'in-sync':
			return 'No action needed.';
	}
}

function selectedDatadogEnvironments(
	mappings: MigrationStatusMapping[],
): EnvironmentSheetDefinition[] {
	const environments = new Map<
		string,
		Omit<EnvironmentSheetDefinition, 'worksheetName'>
	>();
	for (const mapping of mappings) {
		const existing = environments.get(mapping.datadogEnvironmentId);
		if (existing) {
			if (
				!existing.sourceEnvironmentNames.includes(mapping.sourceEnvironmentName)
			) {
				existing.sourceEnvironmentNames.push(mapping.sourceEnvironmentName);
			}
			continue;
		}
		environments.set(mapping.datadogEnvironmentId, {
			id: mapping.datadogEnvironmentId,
			name: mapping.datadogEnvironmentName,
			sourceEnvironmentNames: [mapping.sourceEnvironmentName],
		});
	}

	const usedNames = new Set(['summary']);
	return [...environments.values()].map((environment) => ({
		...environment,
		worksheetName: uniqueWorksheetName(environment.name, usedNames),
	}));
}

function uniqueWorksheetName(name: string, usedNames: Set<string>): string {
	const sanitized =
		name
			.replace(/[\\/?*[\]:]/g, ' ')
			.replace(/\s+/g, ' ')
			.replace(/^'+|'+$/g, '')
			.trim() || 'Environment';
	let worksheetName = sanitized.slice(0, 31);
	let suffixNumber = 2;
	while (usedNames.has(worksheetName.toLowerCase())) {
		const suffix = ` (${suffixNumber})`;
		worksheetName = `${sanitized.slice(0, 31 - suffix.length)}${suffix}`;
		suffixNumber++;
	}
	usedNames.add(worksheetName.toLowerCase());
	return worksheetName;
}

function mostImportantStatus(
	statuses: EnvironmentSheetStatus[],
): EnvironmentSheetStatus {
	return statuses.reduce((current, status) =>
		ENVIRONMENT_SHEET_STATUS_PRIORITY[status] <
		ENVIRONMENT_SHEET_STATUS_PRIORITY[current]
			? status
			: current,
	);
}

function environmentSheetStatus(
	flag: FlagStatusResult,
	environment?: EnvironmentStatusResult,
): EnvironmentSheetStatus {
	if (!flag.datadogFlagKey) {
		return flag.status === 'needs-review' ? 'needs-review' : 'not-yet-migrated';
	}
	const statuses: EnvironmentSheetStatus[] = [];
	if (flag.flagWideChanges.length > 0) {
		statuses.push(
			flag.status === 'needs-review' ? 'needs-review' : 'out-of-sync',
		);
	}
	if (environment) statuses.push(environment.status);
	if (statuses.length > 0) return mostImportantStatus(statuses);
	return flag.status === 'in-sync' ? 'in-sync' : 'could-not-verify';
}

function environmentSheetDetails(
	flag: FlagStatusResult,
	environment?: EnvironmentStatusResult,
): string {
	const details = [...flag.flagWideDetails];
	if (environment) {
		if (details.length === 0 || environment.status !== 'in-sync') {
			details.push(environment.details);
		}
	} else if (flag.details) {
		details.push(flag.details);
	}
	return [...new Set(details.filter(Boolean))].join(' ');
}

function environmentSheetRows(
	result: MigrationStatusResult,
	environment: EnvironmentSheetDefinition,
): EnvironmentSheetRow[] {
	const rows: EnvironmentSheetRow[] = [];
	for (const flag of result.flags) {
		const environmentResults = flag.environments.filter(
			(candidate) => candidate.datadogEnvironmentId === environment.id,
		);
		if (environmentResults.length === 0) {
			rows.push({
				flagKey: flag.flagKey,
				status: environmentSheetStatus(flag),
				flagName: flag.flagName,
				datadogFlagKey: flag.datadogFlagKey ?? '',
				sourceEnvironmentName: environment.sourceEnvironmentNames.join(', '),
				datadogEnvironmentName: environment.name,
				details: environmentSheetDetails(flag),
			});
			continue;
		}
		for (const environmentResult of environmentResults) {
			rows.push({
				flagKey: flag.flagKey,
				status: environmentSheetStatus(flag, environmentResult),
				flagName: flag.flagName,
				datadogFlagKey: flag.datadogFlagKey ?? '',
				sourceEnvironmentName: environmentResult.sourceEnvironmentName,
				datadogEnvironmentName: environmentResult.datadogEnvironmentName,
				details: environmentSheetDetails(flag, environmentResult),
			});
		}
	}
	return rows.sort(
		(a, b) =>
			ENVIRONMENT_SHEET_STATUS_PRIORITY[a.status] -
				ENVIRONMENT_SHEET_STATUS_PRIORITY[b.status] ||
			a.flagName.localeCompare(b.flagName) ||
			a.sourceEnvironmentName.localeCompare(b.sourceEnvironmentName),
	);
}

function environmentStatusCounts(
	rows: EnvironmentSheetRow[],
): Record<EnvironmentSheetStatus, number> {
	const statusByFlag = new Map<string, EnvironmentSheetStatus>();
	for (const row of rows) {
		const current = statusByFlag.get(row.flagKey);
		statusByFlag.set(
			row.flagKey,
			current ? mostImportantStatus([current, row.status]) : row.status,
		);
	}
	const counts: Record<EnvironmentSheetStatus, number> = {
		'not-yet-migrated': 0,
		'not-migrated': 0,
		'out-of-sync': 0,
		'needs-review': 0,
		'could-not-verify': 0,
		'in-sync': 0,
	};
	for (const status of statusByFlag.values()) counts[status]++;
	return counts;
}

/** Write a customer-facing workbook with summary and per-environment status. */
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

	for (const environment of selectedDatadogEnvironments(result.mappings)) {
		const rows = environmentSheetRows(result, environment);
		const counts = environmentStatusCounts(rows);
		const status = workbook.addWorksheet(environment.worksheetName);
		addSheetHeader(
			status,
			8,
			`Migration Status — ${environment.name}`,
			'One row is shown for each selected LaunchDarkly mapping into this Datadog environment. Flag-wide differences are included in every affected environment tab.',
		);
		const statusSummary = status.addRow(
			[
				`Flags: ${result.flags.length}`,
				`In sync: ${counts['in-sync']}`,
				`Out of sync: ${counts['out-of-sync']}`,
				`Not yet migrated: ${counts['not-yet-migrated']}`,
				`Not migrated: ${counts['not-migrated']}`,
				`Needs review: ${counts['needs-review']}`,
				`Could not verify: ${counts['could-not-verify']}`,
				`Mappings: ${environment.sourceEnvironmentNames.length}`,
			].map(safeCell),
		);
		colorRow(statusSummary, ARGB.headerBg);
		statusSummary.eachCell((cell) => {
			cell.font = { bold: true };
		});
		const tableHeaderRow = status.rowCount + 1;
		addHeaderRow(status, [
			'Status',
			'Flag name',
			'LaunchDarkly key',
			'Datadog key',
			'LaunchDarkly environment',
			'Datadog environment',
			'What changed',
			'Recommended action',
		]);

		for (const statusRow of rows) {
			const row = status.addRow(
				[
					ENVIRONMENT_SHEET_STATUS_LABELS[statusRow.status],
					statusRow.flagName,
					statusRow.flagKey,
					statusRow.datadogFlagKey,
					statusRow.sourceEnvironmentName,
					statusRow.datadogEnvironmentName,
					statusRow.details,
					environmentNextAction(statusRow.status),
				].map(safeCell),
			);
			colorEnvironmentSheetRow(row, statusRow.status);
		}

		status.autoFilter = {
			from: { row: tableHeaderRow, column: 1 },
			to: { row: tableHeaderRow, column: 8 },
		};
		status.columns.forEach((column, index) => {
			column.width = index === 6 || index === 7 ? 52 : 24;
		});
		status.getColumn(2).width = 34;
		status.getColumn(3).width = 34;
		status.getColumn(4).width = 34;
	}

	const path = resolve(output);
	await mkdir(dirname(path), { recursive: true });
	await workbook.xlsx.writeFile(path);
	return path;
}

function colorEnvironmentSheetRow(
	row: ExcelJS.Row,
	status: EnvironmentSheetStatus,
): void {
	if (status === 'in-sync') colorRow(row, ARGB.matchGreen);
	else if (status === 'not-yet-migrated' || status === 'not-migrated') {
		colorRow(row, ARGB.notInDDGray);
	} else if (status === 'needs-review') colorRow(row, ARGB.skipped);
	else colorRow(row, ARGB.diffYellow);
}
