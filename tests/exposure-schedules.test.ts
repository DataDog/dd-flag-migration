import { describe, expect, it } from '@jest/globals';
import { copyMigratableExposureSchedule } from '../src/datadog/exposure-schedules.js';
import type { DatadogStatusFlagDetail } from '../src/datadog/types.js';
import {
	buildDatadogAllocations,
	remapAllocationVariantKeys,
	unsupportedAllocationReason,
} from '../src/datadog-migration/helpers/migration.js';
import { toSyncRequests } from '../src/helpers/migration.js';
import { canonicalEnvironmentTargeting } from '../src/org-diff/comparison.js';

const now = Date.parse('2026-10-20T12:00:00Z');
const future = '2099-01-01T00:00:00Z';
const schedule = {
	id: 'source-schedule',
	allocation_id: 'source-filter',
	absolute_start_time: null,
	scheduled_start_time: future,
	control_variant_id: 'source-control',
	rollout_options: {
		strategy: 'UNIFORM_INTERVALS',
		autostart: false,
		selection_interval_ms: 60000,
	},
	rollout_steps: [
		{
			id: 'source-step-2',
			order_position: 1,
			exposure_ratio: 1,
			grouped_step_index: 1,
			interval_ms: null,
			is_pause_record: false,
		},
		{
			id: 'source-step-1',
			order_position: 0,
			exposure_ratio: 0.1,
			grouped_step_index: 0,
			interval_ms: 60000,
			is_pause_record: false,
		},
	],
};
const variants = new Map([['source-control', 'off']]);

