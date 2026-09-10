import type {
	DatadogAllocationDetail,
	DatadogAllocationUpsertRequest,
	DatadogExposureScheduleDetail,
	DatadogFlagEntry,
	DatadogFlagEnvironmentAllocations,
	DatadogGuardrailMetricDetail,
	DatadogVariantWeightDetail,
} from '../datadog/types.js';

export interface TargetingAttributeChange {
	allocationKey: string;
	allocationName: string;
	previousAttribute: string;
	updatedAttribute: string;
}

export interface TargetingAttributeEnvironmentPlan {
	environmentId: string;
	environmentName: string;
	allocations: DatadogAllocationUpsertRequest[];
	changes: TargetingAttributeChange[];
}

export interface TargetingAttributeFlagPlan {
	flag: DatadogFlagEntry;
	environments: TargetingAttributeEnvironmentPlan[];
}

function requestVariantWeight(
	weight: DatadogVariantWeightDetail,
): DatadogVariantWeightDetail {
	return {
		value: weight.value,
		...(weight.variant_id !== undefined
			? { variant_id: weight.variant_id }
			: {}),
		...(weight.variant_key !== undefined
			? { variant_key: weight.variant_key }
			: {}),
	};
}

function requestGuardrailMetric(
	metric: DatadogGuardrailMetricDetail,
): DatadogGuardrailMetricDetail {
	return {
		metric_id: metric.metric_id,
		trigger_action: metric.trigger_action,
	};
}

function requestExposureSchedule(
	schedule: DatadogExposureScheduleDetail,
): DatadogExposureScheduleDetail {
	return {
		...(schedule.absolute_start_time !== undefined
			? { absolute_start_time: schedule.absolute_start_time }
			: {}),
		...(schedule.control_variant_id !== undefined
			? { control_variant_id: schedule.control_variant_id }
			: {}),
		...(schedule.control_variant_key !== undefined
			? { control_variant_key: schedule.control_variant_key }
			: {}),
		...(schedule.id !== undefined ? { id: schedule.id } : {}),
		rollout_options: {
			strategy: schedule.rollout_options.strategy,
			...(schedule.rollout_options.autostart !== undefined
				? { autostart: schedule.rollout_options.autostart }
				: {}),
			...(schedule.rollout_options.selection_interval_ms !== undefined
				? {
						selection_interval_ms:
							schedule.rollout_options.selection_interval_ms,
					}
				: {}),
		},
		rollout_steps: schedule.rollout_steps.map((step) => ({
			exposure_ratio: step.exposure_ratio,
			grouped_step_index: step.grouped_step_index,
			...(step.id !== undefined ? { id: step.id } : {}),
			...(step.interval_ms !== undefined
				? { interval_ms: step.interval_ms }
				: {}),
			is_pause_record: step.is_pause_record,
		})),
	};
}

function toUpsertRequest(
	allocation: DatadogAllocationDetail,
	targetingRules: DatadogAllocationDetail['targeting_rules'],
): DatadogAllocationUpsertRequest {
	return {
		...(allocation.id !== undefined ? { id: allocation.id } : {}),
		key: allocation.key,
		name: allocation.name,
		type: allocation.type,
		...(targetingRules !== undefined
			? { targeting_rules: targetingRules }
			: {}),
		...(allocation.variant_weights !== undefined
			? {
					variant_weights: allocation.variant_weights.map(requestVariantWeight),
				}
			: {}),
		...(allocation.experiment_id !== undefined
			? { experiment_id: allocation.experiment_id }
			: {}),
		...(allocation.exposure_schedule !== undefined
			? {
					exposure_schedule: requestExposureSchedule(
						allocation.exposure_schedule,
					),
				}
			: {}),
		...(allocation.guardrail_metrics !== undefined
			? {
					guardrail_metrics: allocation.guardrail_metrics.map(
						requestGuardrailMetric,
					),
				}
			: {}),
	};
}

