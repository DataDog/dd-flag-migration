import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import ExcelJS from 'exceljs';
import {
	planTeamTagUpdate,
	syncFlagTeamTags,
} from '../src/advanced-permissions/team-tags.js';
import { exportAdvancedPermissionChangesToXlsx } from '../src/advanced-permissions/xlsx.js';
import { choiceMatchesTextFilter } from '../src/components/FilterableCheckbox.js';
import {
	buildRestrictionPolicyBindingsForTeamRemoval,
	ddClient,
	RestrictionPolicyTeamUpdateError,
	updateRestrictionPolicyTeams,
} from '../src/datadog/api.js';

const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const SITE = 'test.invalid';
const BASE = `https://api.${SITE}`;

describe('advanced permission filtering', () => {
	const choice = {
		name: 'checkout-redesign',
		searchTerms: [
			'checkout-redesign',
			'project:health-100',
			'owner:storefront',
		],
	};

	it('matches either a flag key or a tag', () => {
		expect(choiceMatchesTextFilter(choice, 'checkout')).toBe(true);
		expect(choiceMatchesTextFilter(choice, 'project:health-100')).toBe(true);
		expect(choiceMatchesTextFilter(choice, 'missing')).toBe(false);
	});

	it('combines whitespace-separated key and tag searches with union semantics', () => {
		expect(
			choiceMatchesTextFilter(choice, 'does-not-exist owner:storefront'),
		).toBe(true);
	});

	it('preserves phrase filtering when custom search terms are omitted', () => {
		expect(
			choiceMatchesTextFilter({ name: 'Flag with spaces' }, 'with spaces'),
		).toBe(true);
		expect(
			choiceMatchesTextFilter({ name: 'Flag with spaces' }, 'spaces flag'),
		).toBe(false);
	});
});

describe('advanced permission spreadsheet export', () => {
	it('writes flag/team outcomes to an xlsx workbook', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'advanced-permissions-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const filepath = await exportAdvancedPermissionChangesToXlsx(
				[
					{
						flagId: 'flag-id',
						flagKey: 'flag-key',
						flagTags: ['project:health-100'],
						teamId: 'team-id',
						teamName: 'Team Name',
						teamHandle: 'team-handle',
						operation: 'add',
						status: 'Added',
					},
				],
				'add',
				outputDirectory,
			);

			expect(filepath).toMatch(/advanced-permissions-export-.*\.xlsx$/);
			expect(fs.existsSync(filepath)).toBe(true);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Permission Changes');
			expect(worksheet?.getCell('A5').value).toBe('flag-key');
			expect(worksheet?.getCell('C5').value).toBe('project:health-100');
			expect(worksheet?.getCell('H5').value).toBe('Added');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});

describe('team tag syncing', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('adds matching team tags while preserving unrelated tags', async () => {
		let putBody: unknown;
		mock.onPut(`${BASE}/api/v2/feature-flags/flag-1`).reply((config) => {
			putBody = JSON.parse(config.data as string);
			return [200, {}];
		});

		await expect(
			syncFlagTeamTags(
				API_KEY,
				APP_KEY,
				'flag-1',
				['project:health-100', 'team:existing'],
				[
					{ id: 'existing-id', handle: 'existing', name: 'Existing' },
					{ id: 'new-id', handle: 'new', name: 'New' },
				],
				'add',
				SITE,
			),
		).resolves.toEqual({
			tags: ['project:health-100', 'team:existing', 'team:new'],
			changedTeamIds: ['new-id'],
			unchangedTeamIds: ['existing-id'],
		});
		expect(putBody).toEqual({
			data: {
				type: 'feature-flags',
				attributes: {
					tags: ['project:health-100', 'team:existing', 'team:new'],
				},
			},
		});
	});

	it('removes matching team tags while preserving unrelated tags', () => {
		expect(
			planTeamTagUpdate(
				['team:remove', 'project:health-100', 'team:keep'],
				[{ id: 'remove-id', handle: 'remove', name: 'Remove' }],
				'remove',
			),
		).toEqual({
			tags: ['project:health-100', 'team:keep'],
			changedTeamIds: ['remove-id'],
			unchangedTeamIds: [],
		});
	});

	it('does not write when team tags are already synced', async () => {
		await expect(
			syncFlagTeamTags(
				API_KEY,
				APP_KEY,
				'flag-2',
				['project:health-100', 'team:existing'],
				[{ id: 'existing-id', handle: 'existing', name: 'Existing' }],
				'add',
				SITE,
			),
		).resolves.toEqual({
			tags: ['project:health-100', 'team:existing'],
			changedTeamIds: [],
			unchangedTeamIds: ['existing-id'],
		});
		expect(mock.history.put).toHaveLength(0);
	});
});

