import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addHeaderRow,
	addSheetHeader,
	colorRow,
	fillSolid,
	safeCell,
	uniqueWorksheetName,
} from '../helpers/xlsx-helpers.js';
import type {
	OrgDiffEnvironmentPair,
	OrgDiffEnvironmentResult,
	OrgDiffEnvironmentStatus,
	OrgDiffFlagResult,
	OrgDiffFlagStatus,
	OrgDiffResult,
} from './types.js';

const FLAG_STATUS_LABELS: Record<OrgDiffFlagStatus, string> = {
	'only-in-source': 'Only in source org',
	'only-in-target': 'Only in target org',
	differs: 'Differs',
	'in-sync': 'In sync',
	'needs-review': 'Needs review',
};

const FLAG_STATUS_ORDER: OrgDiffFlagStatus[] = [
	'only-in-source',
	'only-in-target',
	'differs',
	'needs-review',
	'in-sync',
];

type RowStatus = OrgDiffFlagStatus;

const ROW_PRIORITY: Record<RowStatus, number> = {
	'only-in-source': 0,
	'only-in-target': 0,
	differs: 1,
	'needs-review': 2,
	'in-sync': 3,
};

export function orgDiffStatusLabel(status: OrgDiffFlagStatus): string {
	return FLAG_STATUS_LABELS[status];
}

export function orgDiffStatusOrder(): readonly OrgDiffFlagStatus[] {
	return FLAG_STATUS_ORDER;
}

export function orgDiffCounts(
	result: OrgDiffResult,
): Record<OrgDiffFlagStatus, number> {
	const counts: Record<OrgDiffFlagStatus, number> = {
		'only-in-source': 0,
		'only-in-target': 0,
		differs: 0,
		'in-sync': 0,
		'needs-review': 0,
	};
	for (const flag of result.flags) counts[flag.status]++;
	return counts;
}

function nextStep(status: RowStatus): string {
	switch (status) {
		case 'only-in-source':
			return 'Migrate the flag to the target org if both orgs should have it.';
		case 'only-in-target':
			return 'Migrate the flag to the source org if both orgs should have it.';
		case 'differs':
			return 'Decide which org is correct, then run migrate with Datadog → Datadog to copy it to the other org.';
		case 'needs-review':
			return 'Review manually in both orgs.';
		case 'in-sync':
			return 'No action needed.';
	}
}

function environmentRowStatus(
	flag: OrgDiffFlagResult,
	environment: OrgDiffEnvironmentResult | undefined,
): RowStatus {
	if (
		flag.status === 'only-in-source' ||
		flag.status === 'only-in-target' ||
		!environment
	) {
		return flag.status;
	}
	if (flag.flagWideChanges.length > 0 || environment.status === 'differs') {
		return 'differs';
	}
	const statusByEnvironment: Record<OrgDiffEnvironmentStatus, RowStatus> = {
		differs: 'differs',
		'in-sync': 'in-sync',
		'could-not-verify': 'needs-review',
	};
	return statusByEnvironment[environment.status];
}

export interface OrgDiffSheetRow {
	status: RowStatus;
	flagName: string;
	flagKey: string;
	details: string;
}

export function orgDiffEnvironmentRows(
	result: OrgDiffResult,
	pair: OrgDiffEnvironmentPair,
): OrgDiffSheetRow[] {
	return result.flags
		.map((flag) => {
			const environment = flag.environments.find(
				(candidate) =>
					candidate.sourceEnvironmentId === pair.sourceEnvironmentId &&
					candidate.targetEnvironmentId === pair.targetEnvironmentId,
			);
			const status = environmentRowStatus(flag, environment);
			const details = [...flag.flagWideDetails];
			if (environment && (details.length === 0 || status !== 'in-sync')) {
				details.push(environment.details);
			} else if (!environment && flag.details) {
				details.push(flag.details);
			}
			return {
				status,
				flagName: flag.flagName,
				flagKey: flag.flagKey,
				details: [...new Set(details.filter(Boolean))].join(' '),
			};
		})
		.sort(
			(a, b) =>
				ROW_PRIORITY[a.status] - ROW_PRIORITY[b.status] ||
				a.flagName.localeCompare(b.flagName),
		);
}

