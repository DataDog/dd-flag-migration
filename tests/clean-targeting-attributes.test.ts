import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import {
	applyTargetingAttributePlans,
	planTargetingAttributeCleanup,
	targetingAttributeChangeCount,
} from '../src/clean-targeting-attributes/process.js';
import { exportTargetingAttributeCleanupToXlsx } from '../src/clean-targeting-attributes/xlsx.js';
import type {
	DatadogFlagEntry,
	DatadogFlagEnvironmentAllocations,
} from '../src/datadog/types.js';

const flag: DatadogFlagEntry = { id: 'flag-1', key: 'device-flag' };

describe('planTargetingAttributeCleanup', () => {
	it('deletes forward slashes only from inline attribute names', () => {
		const environments: DatadogFlagEnvironmentAllocations[] = [
			{
				environment_id: 'env-prod',
				environment_name: 'Production',
				allocations: [
					{
						id: 'allocation-1',
						key: 'device-rule',
						name: 'Device rule',
						type: 'CANARY',
						created_at: 'response-only',
						targeting_rules: [
							{
								combine: 'AND',
								conditions: [
									{
										attribute: 'ld_device./os/name',
										operator: 'MATCHES',
										value: ['(.*android.*)|(.*Android.*)'],
										custom_condition_field: true,
									},
									{
										attribute: 'ld_device.\\os\\version',
										operator: 'ONE_OF',
										value: ['17'],
									},
									{ saved_filter_id: 'saved-filter-1' },
								],
							},
						],
						variant_weights: [
							{
								variant_id: 'variant-1',
								value: 100,
								response_only_weight_field: 'ignored',
							},
						],
						experiment_id: 'experiment-1',
						guardrail_metrics: [
							{
								metric_id: 'metric-1',
								trigger_action: 'PAUSE',
								triggered_by: 'runtime-only',
							},
						],
						exposure_schedule: {
							id: 'schedule-1',
							allocation_id: 'response-only',
							rollout_options: {
								strategy: 'LINEAR',
								autostart: true,
								selection_interval_ms: 60_000,
							},
							rollout_steps: [
								{
									id: 'step-1',
									exposure_ratio: 0.5,
									grouped_step_index: 0,
									interval_ms: 60_000,
									is_pause_record: false,
									order_position: 1,
								},
							],
						},
					},
					{
						id: 'allocation-2',
						key: 'unchanged-rule',
						name: 'Unchanged rule',
						type: 'FEATURE_GATE',
						targeting_rules: [
							{ conditions: [{ saved_filter_id: 'saved-filter-2' }] },
						],
						variant_weights: [{ variant_key: 'off', value: 100 }],
					},
				],
			},
			{
				environment_id: 'env-staging',
				environment_name: 'Staging',
				allocations: [
					{
						id: 'allocation-3',
						key: 'plain-rule',
						name: 'Plain rule',
						type: 'FEATURE_GATE',
						targeting_rules: [
							{
								conditions: [
									{
										attribute: 'ld_device.os.family',
										operator: 'ONE_OF',
										value: ['Darwin'],
									},
								],
							},
						],
					},
				],
			},
		];
		const original = structuredClone(environments);

		const plan = planTargetingAttributeCleanup(flag, environments);

		expect(environments).toEqual(original);
		if (plan === null) throw new Error('Expected a cleanup plan');
		expect(plan.environments).toHaveLength(1);
		expect(plan.environments[0].environmentName).toBe('Production');
		expect(plan.environments[0].changes).toEqual([
			{
				allocationKey: 'device-rule',
				allocationName: 'Device rule',
				previousAttribute: 'ld_device./os/name',
				updatedAttribute: 'ld_device.osname',
			},
		]);
		expect(targetingAttributeChangeCount(plan)).toBe(1);

		const allocations = plan.environments[0].allocations;
		expect(allocations).toHaveLength(2);
		expect(allocations[0]).toEqual({
			id: 'allocation-1',
			key: 'device-rule',
			name: 'Device rule',
			type: 'CANARY',
			targeting_rules: [
				{
					combine: 'AND',
					conditions: [
						{
							attribute: 'ld_device.osname',
							operator: 'MATCHES',
							value: ['(.*android.*)|(.*Android.*)'],
							custom_condition_field: true,
						},
						{
							attribute: 'ld_device.\\os\\version',
							operator: 'ONE_OF',
							value: ['17'],
						},
						{ saved_filter_id: 'saved-filter-1' },
					],
				},
			],
			variant_weights: [{ variant_id: 'variant-1', value: 100 }],
			experiment_id: 'experiment-1',
			guardrail_metrics: [{ metric_id: 'metric-1', trigger_action: 'PAUSE' }],
			exposure_schedule: {
				id: 'schedule-1',
				rollout_options: {
					strategy: 'LINEAR',
					autostart: true,
					selection_interval_ms: 60_000,
				},
				rollout_steps: [
					{
						id: 'step-1',
						exposure_ratio: 0.5,
						grouped_step_index: 0,
						interval_ms: 60_000,
						is_pause_record: false,
					},
				],
			},
		});
		expect(allocations[1]).toEqual({
			id: 'allocation-2',
			key: 'unchanged-rule',
			name: 'Unchanged rule',
			type: 'FEATURE_GATE',
			targeting_rules: [
				{ conditions: [{ saved_filter_id: 'saved-filter-2' }] },
			],
			variant_weights: [{ variant_key: 'off', value: 100 }],
		});
	});

	it('returns null when no inline attributes contain slashes', () => {
		expect(
			planTargetingAttributeCleanup(flag, [
				{
					environment_id: 'env-1',
					allocations: [
						{
							key: 'saved-filter-rule',
							name: 'Saved filter rule',
							type: 'FEATURE_GATE',
							targeting_rules: [
								{
									conditions: [
										{ saved_filter_id: 'saved-filter-1' },
										{ attribute: 'device.\\name', value: ['phone'] },
									],
								},
							],
						},
					],
				},
			]),
		).toBeNull();
	});
});