describe('migratable exposure schedules', () => {
	it.each([
		'FEATURE_GATE',
		'CANARY',
	])('accepts unstarted %s schedules', (type) => {
		expect(
			unsupportedAllocationReason({
				key: 'rule',
				type,
				exposure_schedule: schedule,
			}),
		).toBeUndefined();
	});

	it('copies ordered configuration, stripping source IDs and resolving the control variant', () => {
		const result = copyMigratableExposureSchedule(schedule, variants, now);
		expect(result).toEqual({
			schedule: {
				scheduled_start_time: '2099-01-01T00:00:00.000Z',
				control_variant_key: 'off',
				rollout_options: {
					strategy: 'UNIFORM_INTERVALS',
					autostart: false,
					scheduled_start: 'absolute:2099-01-01T00:00:00.000Z',
					selection_interval_ms: 60000,
				},
				rollout_steps: [
					{
						exposure_ratio: 0.1,
						grouped_step_index: 0,
						interval_ms: 60000,
						is_pause_record: false,
					},
					{
						exposure_ratio: 1,
						grouped_step_index: 1,
						interval_ms: null,
						is_pause_record: false,
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toContain('source-');
	});

	it('keeps an idle schedule idle', () => {
		expect(
			copyMigratableExposureSchedule(
				{ ...schedule, scheduled_start_time: null },
				variants,
				now,
			),
		).toMatchObject({
			schedule: {
				rollout_options: { autostart: false, scheduled_start: 'none' },
			},
		});
	});

	it('preserves a legacy future absolute start as a scheduled start', () => {
		expect(
			copyMigratableExposureSchedule(
				{
					...schedule,
					scheduled_start_time: null,
					absolute_start_time: future,
				},
				variants,
				now,
			),
		).toEqual(copyMigratableExposureSchedule(schedule, variants, now));
	});

	it.each([
		{ absolute_start_time: '2026-10-20T12:00:00Z' },
		{ absolute_start_time: '2026-10-19T12:00:00Z' },
		{ scheduled_start_time: '2026-10-20T12:00:00Z' },
		{ guardrail_triggered_action: 'ABORT' },
		{
			rollout_steps: [{ ...schedule.rollout_steps[0], is_pause_record: true }],
		},
	])('rejects started, due, paused, and aborted schedules: %j', (overrides) => {
		expect(
			copyMigratableExposureSchedule(
				{ ...schedule, ...overrides },
				variants,
				now,
			),
		).toHaveProperty('reason');
	});

	const completedSchedule = {
		...schedule,
		absolute_start_time: '2026-10-20T11:00:00Z',
		scheduled_start_time: null,
	};

	it.each([
		1, 0.35,
	])('copies completed rollouts at final exposure %s without replaying steps', (ratio) => {
		const result = copyMigratableExposureSchedule(
			{
				...completedSchedule,
				rollout_steps: [
					{ ...schedule.rollout_steps[1], interval_ms: 60000 },
					{ ...schedule.rollout_steps[0], exposure_ratio: ratio },
				],
			},
			variants,
			now,
		);
		expect(result).toEqual({
			completed: true,
			schedule: {
				absolute_start_time: '2026-10-20T11:00:00.000Z',
				control_variant_key: 'off',
				rollout_options: {
					strategy: 'NO_ROLLOUT',
					autostart: false,
					scheduled_start: 'now',
					selection_interval_ms: 0,
				},
				rollout_steps: [
					{
						exposure_ratio: ratio,
						grouped_step_index: 0,
						interval_ms: null,
						is_pause_record: false,
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toContain('source-');
	});

	it('includes elapsed pauses when deciding whether the final step has completed', () => {
		const withPause = {
			...completedSchedule,
			rollout_steps: [
				{ ...schedule.rollout_steps[1], order_position: 0, interval_ms: 60000 },
				{
					...schedule.rollout_steps[1],
					order_position: 1,
					interval_ms: 60000,
					is_pause_record: true,
				},
				{ ...schedule.rollout_steps[0], order_position: 2 },
			],
		};
		const start = Date.parse(completedSchedule.absolute_start_time);
		expect(
			copyMigratableExposureSchedule(withPause, variants, start + 90000),
		).toHaveProperty('reason');
		expect(
			copyMigratableExposureSchedule(withPause, variants, start + 120000),
		).toHaveProperty('reason');
		expect(
			copyMigratableExposureSchedule(withPause, variants, start + 120001),
		).toMatchObject({ completed: true });
	});

	it.each([
		true,
		false,
	])('does not consider an indefinite hold completed (pause=%s)', (paused) => {
		expect(
			copyMigratableExposureSchedule(
				{
					...completedSchedule,
					rollout_steps: [
						{
							...schedule.rollout_steps[1],
							interval_ms: null,
							is_pause_record: paused,
						},
						schedule.rollout_steps[0],
					],
				},
				variants,
				now,
			),
		).toHaveProperty('reason');
	});

	it('omits expired finite schedules instead of reviving their last step', () => {
		expect(
			copyMigratableExposureSchedule(
				{
					...completedSchedule,
					rollout_steps: schedule.rollout_steps.map((step) => ({
						...step,
						interval_ms: 60000,
					})),
				},
				variants,
				now,
			),
		).toEqual({ completed: true, schedule: null });
	});

	it('compares a completed source ramp with its copied final step independently of start time', () => {
		const original: DatadogStatusFlagDetail['environments'][number] = {
			environmentId: 'prod',
			status: 'ENABLED',
			allocations: [
				{ key: 'rule', type: 'CANARY', exposure_schedule: completedSchedule },
			],
		};
		const copied = copyMigratableExposureSchedule(
			completedSchedule,
			variants,
			now,
		);
		if (!('schedule' in copied) || !copied.schedule)
			throw new Error('Missing schedule');
		const target = structuredClone(original);
		if (!target.allocations) throw new Error('Missing targeting');
		target.allocations[0].exposure_schedule = {
			...copied.schedule,
			absolute_start_time: '2026-10-20T11:30:00Z',
		};
		const canonical = (env: typeof original) =>
			canonicalEnvironmentTargeting(env, variants, (id) => id);
		expect(canonical(target)).toBe(canonical(original));
		target.allocations[0].exposure_schedule = {
			...copied.schedule,
			rollout_steps: [
				{ ...copied.schedule.rollout_steps[0], exposure_ratio: 0.5 },
			],
		};
		expect(canonical(target)).not.toBe(canonical(original));
	});

	it.each([
		{ absolute_start_time: 'invalid' },
		{ rollout_steps: [] },
		{ rollout_steps: [null] },
		{ rollout_options: {} },
		{ control_variant_id: 'missing' },
		{ apm_retention: { mode: 'TEMPORARY', rate: 1 } },
		{
			scheduled_start_time: null,
			rollout_options: { ...schedule.rollout_options, autostart: true },
		},
	])('rejects schedules that cannot be safely copied: %j', (overrides) => {
		expect(
			copyMigratableExposureSchedule(
				{ ...schedule, ...overrides },
				variants,
				now,
			),
		).toHaveProperty('reason');
	});

	it('carries schedules through fan-out, target variant renames, and sync conversion', () => {
		const detail: DatadogStatusFlagDetail = {
			id: 'source',
			key: 'flag',
			name: 'Flag',
			variants: [
				{ id: 'source-control', key: 'off', name: 'Off', value: 'false' },
			],
			environments: [
				{
					environmentId: 'prod',
					status: 'ENABLED',
					allocations: [
						{
							key: 'rule',
							type: 'CANARY',
							exposure_schedule: schedule,
							variant_weights: [{ variant_id: 'source-control', value: 100 }],
						},
					],
				},
			],
		};
		const result = buildDatadogAllocations(
			detail,
			new Map([
				[
					'prod',
					[
						{
							id: 'target-1',
							name: 'Production',
							is_production: true,
							queries: [],
						},
						{ id: 'target-2', name: 'QA', is_production: false, queries: [] },
					],
				],
			]),
		);
		if (!('allocations' in result)) throw new Error(result.flagSkip);
		expect(result.allocations).toHaveLength(2);
		const remapped = remapAllocationVariantKeys(
			result.allocations,
			new Map([['off', 'original-off']]),
		);
		for (const id of ['target-1', 'target-2']) {
			expect(toSyncRequests(remapped, id)).toEqual([
				expect.objectContaining({
					type: 'CANARY',
					exposure_schedule: expect.objectContaining({
						control_variant_key: 'original-off',
					}),
					variant_weights: [{ variant_key: 'original-off', value: 100 }],
				}),
			]);
		}
	});

	it('compares schedule configuration rather than IDs and keeps downstream targeting reachable', () => {
		const environment: DatadogStatusFlagDetail['environments'][number] = {
			environmentId: 'prod',
			status: 'ENABLED',
			defaultVariantKey: 'off',
			allocations: [
				{
					key: 'scheduled',
					type: 'FEATURE_GATE',
					exposure_schedule: schedule,
					variant_weights: [{ variant_key: 'off', value: 100 }],
				},
				{
					key: 'fallback',
					variant_weights: [{ variant_key: 'on', value: 100 }],
				},
			],
		};
		const canonical = (env: typeof environment, keys = variants) =>
			canonicalEnvironmentTargeting(env, keys, (id) => id);
		const target = structuredClone(environment);
		if (!target.allocations) throw new Error('Missing targeting');
		target.allocations[0].exposure_schedule = {
			...schedule,
			id: 'target-schedule',
			control_variant_id: 'target-control',
		};
		expect(canonical(target, new Map([['target-control', 'off']]))).toBe(
			canonical(environment),
		);
		target.allocations[0].exposure_schedule = {
			...schedule,
			scheduled_start_time: '2099-02-01T00:00:00Z',
		};
		expect(canonical(target)).not.toBe(canonical(environment));
		target.allocations[0].exposure_schedule = schedule;
		target.allocations.pop();
		expect(canonical(target)).not.toBe(canonical(environment));
		delete target.allocations[0].exposure_schedule;
		expect(canonical(target)).not.toBe(canonical(environment));
	});
});
