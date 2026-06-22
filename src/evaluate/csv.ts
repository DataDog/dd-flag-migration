import type { SubjectAttributes, TestCase } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlagTestCaseEntry {
	flagKey: string;
	flagName: string;
	team: string;
	testCases: TestCase[];
}

// ─── parseCsv ────────────────────────────────────────────────────────────────

/**
 * RFC 4180-compliant CSV parser.
 * Handles: quoted fields, embedded commas, embedded newlines, escaped double
 * quotes (`` "" ``→`"`), CRLF and LF line endings, trailing blank line, and
 * leading UTF-8 BOM.
 */
export function parseCsv(content: string): {
	header: string[];
	rows: string[][];
} {
	// Strip leading UTF-8 BOM (U+FEFF)
	const cleaned = content.startsWith('﻿') ? content.slice(1) : content;

	// Empty input → empty header + empty rows so validateHeader can report "CSV is empty"
	if (cleaned.length === 0) {
		return { header: [], rows: [] };
	}

	const allRows = parseRfc4180(cleaned);

	// Only trim when the trailing blank row was produced by a trailing newline
	const endsWithNewline =
		cleaned.length > 0 &&
		(cleaned[cleaned.length - 1] === '\n' ||
			cleaned[cleaned.length - 1] === '\r');
	if (endsWithNewline && allRows.length > 0) {
		const last = allRows[allRows.length - 1];
		if (last.every((cell) => cell === '')) {
			allRows.pop();
		}
	}

	if (allRows.length === 0) {
		return { header: [], rows: [] };
	}

	const [header, ...rows] = allRows;
	return { header, rows };
}

/**
 * Core RFC 4180 parser — returns an array of rows, each row an array of fields.
 */
function parseRfc4180(text: string): string[][] {
	const rows: string[][] = [];
	let pos = 0;
	const len = text.length;

	while (pos <= len) {
		// Parse one row
		const row: string[] = [];

		// Empty string at end of input → one empty row (will be trimmed by caller)
		if (pos === len) {
			rows.push(['']);
			break;
		}

		while (true) {
			if (pos < len && text[pos] === '"') {
				// Quoted field
				pos++; // skip opening quote
				let field = '';
				while (pos < len) {
					if (text[pos] === '"') {
						if (pos + 1 < len && text[pos + 1] === '"') {
							// Escaped double quote
							field += '"';
							pos += 2;
						} else {
							// End of quoted field
							pos++;
							break;
						}
					} else {
						field += text[pos];
						pos++;
					}
				}
				row.push(field);
			} else {
				// Unquoted field — read until comma or line ending
				let field = '';
				while (
					pos < len &&
					text[pos] !== ',' &&
					text[pos] !== '\n' &&
					text[pos] !== '\r'
				) {
					field += text[pos];
					pos++;
				}
				row.push(field);
			}

			// After field: comma → next field; line ending or end of input → end row
			if (pos < len && text[pos] === ',') {
				pos++; // skip comma, continue row
			} else {
				break;
			}
		}

		rows.push(row);

		// Advance past line ending
		if (pos < len) {
			if (text[pos] === '\r' && pos + 1 < len && text[pos + 1] === '\n') {
				pos += 2; // CRLF
			} else if (text[pos] === '\r' || text[pos] === '\n') {
				pos += 1; // CR or LF
			} else {
				break; // Unexpected character after field end — stop
			}
		} else {
			break; // End of input
		}
	}

	return rows;
}

// ─── validateHeader ───────────────────────────────────────────────────────────

const LD_RESERVED_ATTRS = new Set(['key', 'kind']);

/**
 * Validates the CSV header row.
 * Throws a descriptive Error on any violation.
 */
