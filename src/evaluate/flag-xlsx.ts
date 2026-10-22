import path from 'node:path';
import ExcelJS from 'exceljs';
import {
	ARGB,
	addSheetHeader,
	colorRow,
	fillSolid,
	safeCell,
} from '../helpers/xlsx-helpers.js';
import {
	type Assignment,
	type EvaluationOutcome,
	type FlagComparisonResult,
	type FlagEvaluationRecord,
	formatAssignmentValue,
} from './flag-comparison.js';

export type FlagEvaluationExportInfo = {
	sourceLabel: string;
	sourceFlagKey: string;
	sourceEnvironment: string;
	datadogEnvironment: string;
	ddEnv: string;
	bucketingMode: string;
	distributionChannel: string;
};

const OUTCOME_ARGB: Record<EvaluationOutcome, string> = {
	match: ARGB.matchGreen,
	'different-value': ARGB.errorRed,
	'only-source': ARGB.diffYellow,
	'only-datadog': ARGB.diffYellow,
};

// Mismatches first so the rows to investigate are at the top.
const OUTCOME_ORDER: Record<EvaluationOutcome, number> = {
	'different-value': 0,
	'only-source': 1,
	'only-datadog': 2,
	match: 3,
};

function outcomeLabel(outcome: EvaluationOutcome, sourceLabel: string): string {
	switch (outcome) {
		case 'match':
			return 'Match';
		case 'different-value':
			return 'Different value';
		case 'only-source':
			return `Only ${sourceLabel} assigned`;
		case 'only-datadog':
			return 'Only Datadog assigned';
	}
}

function assignmentCells(assignment: Assignment): Array<string | null> {
	if (!assignment.assigned) {
		return [
			null,
			assignment.detail
				? `(no assignment: ${assignment.detail})`
				: '(no assignment)',
			null,
		];
	}
	return [
		assignment.allocation,
		assignment.variant,
		formatAssignmentValue(assignment.value),
	];
}

export function flagEvaluationExportFilename(
	flagKey: string,
	now = new Date(),
): string {
	const timestamp = now.toISOString().replace(/[:.]/g, '-');
	const safeKey = flagKey.replace(/[^\w.-]/g, '_');
	return `flag-evaluation-${safeKey}-${timestamp}.xlsx`;
}

function addSummarySheet(
	workbook: ExcelJS.stream.xlsx.WorkbookWriter,
	result: FlagComparisonResult,
	info: FlagEvaluationExportInfo,
): void {
	const ws = workbook.addWorksheet('Summary');
	ws.columns = [{ width: 44 }, { width: 14 }, { width: 10 }];
	addSheetHeader(
		ws,
		3,
		`Flag Evaluation — ${info.sourceLabel} → Datadog`,
		`${result.subjects} random subjects were evaluated for ${result.flagKey} on both platforms. ` +
			'The Evaluations sheet has one row per subject and context: green rows match, ' +
			`red rows got different values, and yellow rows were assigned by only one platform.`,
	);

	const summaryRows: Array<[string, string | number]> = [
		['Datadog flag', result.flagKey],
		[`${info.sourceLabel} flag`, info.sourceFlagKey],
		[`${info.sourceLabel} environment`, info.sourceEnvironment],
		[
			'Datadog environment',
			`${info.datadogEnvironment} (DD_ENV ${info.ddEnv})`,
		],
		['Datadog bucketing', info.bucketingMode],
		['Datadog distribution channel', info.distributionChannel],
		['Evaluated at', new Date().toISOString()],
		['Subjects', result.subjects],
		['Contexts per subject', result.contexts],
		['Evaluations', result.evaluations],
		['Matches', result.matches],
		['Mismatches', result.mismatches.length],
	];
	for (const [label, value] of summaryRows) {
		const row = ws.addRow([safeCell(label), safeCell(value)]);
		row.getCell(1).font = { bold: true };
		row.commit();
	}

	for (const [title, distribution] of [
		[`${info.sourceLabel} assignments`, result.sourceDistribution],
		['Datadog assignments', result.datadogDistribution],
	] as const) {
		ws.addRow([]).commit();
		addTableHeader(ws, [
			`${title} (allocation → variant)`,
			'Evaluations',
			'Share',
		]);
		const entries = [...distribution.entries()].sort((a, b) => b[1] - a[1]);
		for (const [key, count] of entries) {
			const row = ws.addRow([
				safeCell(key),
				count,
				result.evaluations === 0 ? 0 : count / result.evaluations,
			]);
			row.getCell(3).numFmt = '0.0%';
			row.commit();
		}
	}
	ws.commit();
}

