import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import {
	coerceCell,
	csvRowsToFlagTestCases,
	formatExampleTable,
	parseCsv,
	validateHeader,
} from '../src/evaluate/csv.js';

// ─── parseCsv ────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
	it('parses simple rows (header + data)', () => {
		const result = parseCsv('flagKey,subjectKey\nflag-a,user-1\nflag-b,user-2');
		expect(result.header).toEqual(['flagKey', 'subjectKey']);
		expect(result.rows).toEqual([
			['flag-a', 'user-1'],
			['flag-b', 'user-2'],
		]);
	});

	it('parses quoted fields with embedded commas', () => {
		const result = parseCsv(
			'flagKey,subjectKey,attr\nflag-a,user-1,"hello, world"',
		);
		expect(result.rows[0]).toEqual(['flag-a', 'user-1', 'hello, world']);
	});

	it('parses quoted fields with embedded newlines', () => {
		const result = parseCsv(
			'flagKey,subjectKey,attr\nflag-a,user-1,"line1\nline2"',
		);
		expect(result.rows[0]).toEqual(['flag-a', 'user-1', 'line1\nline2']);
	});

	it('handles escaped double quotes (RFC 4180 "" → ")', () => {
		const result = parseCsv(
			'flagKey,subjectKey,attr\nflag-a,user-1,"say ""hello"""',
		);
		expect(result.rows[0]).toEqual(['flag-a', 'user-1', 'say "hello"']);
	});

	it('handles CRLF line endings', () => {
		const result = parseCsv(
			'flagKey,subjectKey\r\nflag-a,user-1\r\nflag-b,user-2',
		);
		expect(result.header).toEqual(['flagKey', 'subjectKey']);
		expect(result.rows).toEqual([
			['flag-a', 'user-1'],
			['flag-b', 'user-2'],
		]);
	});

	it('handles LF line endings', () => {
		const result = parseCsv('flagKey,subjectKey\nflag-a,user-1\nflag-b,user-2');
		expect(result.header).toEqual(['flagKey', 'subjectKey']);
		expect(result.rows).toEqual([
			['flag-a', 'user-1'],
			['flag-b', 'user-2'],
		]);
	});

	it('tolerates a trailing blank line (does not add it as a row)', () => {
		const result = parseCsv('flagKey,subjectKey\nflag-a,user-1\n');
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toEqual(['flag-a', 'user-1']);
	});

	it('strips leading UTF-8 BOM', () => {
		const bom = '﻿';
		const result = parseCsv(`${bom}flagKey,subjectKey\nflag-a,user-1`);
		expect(result.header[0]).toBe('flagKey');
		expect(result.header[0]).not.toBe('﻿flagKey');
	});

	it('tolerates trailing blank line in a multi-column CSV', () => {
		const result = parseCsv('flagKey,subjectKey,country\nflag-a,user-1,US\n');
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toEqual(['flag-a', 'user-1', 'US']);
	});

	it('returns empty header and rows for empty input (so validateHeader reports "CSV is empty")', () => {
		const result = parseCsv('');
		expect(result.header).toEqual([]);
		expect(result.rows).toEqual([]);
		expect(() => validateHeader(result.header, result.rows)).toThrow(/empty/i);
	});
});

// ─── validateHeader ──────────────────────────────────────────────────────────

describe('validateHeader', () => {
	it('accepts valid header ["flagKey","subjectKey"] with at least one data row', () => {
		expect(() =>
			validateHeader(['flagKey', 'subjectKey'], [['flag-a', 'user-1']]),
		).not.toThrow();
	});

	it('accepts valid header with extra attributes', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'country', 'plan'],
				[['flag-a', 'user-1', 'US', 'pro']],
			),
		).not.toThrow();
	});

	it('throws on empty file (header length === 0)', () => {
		expect(() => validateHeader([], [])).toThrow(/empty/i);
	});

	it('throws on header-only file (rows.length === 0)', () => {
		expect(() => validateHeader(['flagKey', 'subjectKey'], [])).toThrow(
			/no data rows/i,
		);
	});

	it('throws when column 1 !== "flagKey"', () => {
		expect(() =>
			validateHeader(['flag_key', 'subjectKey'], [['flag-a', 'user-1']]),
		).toThrow('column 1 must be "flagKey", got "flag_key"');
	});

	it('throws when column 2 !== "subjectKey"', () => {
		expect(() =>
			validateHeader(['flagKey', 'subject_key'], [['flag-a', 'user-1']]),
		).toThrow('column 2 must be "subjectKey"');
	});

	it('throws on case mismatch e.g. "FlagKey"', () => {
		expect(() =>
			validateHeader(['FlagKey', 'subjectKey'], [['flag-a', 'user-1']]),
		).toThrow('column 1 must be "flagKey"');
	});

	it('throws on duplicate attribute names in positions 3+', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'country', 'country'],
				[['flag-a', 'user-1', 'US', 'CA']],
			),
		).toThrow(/duplicate attribute name/);
	});

	it('throws when provider="launchdarkly" and attribute named "key"', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'key'],
				[['flag-a', 'user-1', 'abc']],
				'launchdarkly',
			),
		).toThrow(/reserved/i);
	});

	it('throws when provider="launchdarkly" and attribute named "kind"', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'kind'],
				[['flag-a', 'user-1', 'user']],
				'launchdarkly',
			),
		).toThrow(/reserved/i);
	});

	it('does NOT throw when provider="eppo" and attribute named "key"', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'key'],
				[['flag-a', 'user-1', 'abc']],
				'eppo',
			),
		).not.toThrow();
	});
});

