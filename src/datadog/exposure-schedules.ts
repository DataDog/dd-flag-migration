import type { DatadogExposureScheduleRequest } from './types.js';

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The backend stops a persisted rollout when its strategy changes, but cannot
 * stop a completed rollout. Both strategies support a single indefinite step:
 * keep the target strategy while still applying the source's final exposure.
 */
export function retainTargetStrategyForCompletedSchedule(
	schedule: DatadogExposureScheduleRequest,
	existing: unknown,
): DatadogExposureScheduleRequest {
	if (
		schedule.rollout_options.scheduled_start !== 'now' ||
		!record(existing) ||
		!record(existing.rollout_options)
	)
		return schedule;
	const options = existing.rollout_options;
	if (
		options.strategy !== 'UNIFORM_INTERVALS' &&
		options.strategy !== 'NO_ROLLOUT'
	)
		return schedule;
	return {
		...schedule,
		rollout_options: {
			...schedule.rollout_options,
			strategy: options.strategy,
			selection_interval_ms:
				options.strategy === 'UNIFORM_INTERVALS' &&
				typeof options.selection_interval_ms === 'number'
					? options.selection_interval_ms
					: 0,
		},
	};
}

/**
 * Copy configuration only. Schedule/step UUIDs, history, and control variant
 * UUIDs belong to the source org and must never be sent to the target.
 * absolute_start_time is the actual start; scheduled_start_time is a pending
 * start. Older API versions also represent future starts in absolute_start_time.
 * Completed schedules become a single, immediately effective final step so
 * syncing onto an existing schedule cannot replay its ramp. An expired schedule
 * with no indefinite final step no longer serves traffic and is omitted.
 */
export function copyMigratableExposureSchedule(
	value: unknown,
	variantKeysById: ReadonlyMap<string, string>,
	now = Date.now(),
):
	| { schedule: DatadogExposureScheduleRequest; completed?: true }
	| { schedule: null; completed: true }
	| { reason: string } {
	if (!record(value)) return { reason: 'has an invalid exposure schedule' };
	const invalid = { reason: 'has an invalid exposure schedule' };
	const started = {
		reason: 'uses a scheduled rollout that is still running or paused',
	};
	for (const field of ['absolute_start_time', 'scheduled_start_time']) {
		const time = value[field];
		if (time == null) continue;
		if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) {
			return invalid;
		}
	}
	const absoluteStart =
		typeof value.absolute_start_time === 'string'
			? Date.parse(value.absolute_start_time)
			: undefined;
	const hasStarted = absoluteStart !== undefined && absoluteStart <= now;
	// A due pending start isn't proof that the scheduler has actually started it.
	if (
		value.scheduled_start_time != null &&
		(hasStarted || Date.parse(String(value.scheduled_start_time)) <= now)
	) {
		return {
			reason: 'uses a scheduled rollout whose start state cannot be verified',
		};
	}
	const options = value.rollout_options;
	const steps = value.rollout_steps;
	if (
		!record(options) ||
		!['UNIFORM_INTERVALS', 'NO_ROLLOUT'].includes(String(options.strategy)) ||
		typeof options.autostart !== 'boolean' ||
		!Array.isArray(steps) ||
		steps.length === 0
	)
		return invalid;
	if (
		value.guardrail_triggered_action ||
		(Array.isArray(value.guardrail_triggers) &&
			value.guardrail_triggers.length > 0)
	)
		return started;
	if (value.apm_retention != null) {
		return { reason: 'uses an exposure schedule with APM retention' };
	}
	const start = value.scheduled_start_time ?? value.absolute_start_time;
	if (start == null && options.autostart) {
		return {
			reason: 'uses a scheduled rollout whose start state cannot be verified',
		};
	}
	if (
		options.selection_interval_ms != null &&
		(typeof options.selection_interval_ms !== 'number' ||
			!Number.isFinite(options.selection_interval_ms))
	)
		return invalid;
	const orderedSteps = [...steps].sort(
		(a, b) => (a?.order_position ?? 0) - (b?.order_position ?? 0),
	);
	const rolloutSteps: DatadogExposureScheduleRequest['rollout_steps'] = [];
	for (const step of orderedSteps) {
		if (
			!record(step) ||
			typeof step.exposure_ratio !== 'number' ||
			!Number.isFinite(step.exposure_ratio) ||
			step.exposure_ratio < 0 ||
			step.exposure_ratio > 1 ||
			!Number.isInteger(step.grouped_step_index) ||
			typeof step.is_pause_record !== 'boolean' ||
			(step.interval_ms != null &&
				(typeof step.interval_ms !== 'number' ||
					!Number.isSafeInteger(step.interval_ms) ||
					step.interval_ms < 0)) ||
			(step.order_position !== undefined &&
				!Number.isInteger(step.order_position))
		)
			return invalid;
		rolloutSteps.push({
			exposure_ratio: step.exposure_ratio,
			grouped_step_index: step.grouped_step_index as number,
			is_pause_record: step.is_pause_record,
			...(step.interval_ms !== undefined
				? { interval_ms: step.interval_ms as number | null }
				: {}),
		});
	}
	let completed = false;
	if (hasStarted) {
		let elapsed = now - absoluteStart;
		for (let index = 0; index < rolloutSteps.length; index++) {
			const step = rolloutSteps[index];
			if (step.interval_ms == null) {
				// An indefinite pause or non-final hold never completes, even if
				// the sum of the other step durations is in the past.
				if (
					step.is_pause_record ||
					index !== rolloutSteps.length - 1 ||
					elapsed <= 0
				)
					return started;
				completed = true;
				break;
			}
			if (elapsed <= step.interval_ms) return started;
			elapsed -= step.interval_ms;
		}
		if (!completed) return { schedule: null, completed: true };
	} else if (rolloutSteps.some((step) => step.is_pause_record)) {
		return started;
	}
	let controlKey: string | undefined;
	if (value.control_variant_id != null) {
		controlKey = variantKeysById.get(String(value.control_variant_id));
		if (controlKey === undefined) {
			return {
				reason:
					'has an exposure schedule referencing an unknown control variant',
			};
		}
	} else if (typeof value.control_variant_key === 'string') {
		controlKey = value.control_variant_key;
	}
	const startTime =
		typeof start === 'string' ? new Date(start).toISOString() : undefined;
	return {
		...(completed ? { completed: true as const } : {}),
		schedule: {
			...(controlKey !== undefined ? { control_variant_key: controlKey } : {}),
			...(completed
				? {
						absolute_start_time: new Date(
							absoluteStart as number,
						).toISOString(),
					}
				: startTime
					? { scheduled_start_time: startTime }
					: {}),
			rollout_options: {
				strategy: completed
					? 'NO_ROLLOUT'
					: (options.strategy as 'UNIFORM_INTERVALS' | 'NO_ROLLOUT'),
				// Never accidentally start an idle source schedule during creation.
				autostart: false,
				// Existing schedules preserve their persisted start timestamp.
				// "now" activates an idle/future target directly at the final
				// exposure; completed targets retain their past start.
				scheduled_start: completed
					? 'now'
					: startTime
						? `absolute:${startTime}`
						: 'none',
				...(completed
					? { selection_interval_ms: 0 }
					: typeof options.selection_interval_ms === 'number'
						? { selection_interval_ms: options.selection_interval_ms }
						: {}),
			},
			rollout_steps: completed
				? [
						{
							exposure_ratio:
								rolloutSteps[rolloutSteps.length - 1].exposure_ratio,
							grouped_step_index: 0,
							is_pause_record: false,
							interval_ms: null,
						},
					]
				: rolloutSteps,
		},
	};
}