function colorStatusRow(row: ExcelJS.Row, status: RowStatus): void {
	if (status === 'in-sync') colorRow(row, ARGB.matchGreen);
	else if (status === 'only-in-source' || status === 'only-in-target')
		colorRow(row, ARGB.notInDDGray);
	else if (status === 'needs-review') colorRow(row, ARGB.skipped);
	else colorRow(row, ARGB.diffYellow);
}

/** Write a workbook with a summary and one tab per compared environment pair. */
export async function writeOrgDiffWorkbook(
	result: OrgDiffResult,
	output: string,
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Datadog Feature Flag Migration';
	workbook.created = result.generatedAt;

	const summary = workbook.addWorksheet('Summary');
	addSheetHeader(
		summary,
		2,
		'Datadog Org Configuration Diff',
		'Compares flag configuration between two Datadog orgs for the selected environment pairs. Neither org is treated as the source of truth.',
	);
	const pairsLabel = summary.addRow(['Environment pairs']);
	summary.mergeCells(pairsLabel.number, 1, pairsLabel.number, 2);
	pairsLabel.getCell(1).font = { bold: true, size: 11 };
	pairsLabel.getCell(1).fill = fillSolid(ARGB.white);
	for (const pair of result.environmentPairs) {
		summary.addRow([
			safeCell(
				`${pair.sourceEnvironmentName} (source org) ↔ ${pair.targetEnvironmentName} (target org)`,
			),
		]);
	}
	summary.addRow([]);
	addHeaderRow(summary, ['Metric', 'Value']);
	const counts = orgDiffCounts(result);
	const rows: Array<[string, string | number]> = [
		['Source org', result.sourceSite],
		['Target org', result.targetSite],
		['Generated at', result.generatedAt.toISOString()],
		['Flags compared', result.flags.length],
		...FLAG_STATUS_ORDER.map(
			(status) =>
				[FLAG_STATUS_LABELS[status], counts[status]] as [string, number],
		),
	];
	for (const row of rows) summary.addRow(row.map(safeCell));
	summary.addRow([]);
	summary.addRow(['Limitations', '']);
	for (const limitation of result.limitations) {
		summary.addRow(['', safeCell(limitation)]);
	}
	summary.getColumn(1).width = 30;
	summary.getColumn(2).width = 90;

	const usedNames = new Set(['summary']);
	for (const pair of result.environmentPairs) {
		const sheet = workbook.addWorksheet(
			uniqueWorksheetName(
				`${pair.sourceEnvironmentName} ↔ ${pair.targetEnvironmentName}`,
				usedNames,
			),
		);
		addSheetHeader(
			sheet,
			7,
			`Org Diff — ${pair.sourceEnvironmentName} ↔ ${pair.targetEnvironmentName}`,
			'One row per flag in either org. Flag-wide differences are repeated on every environment tab.',
		);
		const tableHeaderRow = sheet.rowCount + 1;
		addHeaderRow(sheet, [
			'Status',
			'Flag name',
			'Flag key',
			'Source environment',
			'Target environment',
			'What differs',
			'Suggested next step',
		]);
		for (const row of orgDiffEnvironmentRows(result, pair)) {
			const added = sheet.addRow(
				[
					FLAG_STATUS_LABELS[row.status],
					row.flagName,
					row.flagKey,
					pair.sourceEnvironmentName,
					pair.targetEnvironmentName,
					row.details,
					nextStep(row.status),
				].map(safeCell),
			);
			colorStatusRow(added, row.status);
		}
		sheet.autoFilter = {
			from: { row: tableHeaderRow, column: 1 },
			to: { row: tableHeaderRow, column: 7 },
		};
		sheet.columns.forEach((column, index) => {
			column.width = index >= 5 ? 56 : index === 0 ? 20 : 30;
		});
	}

	const path = resolve(output);
	await mkdir(dirname(path), { recursive: true });
	await workbook.xlsx.writeFile(path);
	return path;
}