// ─── coerceCell ──────────────────────────────────────────────────────────────

describe('coerceCell', () => {
	it("'' → undefined", () => {
		expect(coerceCell('')).toBeUndefined();
	});

	it("\"'42\" → string '42' (strips leading single-quote)", () => {
		expect(coerceCell("'42")).toBe('42');
	});

	it("\"'true\" → string 'true'", () => {
		expect(coerceCell("'true")).toBe('true');
	});

	it("'true' → boolean true", () => {
		expect(coerceCell('true')).toBe(true);
	});

	it("'TRUE' → boolean true", () => {
		expect(coerceCell('TRUE')).toBe(true);
	});

	it("'True' → boolean true", () => {
		expect(coerceCell('True')).toBe(true);
	});

	it("'false' → boolean false", () => {
		expect(coerceCell('false')).toBe(false);
	});

	it("'FALSE' → boolean false", () => {
		expect(coerceCell('FALSE')).toBe(false);
	});

	it("'42' → number 42", () => {
		expect(coerceCell('42')).toBe(42);
	});

	it("'-7' → number -7", () => {
		expect(coerceCell('-7')).toBe(-7);
	});

	it("'0' → number 0", () => {
		expect(coerceCell('0')).toBe(0);
	});

	it("'42.5' → number 42.5", () => {
		expect(coerceCell('42.5')).toBe(42.5);
	});

	it("'-3.14' → number -3.14", () => {
		expect(coerceCell('-3.14')).toBe(-3.14);
	});

	it("'007' → string '007' (leading zero preserved)", () => {
		expect(coerceCell('007')).toBe('007');
	});

	it("'00210' → string '00210'", () => {
		expect(coerceCell('00210')).toBe('00210');
	});

	it("'0x10' → string '0x10' (hex rejected)", () => {
		expect(coerceCell('0x10')).toBe('0x10');
	});

	it("'1e2' → string '1e2' (sci notation rejected)", () => {
		expect(coerceCell('1e2')).toBe('1e2');
	});

	it("'1E2' → string '1E2'", () => {
		expect(coerceCell('1E2')).toBe('1E2');
	});

	it("' 42 ' → string ' 42 ' (whitespace rejected)", () => {
		expect(coerceCell(' 42 ')).toBe(' 42 ');
	});

	it("' 42' → string ' 42'", () => {
		expect(coerceCell(' 42')).toBe(' 42');
	});

	it("'NaN' → string 'NaN'", () => {
		expect(coerceCell('NaN')).toBe('NaN');
	});

	it("'Infinity' → string 'Infinity'", () => {
		expect(coerceCell('Infinity')).toBe('Infinity');
	});

	it("'hello world' → string 'hello world'", () => {
		expect(coerceCell('hello world')).toBe('hello world');
	});

	it("'  ' → string '  ' (whitespace-only stays as string)", () => {
		expect(coerceCell('  ')).toBe('  ');
	});
});

// ─── csvRowsToFlagTestCases ───────────────────────────────────────────────────