function cleanAllocation(allocation: DatadogAllocationDetail): {
	request: DatadogAllocationUpsertRequest;
	changes: TargetingAttributeChange[];
} {
	const changes: TargetingAttributeChange[] = [];
	const targetingRules = allocation.targeting_rules?.map((rule) => ({
		...rule,
		conditions: rule.conditions.map((condition) => {
			const previousAttribute = condition.attribute;
			if (previousAttribute === undefined || !previousAttribute.includes('/')) {
				return { ...condition };
			}

			const updatedAttribute = previousAttribute.replaceAll('/', '');
			changes.push({
				allocationKey: allocation.key,
				allocationName: allocation.name,
				previousAttribute,
				updatedAttribute,
			});
			return { ...condition, attribute: updatedAttribute };
		}),
	}));

	return {
		request: toUpsertRequest(allocation, targetingRules),
		changes,
	};
}

export function planTargetingAttributeCleanup(
	flag: DatadogFlagEntry,
	environments: DatadogFlagEnvironmentAllocations[],
): TargetingAttributeFlagPlan | null {
	const environmentPlans: TargetingAttributeEnvironmentPlan[] = [];

	for (const environment of environments) {
		const cleaned = environment.allocations.map(cleanAllocation);
		const changes = cleaned.flatMap((allocation) => allocation.changes);
		if (changes.length === 0) continue;

		environmentPlans.push({
			environmentId: environment.environment_id,
			environmentName:
				environment.environment_name ?? environment.environment_id,
			allocations: cleaned.map((allocation) => allocation.request),
			changes,
		});
	}

	return environmentPlans.length === 0
		? null
		: { flag, environments: environmentPlans };
}

export function targetingAttributeChangeCount(
	plan: TargetingAttributeFlagPlan,
): number {
	return plan.environments.reduce(
		(total, environment) => total + environment.changes.length,
		0,
	);
}

export interface TargetingAttributeApplyFailure {
	flagKey: string;
	environmentName: string;
	error: unknown;
}

export interface TargetingAttributeApplyResult {
	updated: number;
	approvalRequested: number;
	failures: TargetingAttributeApplyFailure[];
	environmentResults: TargetingAttributeEnvironmentResult[];
}

export type TargetingAttributeEnvironmentStatus =
	| 'Updated'
	| 'Approval requested'
	| 'Failed';

export interface TargetingAttributeEnvironmentResult {
	flag: DatadogFlagEntry;
	environment: TargetingAttributeEnvironmentPlan;
	status: TargetingAttributeEnvironmentStatus;
	error?: unknown;
}

export async function applyTargetingAttributePlans(
	plans: TargetingAttributeFlagPlan[],
	update: (
		plan: TargetingAttributeFlagPlan,
		environment: TargetingAttributeEnvironmentPlan,
	) => Promise<'updated' | 'approval_requested'>,
	onProgress?: (
		plan: TargetingAttributeFlagPlan,
		environment: TargetingAttributeEnvironmentPlan,
		index: number,
		total: number,
	) => void,
): Promise<TargetingAttributeApplyResult> {
	const result: TargetingAttributeApplyResult = {
		updated: 0,
		approvalRequested: 0,
		failures: [],
		environmentResults: [],
	};
	const total = plans.reduce(
		(count, plan) => count + plan.environments.length,
		0,
	);
	let index = 0;

	for (const plan of plans) {
		for (const environment of plan.environments) {
			index++;
			onProgress?.(plan, environment, index, total);
			try {
				const outcome = await update(plan, environment);
				const status: TargetingAttributeEnvironmentStatus =
					outcome === 'approval_requested' ? 'Approval requested' : 'Updated';
				if (outcome === 'approval_requested') {
					result.approvalRequested++;
				} else {
					result.updated++;
				}
				result.environmentResults.push({
					flag: plan.flag,
					environment,
					status,
				});
			} catch (error) {
				result.failures.push({
					flagKey: plan.flag.key,
					environmentName: environment.environmentName,
					error,
				});
				result.environmentResults.push({
					flag: plan.flag,
					environment,
					status: 'Failed',
					error,
				});
			}
		}
	}

	return result;
}
