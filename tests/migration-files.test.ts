import { describe, expect, it } from '@jest/globals';
import {
	dryRunFilename,
	fileTimestamp,
	migrationFilename,
	parseFileTimestamp,
	sortNewestFirst,
} from '../src/helpers/migration-files.js';

const ISO = '2026-11-13T11:02:05.852Z';

describe('migration file names', () => {
	it('builds names without characters Windows rejects', () => {
		expect(fileTimestamp(ISO)).toBe('2026-11-13T11-02-05-852Z');
		expect(migrationFilename(ISO)).toBe(
			'migration-2026-11-13T11-02-05-852Z.json',
		);
		expect(dryRunFilename(ISO)).toBe('dry-run-2026-11-13T11-02-05-852Z.json');
		for (const name of [migrationFilename(ISO), dryRunFilename(ISO)]) {
			expect(name).not.toMatch(/[<>:"/\\|?*]/);
		}
	});

	it.each([
		migrationFilename(ISO),
		`migration-${ISO}.json`,
		dryRunFilename(ISO),
	])('reads the time back from %s', (name) => {
		expect(parseFileTimestamp(name)?.toISOString()).toBe(ISO);
	});

	it.each([
		'migration-.json',
		'migration-latest.json',
		'migration-2026-13-45T99-99-99-999Z.json',
	])('returns undefined for %s', (name) => {
		expect(parseFileTimestamp(name)).toBeUndefined();
	});

	it('sorts names from before and after Windows-safe names newest first', () => {
		const files = [
			'migration-2026-11-13T11:02:05.852Z.json',
			'migration-unknown.json',
			'migration-2026-11-13T11-30-00-000Z.json',
			'migration-2026-11-13T10-59-59-999Z.json',
			'migration-2026-11-13T11:15:00.000Z.json',
		];
		expect(sortNewestFirst(files)).toEqual([
			'migration-2026-11-13T11-30-00-000Z.json',
			'migration-2026-11-13T11:15:00.000Z.json',
			'migration-2026-11-13T11:02:05.852Z.json',
			'migration-2026-11-13T10-59-59-999Z.json',
			'migration-unknown.json',
		]);
		expect(files[0]).toBe('migration-2026-11-13T11:02:05.852Z.json');
	});
});
