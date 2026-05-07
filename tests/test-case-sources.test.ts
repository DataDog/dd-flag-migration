import fs from 'node:fs';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import {
	CsvSource,
	SyntheticSource,
} from '../src/evaluate/test-case-sources.js';
import type { MigrationFile } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEppoMigration(
	flags: Array<{ key: string; name: string; ownerName?: string }>,
): MigrationFile {
	return {
		provider: 'eppo',
		migratedAt: '2024-01-01T00:00:00Z',
		success: true,
		summary: { created: 0, synced: 0, skipped: 0, errored: 0, enabled: 0 },
		failures: [],
		enableFailures: [],
		flags: flags.map((f) => ({
			id: 1,
			name: f.name,
			key: f.key,
			variation_type: 'BOOLEAN',
			tag_names: [],
			updated_at: '',
			created_at: '',
			owner: f.ownerName ? { id: 1, name: f.ownerName } : undefined,
		})),
		environmentMapping: [],
	};
}

function makeLDMigration(
	flags: Array<{
		key: string;
		name: string;
		maintainerTeamName?: string;
		maintainerEmail?: string;
	}>,
): MigrationFile {
	return {
		provider: 'launchdarkly',
		migratedAt: '2024-01-01T00:00:00Z',
		success: true,
		summary: { created: 0, synced: 0, skipped: 0, errored: 0, enabled: 0 },
		failures: [],
		enableFailures: [],
		flags: flags.map((f) => ({
			id: 1,
			name: f.name,
			key: f.key,
			variation_type: 'BOOLEAN',
			tag_names: [],
			updated_at: '',
			created_at: '',
			// LDFlag shape fields
			kind: 'boolean' as const,
			variations: [],
			defaults: { onVariation: 0, offVariation: 1 },
			tags: [],
			archived: false,
			deprecated: false,
			temporary: false,
			_maintainerTeam: f.maintainerTeamName
				? { key: 'team-key', name: f.maintainerTeamName }
				: undefined,
			_maintainer: f.maintainerEmail
				? { _id: 'id', email: f.maintainerEmail, role: 'writer' }
				: undefined,
		})) as unknown as MigrationFile['flags'],
		environmentMapping: [],
	};
}

// ─── CsvSource ────────────────────────────────────────────────────────────────

