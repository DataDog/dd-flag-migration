import { describe, expect, it } from '@jest/globals';
import { parseEvaluateArgs } from '../../src/evaluate/args.js';
import { ArgParseError } from '../../src/helpers/boolean-args.js';

describe.each([
	['--export', 'exportXlsx', 'flag'],
	['--use-latest-migration', 'useLatestMigration', 'migration'],
	['--show-table', 'forceShowTable', 'migration'],
] as const)('parseEvaluateArgs boolean option %s', (flag, field, target) => {
	it('preserves omission as undefined', () => {
		const args = parseEvaluateArgs([]);
		expect(args[field]).toBeUndefined();
		expect(args.target).toBeUndefined();
	});

	it.each([
		['', [], true],
		['=true', [], true],
		['', ['true'], true],
		['=false', [], false],
		['', ['false'], false],
	] as const)('parses %s with trailing values %j as %s', (suffix, values, expected) => {
		const args = parseEvaluateArgs([`${flag}${suffix}`, ...values]);
		expect(args[field]).toBe(expected);
		expect(args.target).toBe(expected ? target : undefined);
	});

	it('does not consume the following option', () => {
		const args = parseEvaluateArgs([flag, '--datadog-site=datadoghq.eu']);
		expect(args[field]).toBe(true);
		expect(args.datadogSite).toBe('datadoghq.eu');
	});

	it('uses the last value when repeated', () => {
		expect(parseEvaluateArgs([flag, `${flag}=false`])[field]).toBe(false);
		expect(parseEvaluateArgs([`${flag}=false`, flag])[field]).toBe(true);
	});

	it.each(['', 'maybe'])('rejects an invalid equals value %j', (value) => {
		expect(() => parseEvaluateArgs([`${flag}=${value}`])).toThrow(
			ArgParseError,
		);
	});

	it('rejects an invalid space-separated value', () => {
		expect(() => parseEvaluateArgs([flag, 'maybe'])).toThrow(
			/ expects a boolean/,
		);
	});
});

describe('parseEvaluateArgs', () => {
	it('parses single-flag options', () => {
		expect(
			parseEvaluateArgs([
				'--provider=EPPO',
				'--flag=checkout',
				'--subjects=25',
				'--flag-environment=production',
				'--datadog-site=datadoghq.eu',
				'--export',
			]),
		).toMatchObject({
			target: 'flag',
			provider: 'eppo',
			flagKey: 'checkout',
			subjectCount: 25,
			flagEnvironment: 'production',
			datadogSite: 'datadoghq.eu',
			exportXlsx: true,
		});
	});

	it('parses migration options', () => {
		expect(
			parseEvaluateArgs([
				'--use-latest-migration',
				'--test-subject-id=user-123',
				'--csv=subjects.csv',
				'--show-table=true',
			]),
		).toMatchObject({
			target: 'migration',
			useLatestMigration: true,
			testSubjectId: 'user-123',
			csvPath: 'subjects.csv',
			forceShowTable: true,
		});
	});

	it('does not treat disabled options as conflicting targets', () => {
		expect(
			parseEvaluateArgs(['--target=flag', '--show-table=false']).target,
		).toBe('flag');
		expect(
			parseEvaluateArgs(['--target=migration', '--export', 'false']).target,
		).toBe('migration');
	});

	it.each([
		['--export', '--show-table'],
		['--target=flag', '--use-latest-migration=true'],
		['--target=migration', '--export=true'],
		['--target=unknown'],
		['--flag='],
		['--subjects=0'],
		['--subjects=2.5'],
		['--datadog-site='],
	])('rejects invalid or conflicting arguments %j', (...args) => {
		expect(() => parseEvaluateArgs(args)).toThrow(ArgParseError);
	});
});