describe('csvRowsToFlagTestCases', () => {
	beforeEach(() => {
		jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('groups multiple rows for same flagKey into one entry with multiple testCases', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [
			['flag-a', 'user-1'],
			['flag-a', 'user-2'],
		];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result).toHaveLength(1);
		expect(result[0].flagKey).toBe('flag-a');
		expect(result[0].testCases).toHaveLength(2);
	});

	it('testCases from different flagKeys go into separate entries', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [
			['flag-a', 'user-1'],
			['flag-b', 'user-2'],
		];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result).toHaveLength(2);
		expect(result[0].flagKey).toBe('flag-a');
		expect(result[1].flagKey).toBe('flag-b');
	});

	it('auto-generates label "subjectKey=user-1, country=US" (empty cells omitted)', () => {
		const header = ['flagKey', 'subjectKey', 'country'];
		const rows = [['flag-a', 'user-1', 'US']];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result[0].testCases[0].label).toBe('subjectKey=user-1, country=US');
	});

	it('when all non-flagKey/subjectKey cells empty: label is just "subjectKey=user-1"', () => {
		const header = ['flagKey', 'subjectKey', 'country'];
		const rows = [['flag-a', 'user-1', '']];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result[0].testCases[0].label).toBe('subjectKey=user-1');
	});

	it('sets subjectIdOverride to the subjectKey value', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [['flag-a', 'user-1']];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result[0].testCases[0].subjectIdOverride).toBe('user-1');
	});

	it('coerces attribute values (e.g., "true" → boolean true)', () => {
		const header = ['flagKey', 'subjectKey', 'isPremium'];
		const rows = [['flag-a', 'user-1', 'true']];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result[0].testCases[0].attributes.isPremium).toBe(true);
	});

	it('skips rows with wrong column count, calls console.warn with "wrong column count"', () => {
		const header = ['flagKey', 'subjectKey', 'country'];
		const rows = [
			['flag-a', 'user-1'], // missing country
			['flag-b', 'user-2', 'US'],
		];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result).toHaveLength(1);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('wrong column count'),
		);
	});

	it('skips rows with empty flagKey, calls console.warn with "flagKey is empty"', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [
			['', 'user-1'],
			['flag-b', 'user-2'],
		];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result).toHaveLength(1);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('flagKey is empty'),
		);
	});

	it('skips rows with empty subjectKey, calls console.warn with "subjectKey is empty"', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [
			['flag-a', ''],
			['flag-b', 'user-2'],
		];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result).toHaveLength(1);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('subjectKey is empty'),
		);
	});

	it('sets flagName to flagKey (caller enriches later)', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [['flag-a', 'user-1']];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result[0].flagName).toBe('flag-a');
	});

	it('sets team to empty string', () => {
		const header = ['flagKey', 'subjectKey'];
		const rows = [['flag-a', 'user-1']];
		const result = csvRowsToFlagTestCases(header, rows);
		expect(result[0].team).toBe('');
	});
});

// ─── formatExampleTable ───────────────────────────────────────────────────────

describe('formatExampleTable', () => {
	it('returns a string containing the example CSV layout', () => {
		const result = formatExampleTable('launchdarkly');
		expect(result).toContain('flagKey');
		expect(result).toContain('subjectKey');
		expect(result).toContain('my-flag');
	});

	it('includes LaunchDarkly-specific note for launchdarkly provider', () => {
		const result = formatExampleTable('launchdarkly');
		expect(result).toContain('reserved');
		expect(result).toContain('key');
		expect(result).toContain('kind');
	});

	it('includes Eppo-specific note for eppo provider', () => {
		const result = formatExampleTable('eppo');
		expect(result).toContain('Any attribute names are allowed');
	});
});

// ─── validateHeader — dotted columns ────────────────────────────────────────

describe('validateHeader — dotted columns (LD provider)', () => {
	it('accepts "ld_application.versionName"', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'ld_application.versionName'],
				[['flag-a', 'user-1', '4.9.0']],
				'launchdarkly',
			),
		).not.toThrow();
	});

	it('accepts "contextKind.key" (context identity key)', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'org.key'],
				[['flag-a', 'user-1', 'org-abc']],
				'launchdarkly',
			),
		).not.toThrow();
	});

	it('rejects "ld_application." — empty attribute name', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'ld_application.'],
				[['flag-a', 'user-1', '4.9.0']],
				'launchdarkly',
			),
		).toThrow(/empty attribute name/i);
	});

	it('rejects ".plan" — empty context kind', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', '.plan'],
				[['flag-a', 'user-1', 'pro']],
				'launchdarkly',
			),
		).toThrow(/empty context kind/i);
	});

	it('rejects "user.plan" — user context kind reserved', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'user.plan'],
				[['flag-a', 'user-1', 'pro']],
				'launchdarkly',
			),
		).toThrow(/reserved.*plain column/i);
	});

	it('rejects "kind.foo" — kind is the LD discriminator field', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'kind.foo'],
				[['flag-a', 'user-1', 'bar']],
				'launchdarkly',
			),
		).toThrow(/reserved/i);
	});

	it('still rejects undotted "key" for launchdarkly provider', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'key'],
				[['flag-a', 'user-1', 'abc']],
				'launchdarkly',
			),
		).toThrow(/reserved/i);
	});

	it('still rejects undotted "kind" for launchdarkly provider', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', 'kind'],
				[['flag-a', 'user-1', 'user']],
				'launchdarkly',
			),
		).toThrow(/reserved/i);
	});
});