export function validateHeader(
	header: string[],
	rows: string[][],
	provider?: 'launchdarkly' | 'eppo',
): void {
	if (header.length === 0) {
		throw new Error('Header validation failed: CSV is empty');
	}

	if (rows.length === 0) {
		throw new Error('Header validation failed: no data rows found');
	}

	if (header[0] !== 'flagKey') {
		throw new Error(
			`Header validation failed: column 1 must be "flagKey", got "${header[0]}" at line 1`,
		);
	}

	if (header[1] !== 'subjectKey') {
		throw new Error(
			`Header validation failed: column 2 must be "subjectKey", got "${header[1] ?? ''}" at line 1`,
		);
	}

	// Check attributes (positions 2+) for duplicates and reserved names
	const seen = new Set<string>();
	for (const name of header.slice(2)) {
		if (seen.has(name)) {
			throw new Error(
				`Header validation failed: duplicate attribute name "${name}" at line 1`,
			);
		}
		seen.add(name);

		const dotIdx = name.indexOf('.');
		if (provider === 'launchdarkly' && dotIdx !== -1) {
			const contextKind = name.slice(0, dotIdx);
			const attrName = name.slice(dotIdx + 1);
			if (contextKind === '') {
				throw new Error(
					`Header validation failed: empty context kind in column "${name}" at line 1`,
				);
			}
			if (attrName === '') {
				throw new Error(
					`Header validation failed: empty attribute name in column "${name}" at line 1`,
				);
			}
			if (contextKind === 'user') {
				throw new Error(
					`Header validation failed: context kind "user" is reserved — use a plain column name for user-context attributes (column "${name}") at line 1`,
				);
			}
			if (contextKind === 'kind') {
				throw new Error(
					`Header validation failed: context kind "kind" is reserved for LaunchDarkly (column "${name}") at line 1`,
				);
			}
		} else if (provider === 'launchdarkly' && LD_RESERVED_ATTRS.has(name)) {
			throw new Error(
				`Header validation failed: attribute name "${name}" is reserved for LaunchDarkly at line 1`,
			);
		}
	}
}

// ─── coerceCell ──────────────────────────────────────────────────────────────

const STRICT_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Coerces a raw CSV cell string to a typed value.
 *
 * Rules (applied in order):
 *  1. Empty string → undefined
 *  2. Starts with `'` → strip quote, return rest as string
 *  3. Case-insensitive 'true'/'false' (no surrounding whitespace) → boolean
 *  4. Strict decimal regex → number
 *  5. Anything else → raw string
 */
export function coerceCell(raw: string): string | number | boolean | undefined {
	// Rule 1: empty → undefined
	if (raw === '') {
		return undefined;
	}

	// Rule 2: leading single-quote escape
	if (raw.startsWith("'")) {
		return raw.slice(1);
	}

	// Rule 3: boolean (strict — no whitespace)
	const lower = raw.toLowerCase();
	if (lower === 'true') return true;
	if (lower === 'false') return false;

	// Rule 4: strict decimal number
	if (STRICT_DECIMAL_RE.test(raw)) {
		return Number(raw);
	}

	// Rule 5: string as-is
	return raw;
}

// ─── csvRowsToFlagTestCases ───────────────────────────────────────────────────

/**
 * Converts parsed CSV rows into grouped flag test case entries.
 * Groups rows by flagKey; each row becomes a TestCase.
 */