function addTableHeader(ws: ExcelJS.Worksheet, headers: string[]): void {
	const row = ws.addRow(headers);
	row.eachCell((cell) => {
		cell.font = { bold: true };
		cell.fill = fillSolid(ARGB.headerBg);
	});
	row.commit();
}

function addEvaluationsSheet(
	workbook: ExcelJS.stream.xlsx.WorkbookWriter,
	records: FlagEvaluationRecord[],
	info: FlagEvaluationExportInfo,
): void {
	// addSheetHeader writes the title, instructions, and a spacer row. The
	// streaming writer needs views up front, so freeze below the header here.
	const headerRowNumber = 4;
	const ws = workbook.addWorksheet('Evaluations', {
		views: [{ state: 'frozen', ySplit: headerRowNumber }],
	});
	const source = info.sourceLabel;
	const headers = [
		'Subject Key',
		'Context',
		'Attributes',
		`${source} Allocation`,
		`${source} Variant`,
		`${source} Value`,
		'Datadog Allocation',
		'Datadog Variant',
		'Datadog Value',
		'Result',
	];
	ws.columns = [
		{ width: 40 },
		{ width: 30 },
		{ width: 30 },
		{ width: 26 },
		{ width: 22 },
		{ width: 22 },
		{ width: 30 },
		{ width: 22 },
		{ width: 22 },
		{ width: 22 },
	];
	addSheetHeader(
		ws,
		headers.length,
		`Evaluations — ${source} → Datadog`,
		'Green rows match. Red rows got different values. Yellow rows were assigned by only one platform, ' +
			'which usually points at environment setup rather than bucketing. Use the filter on the Result column ' +
			'to show only mismatches.',
	);
	addTableHeader(ws, headers);
	ws.autoFilter = {
		from: { row: headerRowNumber, column: 1 },
		to: { row: headerRowNumber, column: headers.length },
	};

	const sorted = records
		.map((record, index) => ({ record, index }))
		.sort(
			(a, b) =>
				OUTCOME_ORDER[a.record.outcome] - OUTCOME_ORDER[b.record.outcome] ||
				a.index - b.index,
		);
	for (const { record } of sorted) {
		const row = ws.addRow(
			[
				record.subjectKey,
				record.context,
				JSON.stringify(record.attributes),
				...assignmentCells(record.source),
				...assignmentCells(record.datadog),
				outcomeLabel(record.outcome, source),
			].map(safeCell),
		);
		colorRow(row, OUTCOME_ARGB[record.outcome]);
		row.commit();
	}
	ws.commit();
}

/**
 * Write every evaluation to an .xlsx workbook. Uses the streaming writer so
 * tens of thousands of styled rows do not have to be held in memory.
 */
export async function exportFlagEvaluationToXlsx(
	result: FlagComparisonResult,
	info: FlagEvaluationExportInfo,
	filepath = path.join(
		process.cwd(),
		flagEvaluationExportFilename(result.flagKey),
	),
): Promise<string> {
	const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
		filename: filepath,
		useStyles: true,
	});
	addSummarySheet(workbook, result, info);
	addEvaluationsSheet(workbook, result.records, info);
	await workbook.commit();
	return filepath;
}