describe('validateHeader — dotted columns (Eppo provider)', () => {
	it('accepts dotted names that are invalid LD context columns', () => {
		expect(() =>
			validateHeader(
				['flagKey', 'subjectKey', '.plan', 'ld_application.'],
				[['flag-a', 'user-1', 'pro', '4.9.0']],
				'eppo',
			),
		).not.toThrow();
	});
});

// ─── csvRowsToFlagTestCases — dotted columns ─────────────────────────────────

describe('csvRowsToFlagTestCases — dotted columns', () => {
	it('populates contextAttributes for ld_application.versionName', () => {
		const header = ['flagKey', 'subjectKey', 'ld_application.versionName'];
		const rows = [['flag-a', 'user-1', '4.9.0']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(tc.contextAttributes?.ld_application?.versionName).toBe('4.9.0');
	});

	it('stores dotted attr under full dotted name in flat attributes', () => {
		const header = ['flagKey', 'subjectKey', 'ld_application.versionName'];
		const rows = [['flag-a', 'user-1', '4.9.0']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(tc.attributes['ld_application.versionName']).toBe('4.9.0');
		expect(tc.attributes.versionName).toBeUndefined();
	});

	it('stores contextKind.key in flat attributes as full dotted name AND in contextAttributes as key', () => {
		const header = ['flagKey', 'subjectKey', 'org.key'];
		const rows = [['flag-a', 'user-1', 'org-abc']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(tc.attributes['org.key']).toBe('org-abc');
		expect(tc.contextAttributes?.org?.key).toBe('org-abc');
		expect(tc.attributes.key).toBeUndefined();
	});

	it('stringifies numeric-looking contextKind.key values so LD and DD agree', () => {
		const header = ['flagKey', 'subjectKey', 'org.key'];
		const rows = [['flag-a', 'user-1', '42']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(typeof tc.attributes['org.key']).toBe('string');
		expect(tc.attributes['org.key']).toBe('42');
		expect(tc.contextAttributes?.org?.key).toBe('42');
	});

	it('includes dotted column name in the test case label', () => {
		const header = ['flagKey', 'subjectKey', 'ld_application.versionName'];
		const rows = [['flag-a', 'user-1', '4.9.0']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		expect(result[0].testCases[0].label).toContain(
			'ld_application.versionName=4.9.0',
		);
	});

	it('handles both user and non-user columns in the same row', () => {
		const header = [
			'flagKey',
			'subjectKey',
			'plan',
			'ld_application.versionName',
		];
		const rows = [['flag-a', 'user-1', 'pro', '4.9.0']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(tc.attributes.plan).toBe('pro');
		expect(tc.attributes['ld_application.versionName']).toBe('4.9.0');
		expect(tc.contextAttributes?.ld_application?.versionName).toBe('4.9.0');
		expect(tc.contextAttributes?.ld_application?.plan).toBeUndefined();
	});

	it('coerces dotted column values the same as plain columns', () => {
		const header = ['flagKey', 'subjectKey', 'ld_application.buildNumber'];
		const rows = [['flag-a', 'user-1', '42']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(tc.contextAttributes?.ld_application?.buildNumber).toBe(42);
		expect(tc.attributes['ld_application.buildNumber']).toBe(42);
	});

	it('skips dotted column when cell is empty', () => {
		const header = ['flagKey', 'subjectKey', 'ld_application.versionName'];
		const rows = [['flag-a', 'user-1', '']];
		const result = csvRowsToFlagTestCases(header, rows, 'launchdarkly');
		const tc = result[0].testCases[0];
		expect(tc.contextAttributes).toBeUndefined();
		expect(tc.attributes['ld_application.versionName']).toBeUndefined();
	});

	it('does not set contextAttributes when no dotted columns have values', () => {
		const header = ['flagKey', 'subjectKey', 'plan'];
		const rows = [['flag-a', 'user-1', 'pro']];
		const tc = csvRowsToFlagTestCases(header, rows)[0].testCases[0];
		expect(tc.contextAttributes).toBeUndefined();
	});

	it('treats dotted Eppo columns as literal attributes', () => {
		const header = ['flagKey', 'subjectKey', 'org.key'];
		const rows = [['flag-a', 'user-1', '42']];
		const tc = csvRowsToFlagTestCases(header, rows, 'eppo')[0].testCases[0];

		expect(tc.attributes['org.key']).toBe(42);
		expect(tc.contextAttributes).toBeUndefined();
	});
});

// ─── formatExampleTable LD note ──────────────────────────────────────────────

describe('formatExampleTable — LD dotted column note', () => {
	it('mentions dotted column syntax', () => {
		expect(formatExampleTable('launchdarkly')).toMatch(
			/ld_application\.versionName/,
		);
	});

	it('mentions contextKind.key', () => {
		expect(formatExampleTable('launchdarkly')).toMatch(/contextKind\.key/);
	});
});