describe('applyTargetingAttributePlans', () => {
	it('continues after failures and reports updates and approvals', async () => {
		const basePlan = planTargetingAttributeCleanup(flag, [
			{
				environment_id: 'env-1',
				environment_name: 'One',
				allocations: [
					{
						key: 'rule-1',
						name: 'Rule 1',
						type: 'FEATURE_GATE',
						targeting_rules: [
							{
								conditions: [{ attribute: 'device./name', value: ['phone'] }],
							},
						],
					},
				],
			},
			{
				environment_id: 'env-2',
				environment_name: 'Two',
				allocations: [
					{
						key: 'rule-2',
						name: 'Rule 2',
						type: 'FEATURE_GATE',
						targeting_rules: [
							{
								conditions: [{ attribute: 'device./version', value: ['1'] }],
							},
						],
					},
				],
			},
			{
				environment_id: 'env-3',
				environment_name: 'Three',
				allocations: [
					{
						key: 'rule-3',
						name: 'Rule 3',
						type: 'FEATURE_GATE',
						targeting_rules: [
							{
								conditions: [
									{ attribute: 'device./family', value: ['mobile'] },
								],
							},
						],
					},
				],
			},
		]);
		if (basePlan === null) throw new Error('Expected a cleanup plan');
		const update = jest
			.fn<
				(
					plan: NonNullable<typeof basePlan>,
					environment: NonNullable<typeof basePlan>['environments'][number],
				) => Promise<'updated' | 'approval_requested'>
			>()
			.mockResolvedValueOnce('updated')
			.mockRejectedValueOnce(new Error('denied'))
			.mockResolvedValueOnce('approval_requested');
		const progress = jest.fn();

		const result = await applyTargetingAttributePlans(
			[basePlan],
			update,
			progress,
		);

		expect(update).toHaveBeenCalledTimes(3);
		expect(progress).toHaveBeenCalledTimes(3);
		expect(result.updated).toBe(1);
		expect(result.approvalRequested).toBe(1);
		expect(result.environmentResults.map((entry) => entry.status)).toEqual([
			'Updated',
			'Failed',
			'Approval requested',
		]);
		expect(result.failures).toMatchObject([
			{
				flagKey: 'device-flag',
				environmentName: 'Two',
				error: { message: 'denied' },
			},
		]);
	});
});

describe('targeting attribute cleanup spreadsheet', () => {
	it('exports updates, warnings, and failures', async () => {
		const outputDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'clean-targeting-attributes-'),
		);
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		const change = {
			allocationKey: 'rule-key',
			allocationName: 'Rule name',
			previousAttribute: 'ld_device./os/name',
			updatedAttribute: 'ld_device.osname',
		};
		try {
			const filepath = await exportTargetingAttributeCleanupToXlsx(
				[
					{
						flag,
						environment: {
							environmentId: 'env-prod',
							environmentName: 'Production',
							allocations: [],
							changes: [change],
						},
						status: 'Updated',
					},
					{
						flag,
						environment: {
							environmentId: 'env-staging',
							environmentName: 'Staging',
							allocations: [],
							changes: [change],
						},
						status: 'Approval requested',
					},
					{
						flag,
						environment: {
							environmentId: 'env-zeta',
							environmentName: 'Zeta',
							allocations: [],
							changes: [change],
						},
						status: 'Failed',
						error: new Error('update failed'),
					},
				],
				[
					{
						flagId: 'unreadable-id',
						flagKey: 'unreadable-flag',
						error: new Error('inspection failed'),
					},
				],
				outputDirectory,
			);

			expect(filepath).toMatch(/clean-targeting-attributes-export-.*\.xlsx$/);
			expect(fs.existsSync(filepath)).toBe(true);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filepath);
			const worksheet = workbook.getWorksheet('Targeting Attribute Changes');
			expect(worksheet?.getCell('A5').value).toBe('device-flag');
			expect(worksheet?.getCell('G5').value).toBe('ld_device./os/name');
			expect(worksheet?.getCell('H5').value).toBe('ld_device.osname');
			expect(worksheet?.getCell('I5').value).toBe('Updated');
			expect(worksheet?.getCell('I6').value).toBe('Approval requested');
			expect(worksheet?.getCell('J6').value).toBe(
				'Change submitted and awaiting approval',
			);
			expect(worksheet?.getCell('I7').value).toBe('Failed');
			expect(worksheet?.getCell('K7').value).toBe('Error: update failed');
			expect(worksheet?.getCell('A8').value).toBe('unreadable-flag');
			expect(worksheet?.getCell('I8').value).toBe('Inspection failed');
			expect(worksheet?.getCell('K8').value).toBe('Error: inspection failed');
		} finally {
			consoleSpy.mockRestore();
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
