import type ExcelJS from 'exceljs';

// ─── Color Constants (ARGB, no #) ─────────────────────────────────────────────

export const ARGB = {
	headerBg: 'FFEFEFEF',
	created: 'FFD9EAD3',
	failed: 'FFFCE8E6',
	skipped: 'FFFFF2CC',
	matchGreen: 'FFD9EAD3',
	diffYellow: 'FFFFF2CC',
	errorRed: 'FFFCE8E6',
	notInDDGray: 'FFEFEFEF',
	white: 'FFFFFFFF',
} as const;

// ─── Style Helpers ────────────────────────────────────────────────────────────

export function fillSolid(argb: string): ExcelJS.Fill {
	return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function applyTitleStyle(cell: ExcelJS.Cell): void {
	cell.font = { bold: true, size: 14 };
	cell.alignment = { vertical: 'middle', wrapText: true };
	cell.fill = fillSolid(ARGB.white);
}

function applyInstructionStyle(cell: ExcelJS.Cell): void {
	cell.font = { italic: true, size: 10 };
	cell.alignment = { wrapText: true };
	cell.fill = fillSolid(ARGB.white);
}

function applyHeaderStyle(cell: ExcelJS.Cell): void {
	cell.font = { bold: true };
	cell.fill = fillSolid(ARGB.headerBg);
}

export function colorRow(row: ExcelJS.Row, argb: string): void {
	row.eachCell({ includeEmpty: true }, (cell) => {
		cell.fill = fillSolid(argb);
	});
}

// ─── Shared Sheet Setup ───────────────────────────────────────────────────────

export function addSheetHeader(
	ws: ExcelJS.Worksheet,
	numCols: number,
	title: string,
	instructions: string,
): void {
	// Row 1: title
	const titleRow = ws.addRow([title]);
	ws.mergeCells(1, 1, 1, numCols);
	applyTitleStyle(titleRow.getCell(1));
	titleRow.height = 28;

	// Row 2: instructions
	const instrRow = ws.addRow([instructions]);
	ws.mergeCells(2, 1, 2, numCols);
	applyInstructionStyle(instrRow.getCell(1));
	instrRow.height = 48;

	// Row 3: spacer
	ws.addRow([]);
}

export function addHeaderRow(ws: ExcelJS.Worksheet, headers: string[]): void {
	const headerRow = ws.addRow(headers);
	headerRow.eachCell((cell) => applyHeaderStyle(cell));
	headerRow.height = 18;
	ws.views = [{ state: 'frozen', ySplit: 4 }];
}
