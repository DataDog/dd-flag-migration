import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import {
	buildDependentFlagRows,
	formatLaunchDarklyOwner,
} from '../src/dependent-flags/report.js';
import {
	DEPENDENT_FLAG_HEADERS,
	exportDependentFlagsToXlsx,
} from '../src/dependent-flags/xlsx.js';
import type { LDProject } from '../src/launchdarkly/api.js';
import type {
	LDEnvironment,
	LDEnvironmentConfig,
	LDFlag,
} from '../src/launchdarkly/types.js';

const project: LDProject = { key: 'mobile', name: 'Mobile' };
const environment: LDEnvironment = {
	key: 'production',
	name: 'Production',
	color: 'abcdef',
	archived: false,
};

function environmentConfig(
	prerequisites: Array<{ key: string; variation: number }>,
): LDEnvironmentConfig {
	return {
		on: true,
		archived: false,
		targets: [],
		contextTargets: [],
		rules: [],
		fallthrough: { variation: 0 },
		offVariation: 1,
		prerequisites,
		_environmentName: 'Production',
	};
}

function flag(overrides: Partial<LDFlag>): LDFlag {
	return {
		name: 'Flag',
		kind: 'boolean',
		key: 'flag',
		variations: [
			{ _id: 'on', name: 'Enabled', value: true },
			{ _id: 'off', name: 'Disabled', value: false },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
		...overrides,
	};
}

describe('dependent flag report rows', () => {
	it('resolves every prerequisite and its required variation', () => {
		const dependent = flag({
			key: 'checkout',
			name: 'Checkout',
			_maintainerTeam: { key: 'commerce', name: 'Commerce Team' },
			environments: {
				production: environmentConfig([
					{ key: 'payments', variation: 0 },
					{ key: 'inventory', variation: 1 },
				]),
			},
		});
		const payments = flag({
			key: 'payments',
			name: 'Payments',
			variations: [{ _id: 'json', name: 'Ready', value: { ready: true } }],
		});
		const inventory = flag({ key: 'inventory', name: 'Inventory' });

		const rows = buildDependentFlagRows(
			project,
			environment,
			[dependent, payments, inventory],
			'Example Org',
		);

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			dependentFlagKey: 'checkout',
			prerequisiteFlagKey: 'inventory',
			requiredVariationIndex: 1,
			requiredVariationName: 'Disabled',
			requiredVariationValue: false,
			owner: 'Commerce Team',
			unresolved: false,
		});
		expect(rows[1]).toMatchObject({
			prerequisiteFlagKey: 'payments',
			requiredVariationName: 'Ready',
			requiredVariationValue: { ready: true },
		});
	});

	it('retains unresolved prerequisite keys and variation indexes', () => {
		const dependent = flag({
			key: 'dependent',
			environments: {
				production: environmentConfig([
					{ key: 'missing', variation: 4 },
					{ key: 'existing', variation: 8 },
				]),
			},
		});

		const rows = buildDependentFlagRows(
			project,
			environment,
			[dependent, flag({ key: 'existing', name: 'Existing' })],
			'Example Org',
		);

		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.unresolved)).toBe(true);
		expect(
			rows.find((row) => row.prerequisiteFlagKey === 'missing'),
		).toMatchObject({
			prerequisiteFlagName: '',
			requiredVariationIndex: 4,
			requiredVariationValue: '',
		});
	});

	it('formats team, member, and fallback owner identities', () => {
		expect(
			formatLaunchDarklyOwner(
				flag({
					_maintainer: {
						_id: 'member',
						firstName: 'Ada',
						lastName: 'Lovelace',
						email: 'ada@example.com',
						role: 'reader',
					},
				}),
			),
		).toBe('Ada Lovelace');
		expect(
			formatLaunchDarklyOwner(flag({ maintainerTeamKey: 'platform' })),
		).toBe('platform');
	});
});

describe('dependent flag spreadsheet', () => {
	it('writes the sample-compatible headers and tracking columns', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'dependent-flags-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		const rows = buildDependentFlagRows(
			project,
			environment,
			[
				flag({
					key: 'dependent',
					name: 'Dependent',
					environments: {
						production: environmentConfig([
							{ key: 'prerequisite', variation: 0 },
						]),
					},
				}),
				flag({
					key: 'prerequisite',
					name: 'Prerequisite',
					variations: [
						{ _id: 'json', name: 'Configured', value: { enabled: true } },
					],
				}),
			],
			'Example Org',
		);

		try {
			const filepath = await exportDependentFlagsToXlsx(rows, outputDirectory);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Dependent Flags');

			expect(
				DEPENDENT_FLAG_HEADERS.map(
					(_, index) => worksheet?.getCell(1, index + 1).value,
				),
			).toEqual([...DEPENDENT_FLAG_HEADERS]);
			expect(worksheet?.getCell('A2').value).toBe('mobile');
			expect(worksheet?.getCell('B2').value).toBe('Example Org');
			expect(worksheet?.getCell('F2').value).toBe('dependent');
			expect(worksheet?.getCell('H2').value).toBe('prerequisite');
			expect(worksheet?.getCell('K2').value).toBe('{"enabled":true}');
			expect(worksheet?.getCell('M2').value).toBe('');
			expect(worksheet?.getCell('N2').value).toBe('');
			expect(worksheet?.autoFilter).toBe('A1:N1');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