describe('buildRestrictionPolicyBindingsForTeamRemoval', () => {
	it('removes selected teams from every relation and drops empty bindings', () => {
		expect(
			buildRestrictionPolicyBindingsForTeamRemoval(
				['remove-me'],
				[
					{
						principals: ['team:remove-me', 'user:keep-me'],
						relation: 'editor',
					},
					{ principals: ['team:remove-me'], relation: 'viewer' },
				],
			),
		).toEqual([{ principals: ['user:keep-me'], relation: 'editor' }]);
	});
});

describe('updateRestrictionPolicyTeams', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('adds missing teams as editors and reports existing editors as unchanged', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-1`)
			.reply(200, {
				data: {
					attributes: {
						bindings: [
							{ principals: ['team:existing'], relation: 'editor' },
							{ principals: ['team:new'], relation: 'viewer' },
						],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-1`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await expect(
			updateRestrictionPolicyTeams(
				API_KEY,
				APP_KEY,
				'flag-1',
				['existing', 'new'],
				'add',
				'user-1',
				'org-1',
				SITE,
			),
		).resolves.toEqual({
			changedTeamIds: ['new'],
			unchangedTeamIds: ['existing'],
		});

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		expect(
			bindings.find((binding) => binding.relation === 'editor')?.principals,
		).toEqual(
			expect.arrayContaining(['team:existing', 'team:new', 'user:user-1']),
		);
		expect(mock.history.post).toHaveLength(1);
	});

	it('does not write when every selected team is already an editor', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-2`)
			.reply(200, {
				data: {
					attributes: {
						bindings: [{ principals: ['team:existing'], relation: 'editor' }],
					},
				},
			});

		await expect(
			updateRestrictionPolicyTeams(
				API_KEY,
				APP_KEY,
				'flag-2',
				['existing'],
				'add',
				'user-1',
				'org-1',
				SITE,
			),
		).resolves.toEqual({
			changedTeamIds: [],
			unchangedTeamIds: ['existing'],
		});
		expect(mock.history.post).toHaveLength(0);
	});

	it('preserves the update plan when a write fails', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-failed`)
			.reply(200, {
				data: {
					attributes: {
						bindings: [{ principals: ['team:existing'], relation: 'editor' }],
					},
				},
			});
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-failed`)
			.reply(403, { errors: [{ detail: 'missing write permission' }] });

		const update = updateRestrictionPolicyTeams(
			API_KEY,
			APP_KEY,
			'flag-failed',
			['existing', 'new'],
			'add',
			'user-1',
			'org-1',
			SITE,
		);
		await expect(update).rejects.toBeInstanceOf(
			RestrictionPolicyTeamUpdateError,
		);
		await expect(update).rejects.toMatchObject({
			updateResult: {
				changedTeamIds: ['new'],
				unchangedTeamIds: ['existing'],
			},
		});
	});

	it('removes explicit team permissions and skips teams that are absent', async () => {
		mock
			.onGet(`${BASE}/api/v2/restriction_policy/feature-flag:flag-3`)
			.reply(200, {
				data: {
					attributes: {
						bindings: [
							{
								principals: ['team:remove', 'team:keep'],
								relation: 'editor',
							},
							{ principals: ['org:org-1'], relation: 'viewer' },
						],
					},
				},
			});

		let postBody: unknown;
		mock
			.onPost(`${BASE}/api/v2/restriction_policy/feature-flag:flag-3`)
			.reply((config) => {
				postBody = JSON.parse(config.data as string);
				return [200, {}];
			});

		await expect(
			updateRestrictionPolicyTeams(
				API_KEY,
				APP_KEY,
				'flag-3',
				['remove', 'absent'],
				'remove',
				'',
				'',
				SITE,
			),
		).resolves.toEqual({
			changedTeamIds: ['remove'],
			unchangedTeamIds: ['absent'],
		});

		const bindings = (
			postBody as {
				data: {
					attributes: {
						bindings: Array<{ principals: string[]; relation: string }>;
					};
				};
			}
		).data.attributes.bindings;
		expect(bindings).toEqual([
			{ principals: ['team:keep'], relation: 'editor' },
			{ principals: ['org:org-1'], relation: 'viewer' },
		]);
	});
});
