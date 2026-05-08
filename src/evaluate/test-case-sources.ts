import fs from 'node:fs';
import { generateEppoTestCases } from '../eppo/evaluate.js';
import { generateLDTestCases } from '../launchdarkly/evaluate.js';
import type { LDFlag } from '../launchdarkly/types.js';
import type { MigrationFile, TestCase } from '../types.js';
import { csvRowsToFlagTestCases, parseCsv, validateHeader } from './csv.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FlagWithTestCases = {
	flagKey: string;
	flagName: string;
	team: string;
	testCases: TestCase[];
};

export interface TestCaseSource {
	collect(
		migration: MigrationFile,
		sourceEnvName: string,
	): Promise<FlagWithTestCases[]>;
}

// ─── SyntheticSource ──────────────────────────────────────────────────────────

export class SyntheticSource implements TestCaseSource {
	async collect(
		migration: MigrationFile,
		sourceEnvName: string,
	): Promise<FlagWithTestCases[]> {
		if (migration.provider === 'launchdarkly') {
			const ldFlags = migration.flags as unknown as LDFlag[];
			return ldFlags.map((flag) => ({
				flagKey: flag.key,
				flagName: flag.name,
				team: flag._maintainerTeam?.name ?? flag._maintainer?.email ?? '',
				testCases: generateLDTestCases(flag, sourceEnvName),
			}));
		}
		return migration.flags.map((flag) => ({
			flagKey: flag.key,
			flagName: flag.name,
			team: flag.owner?.name ?? '',
			testCases: generateEppoTestCases(flag),
		}));
	}
}

// ─── CsvSource ────────────────────────────────────────────────────────────────

export class CsvSource implements TestCaseSource {
	constructor(
		private readonly csvPath: string,
		private readonly prefetched?: { header: string[]; rows: string[][] },
	) {}

	async collect(
		migration: MigrationFile,
		_sourceEnvName: string,
	): Promise<FlagWithTestCases[]> {
		let header: string[];
		let rows: string[][];
		if (this.prefetched) {
			({ header, rows } = this.prefetched);
		} else {
			const content = fs.readFileSync(this.csvPath, 'utf-8');
			({ header, rows } = parseCsv(content));
		}
		const provider =
			migration.provider === 'launchdarkly' ? 'launchdarkly' : 'eppo';
		validateHeader(header, rows, provider);

		const groups = csvRowsToFlagTestCases(header, rows);

		// Build enrichment map from migration flags
		const infoMap = new Map<string, { name: string; team: string }>();
		if (migration.provider === 'launchdarkly') {
			const ldFlags = migration.flags as unknown as LDFlag[];
			for (const flag of ldFlags) {
				infoMap.set(flag.key, {
					name: flag.name,
					team: flag._maintainerTeam?.name ?? flag._maintainer?.email ?? '',
				});
			}
		} else {
			for (const flag of migration.flags) {
				infoMap.set(flag.key, {
					name: flag.name,
					team: flag.owner?.name ?? '',
				});
			}
		}

		return groups.map((group) => {
			const info = infoMap.get(group.flagKey);
			return {
				flagKey: group.flagKey,
				flagName: info?.name ?? group.flagKey,
				team: info?.team ?? '',
				testCases: group.testCases,
			};
		});
	}
}
