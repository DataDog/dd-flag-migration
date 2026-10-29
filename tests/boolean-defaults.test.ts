import { describe, expect, it } from '@jest/globals';
import {
	parseMigrateArgs,
	parseMigrateTagsArgs,
	resolveMigrationDefaults,
} from '../src/args.js';
import {
	parseEvaluateArgs,
	resolveEvaluateDefaults,
} from '../src/evaluate/args.js';

const migrateBase = ['--provider=eppo', '--env-map=p,p', '--feature-flag=x'];
const tagBase = [
	'--provider=eppo',
	'--datadog-site=datadoghq.com',
	'--feature-flag=x',
];

describe.each([
	['migrate', parseMigrateArgs, migrateBase],
	['sync-tags', parseMigrateTagsArgs, tagBase],
] as const)('%s command defaults', (_command, parse, base) => {
	it('retains interactive mode and disables dry-run when omitted', () => {
		const args = resolveMigrationDefaults(parse([]));
		expect(args.interactive).toBe(true);
		expect(args.dryRun).toBe(false);
		expect(args.nonInteractive).toBeUndefined();
	});

	it.each([true, false])('honors explicit interactive=%s', (value) => {
		const args = resolveMigrationDefaults(
			parse([...base, `--interactive=${value}`]),
		);
		expect(args.interactive).toBe(value);
		expect(args.nonInteractive !== undefined).toBe(!value);
	});

	it.each([true, false])('honors explicit dry-run=%s', (value) => {
		const args = resolveMigrationDefaults(
			parse([...base, `--dry-run=${value}`]),
		);
		expect(args.dryRun).toBe(value);
	});
});

describe('export defaults', () => {
	it.each([
		undefined,
		true,
		false,
	])('does not collapse export=%s in migration defaults', (value) => {
		const args = resolveMigrationDefaults(
			parseMigrateArgs(value === undefined ? [] : [`--export=${value}`]),
		);
		expect(args.doExport).toBe(value);
	});

	it.each([
		undefined,
		true,
		false,
	])('does not collapse export=%s in evaluation defaults', (value) => {
		const args = resolveEvaluateDefaults(
			parseEvaluateArgs(value === undefined ? [] : [`--export=${value}`]),
		);
		expect(args.exportXlsx).toBe(value);
	});
});

describe('evaluation command defaults', () => {
	it('preserves automatic display and migration selection when omitted', () => {
		const args = resolveEvaluateDefaults(parseEvaluateArgs([]));
		expect(args.useLatestMigration).toBe(false);
		expect(args.forceShowTable).toBe(false);
		expect(args.target).toBeUndefined();
	});

	it.each([true, false])('honors explicit display options=%s', (value) => {
		const args = resolveEvaluateDefaults(
			parseEvaluateArgs([
				`--use-latest-migration=${value}`,
				`--show-table=${value}`,
			]),
		);
		expect(args.useLatestMigration).toBe(value);
		expect(args.forceShowTable).toBe(value);
	});
});