describe('CsvSource.collect', () => {
	let readFileSyncSpy: ReturnType<typeof jest.spyOn>;
	let consoleWarnSpy: ReturnType<typeof jest.spyOn>;

	beforeEach(() => {
		readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
		consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		readFileSyncSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it('happy path — groups rows by flagKey and builds testCases', async () => {
		const csv =
			'flagKey,subjectKey,beta\nflag-a,user-1,true\nflag-a,user-2,false\nflag-b,user-3,true';
		readFileSyncSpy.mockReturnValue(csv);

		const migration = makeEppoMigration([
			{ key: 'flag-a', name: 'Flag A', ownerName: 'Team Alpha' },
			{ key: 'flag-b', name: 'Flag B' },
		]);

		const source = new CsvSource('/fake/path.csv');
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(2);

		const flagA = result.find((r) => r.flagKey === 'flag-a');
		expect(flagA).toBeDefined();
		expect(flagA?.testCases).toHaveLength(2);
		expect(flagA?.testCases[0].attributes).toEqual({ beta: true });
		expect(flagA?.testCases[0].subjectIdOverride).toBe('user-1');

		const flagB = result.find((r) => r.flagKey === 'flag-b');
		expect(flagB).toBeDefined();
		expect(flagB?.testCases).toHaveLength(1);
	});

	it('enriches flagName and team from migration file', async () => {
		const csv = 'flagKey,subjectKey\nflag-a,user-1';
		readFileSyncSpy.mockReturnValue(csv);

		const migration = makeEppoMigration([
			{ key: 'flag-a', name: 'Flag A', ownerName: 'Team Alpha' },
		]);

		const source = new CsvSource('/fake/path.csv');
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(1);
		expect(result[0].flagName).toBe('Flag A');
		expect(result[0].team).toBe('Team Alpha');
	});

	it('falls back flagName to flagKey and team to empty string for flags not in migration file', async () => {
		const csv = 'flagKey,subjectKey\nunknown-flag,user-1';
		readFileSyncSpy.mockReturnValue(csv);

		const migration = makeEppoMigration([]);

		const source = new CsvSource('/fake/path.csv');
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(1);
		expect(result[0].flagName).toBe('unknown-flag');
		expect(result[0].team).toBe('');
	});

	it('throws on header validation failure (wrong col 1 header)', async () => {
		const csv = 'wrong_key,subjectKey\nflag-a,user-1';
		readFileSyncSpy.mockReturnValue(csv);

		const migration = makeEppoMigration([]);

		const source = new CsvSource('/fake/path.csv');
		await expect(source.collect(migration, 'production')).rejects.toThrow(
			/Header validation failed/,
		);
	});

	it('skips rows with empty flagKey and continues without throwing', async () => {
		const csv = 'flagKey,subjectKey\nflag-a,user-1\n,user-2\nflag-b,user-3';
		readFileSyncSpy.mockReturnValue(csv);

		const migration = makeEppoMigration([
			{ key: 'flag-a', name: 'Flag A' },
			{ key: 'flag-b', name: 'Flag B' },
		]);

		const source = new CsvSource('/fake/path.csv');
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.flagKey === 'flag-a')).toBeDefined();
		expect(result.find((r) => r.flagKey === 'flag-b')).toBeDefined();
	});

	it('skips rows with wrong column count and continues without throwing', async () => {
		const csv =
			'flagKey,subjectKey,beta\nflag-a,user-1,true\nflag-bad,user-2\nflag-b,user-3,false';
		readFileSyncSpy.mockReturnValue(csv);

		const migration = makeEppoMigration([
			{ key: 'flag-a', name: 'Flag A' },
			{ key: 'flag-b', name: 'Flag B' },
		]);

		const source = new CsvSource('/fake/path.csv');
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.flagKey === 'flag-a')).toBeDefined();
		expect(result.find((r) => r.flagKey === 'flag-b')).toBeDefined();
		expect(result.find((r) => r.flagKey === 'flag-bad')).toBeUndefined();
	});
});

// ─── SyntheticSource ──────────────────────────────────────────────────────────

describe('SyntheticSource.collect', () => {
	it('returns FlagWithTestCases entries for an Eppo migration', async () => {
		const migration = makeEppoMigration([
			{ key: 'flag-a', name: 'Flag A', ownerName: 'My Team' },
		]);

		const source = new SyntheticSource();
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(1);
		expect(result[0].flagKey).toBe('flag-a');
		expect(result[0].flagName).toBe('Flag A');
		expect(result[0].team).toBe('My Team');
		expect(Array.isArray(result[0].testCases)).toBe(true);
	});

	it('returns FlagWithTestCases entries for a LaunchDarkly migration', async () => {
		const migration = makeLDMigration([
			{
				key: 'ld-flag',
				name: 'LD Flag',
				maintainerTeamName: 'LD Team',
			},
		]);

		const source = new SyntheticSource();
		const result = await source.collect(migration, 'production');

		expect(result).toHaveLength(1);
		expect(result[0].flagKey).toBe('ld-flag');
		expect(result[0].flagName).toBe('LD Flag');
		expect(result[0].team).toBe('LD Team');
		expect(Array.isArray(result[0].testCases)).toBe(true);
	});

	it('falls back to maintainer email when no maintainerTeam for LD', async () => {
		const migration = makeLDMigration([
			{
				key: 'ld-flag',
				name: 'LD Flag',
				maintainerEmail: 'owner@example.com',
			},
		]);

		const source = new SyntheticSource();
		const result = await source.collect(migration, 'production');

		expect(result[0].team).toBe('owner@example.com');
	});

	it('uses empty string for team when no maintainer info for LD', async () => {
		const migration = makeLDMigration([{ key: 'ld-flag', name: 'LD Flag' }]);

		const source = new SyntheticSource();
		const result = await source.collect(migration, 'production');

		expect(result[0].team).toBe('');
	});
});