export function csvRowsToFlagTestCases(
	header: string[],
	rows: string[][],
	provider?: 'launchdarkly' | 'eppo',
): FlagTestCaseEntry[] {
	type ColInfo =
		| { kind: 'user'; name: string }
		| {
				kind: 'context';
				contextKind: string;
				attr: string;
				fullName: string;
		  };

	const parseContextColumns = provider === 'launchdarkly';
	const colInfos: ColInfo[] = header.slice(2).map((name) => {
		const dotIdx = name.indexOf('.');
		if (!parseContextColumns || dotIdx === -1) return { kind: 'user', name };
		return {
			kind: 'context',
			contextKind: name.slice(0, dotIdx),
			attr: name.slice(dotIdx + 1),
			fullName: name,
		};
	});

	const map = new Map<string, FlagTestCaseEntry>();
	const warnings: string[] = [];

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const rowNum = i + 2; // 1-based, row 1 is header

		// Validate column count
		if (row.length !== header.length) {
			warnings.push(
				`Row ${rowNum}: wrong column count (expected ${header.length}, got ${row.length}) — skipping`,
			);
			continue;
		}

		const flagKey = row[0];
		const subjectKey = row[1];

		if (!flagKey) {
			warnings.push(`Row ${rowNum}: flagKey is empty — skipping`);
			continue;
		}

		if (!subjectKey) {
			warnings.push(`Row ${rowNum}: subjectKey is empty — skipping`);
			continue;
		}

		const attributes: SubjectAttributes = {};
		const labelParts: string[] = [`subjectKey=${subjectKey}`];
		let contextAttributes: Record<string, SubjectAttributes> | undefined;

		for (let col = 2; col < header.length; col++) {
			const colInfo = colInfos[col - 2];
			const coerced = coerceCell(row[col]);
			if (coerced === undefined) continue;

			if (colInfo.kind === 'user') {
				attributes[colInfo.name] = coerced;
				labelParts.push(`${colInfo.name}=${String(coerced)}`);
			} else {
				// Context keys are always strings in LD; stringify to keep LD/DD in sync.
				const stored = colInfo.attr === 'key' ? String(coerced) : coerced;
				attributes[colInfo.fullName] = stored;
				contextAttributes ??= {};
				contextAttributes[colInfo.contextKind] ??= {};
				contextAttributes[colInfo.contextKind][colInfo.attr] = stored;
				labelParts.push(`${colInfo.fullName}=${String(stored)}`);
			}
		}

		const testCase: TestCase = {
			label: labelParts.join(', '),
			attributes,
			subjectIdOverride: subjectKey,
			...(contextAttributes !== undefined && { contextAttributes }),
		};

		const existing = map.get(flagKey);
		if (existing) {
			existing.testCases.push(testCase);
		} else {
			map.set(flagKey, {
				flagKey,
				flagName: flagKey, // caller enriches later
				team: '',
				testCases: [testCase],
			});
		}
	}

	if (warnings.length > 0) {
		const shown = warnings.slice(0, 5);
		for (const w of shown) console.warn(w);
		if (warnings.length > 5) {
			console.warn(`  …and ${warnings.length - 5} more row(s) skipped`);
		}
	}

	return Array.from(map.values());
}

// ─── formatExampleTable ───────────────────────────────────────────────────────

/**
 * Returns a multi-line string showing the example CSV layout.
 */
export function formatExampleTable(provider: 'launchdarkly' | 'eppo'): string {
	const attrNote =
		provider === 'launchdarkly'
			? '  - Attribute names "key" and "kind" are reserved and cannot be used as plain column names.\n' +
				'  - To supply non-user context attributes (device, org, app), use dotted column names: e.g. "ld_application.versionName".\n' +
				'  - Use "contextKind.key" to set the identity key for that context (e.g. "org.key").\n' +
				'  - The context kinds "user" and "kind" are reserved; use a plain column name for user-context attributes.'
			: '  - Any attribute names are allowed.';

	const exampleRows =
		provider === 'launchdarkly'
			? [
					'  flagKey     | subjectKey | country | plan | ld_application.versionName',
					'  ------------|------------|---------|------|---------------------------',
					'  my-flag     | user-1     | US      | pro  | 4.9.0',
					'  my-flag     | user-2     | GB      | free | 4.8.0',
					'  other-flag  | user-1     | US      | pro  |',
				]
			: [
					'  flagKey     | subjectKey | country | plan',
					'  ------------|------------|---------|-----',
					'  my-flag     | user-1     | US      | pro',
					'  my-flag     | user-2     | GB      | free',
					'  other-flag  | user-1     | US      | pro',
				];

	return [
		'Example CSV layout (header row required):',
		'',
		...exampleRows,
		'',
		'Columns:',
		'  - Column 1 (flagKey):    The feature flag key to evaluate.',
		'  - Column 2 (subjectKey): The subject identifier (user ID, device ID, etc.).',
		'  - Columns 3+ (optional): Subject attribute names and values.',
		attrNote,
		'',
		'Value coercion:',
		"  - 'true' / 'false' (case-insensitive) → boolean",
		'  - Numeric strings (e.g. 42, -3.14) → number',
		'  - Empty cell → attribute omitted',
		"  - To force a numeric-looking value to stay a string, prefix it with a single quote (e.g. '12345 keeps the leading-zero / large-id intact).",
	].join('\n');
}
