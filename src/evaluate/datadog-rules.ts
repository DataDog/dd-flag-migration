import { createRequire } from 'node:module';
import type { FlagsConfiguration } from '@datadog/flagging-core';
import type { SubjectAttributes } from '../types.js';
import type { Assignment } from './flag-comparison.js';

// The ESM builds of these packages use extensionless and directory imports
// that Node's native ESM loader cannot resolve, so load their CommonJS builds.
// Both are loaded the same way so the fetched configuration and the evaluator
// come from one copy of @datadog/flagging-core.
const requireCjs = createRequire(import.meta.url);
type FlaggingCore = typeof import('@datadog/flagging-core');
type RulesBasedFetch =
	typeof import('@datadog/openfeature-node-server/rules-based');

function loadFlaggingCore(): FlaggingCore {
	return requireCjs('@datadog/flagging-core') as FlaggingCore;
}

function loadRulesBasedFetch(): RulesBasedFetch {
	return requireCjs(
		'@datadog/openfeature-node-server/rules-based',
	) as RulesBasedFetch;
}

export type DatadogDistributionChannel = 'server' | 'client';

export type DatadogRulesFetchOptions = {
	site: string;
	env: string;
} & (
	| { channel: 'server'; apiKey: string }
	| { channel: 'client'; clientToken: string }
);

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Choose the rules-based channel that serves a flag. Flags distributed only to
 * client SDKs (for example, flags with SEMVER conditions) are absent from the
 * server channel.
 */
export function distributionChannelForFlag(
	distributionChannel: string | undefined,
): DatadogDistributionChannel {
	return distributionChannel?.toUpperCase() === 'CLIENT' ? 'client' : 'server';
}

/**
 * Fetch a Datadog environment's rules-based flag configuration once, so every
 * subject can be evaluated locally instead of making one request per subject.
 */
export async function fetchDatadogRulesConfiguration(
	options: DatadogRulesFetchOptions,
): Promise<FlagsConfiguration> {
	const { fetchRulesConfiguration, ConfigurationFetchError } =
		loadRulesBasedFetch();
	try {
		if (options.channel === 'client') {
			return await fetchRulesConfiguration({
				distributionChannel: 'client',
				clientToken: options.clientToken,
				env: options.env,
				site: options.site,
				timeoutMs: FETCH_TIMEOUT_MS,
			});
		}
		return await fetchRulesConfiguration({
			distributionChannel: 'server',
			apiKey: options.apiKey,
			env: options.env,
			site: options.site,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
	} catch (err) {
		if (
			err instanceof ConfigurationFetchError &&
			(err.status === 401 || err.status === 403)
		) {
			const hint =
				options.channel === 'client'
					? '  Check that DD_CLIENT_TOKEN is valid and that the organization has\n' +
						'  enabled rules-based client evaluation.'
					: '  Check that DD_API_KEY is valid for this Datadog organization.';
			throw new Error(
				`Datadog returned HTTP ${err.status} for the ${options.channel} rules-based ` +
					`flag configuration of DD_ENV "${options.env}".\n${hint}`,
			);
		}
		if (err instanceof ConfigurationFetchError) {
			throw new Error(
				`Could not fetch the ${options.channel} rules-based flag configuration ` +
					`for DD_ENV "${options.env}": ${err.message}`,
			);
		}
		throw err;
	}
}

type DatadogValueType = 'boolean' | 'number' | 'string' | 'object';

function datadogValueType(variationType: string): DatadogValueType {
	switch (variationType.toUpperCase()) {
		case 'BOOLEAN':
			return 'boolean';
		case 'INTEGER':
		case 'NUMERIC':
			return 'number';
		case 'JSON':
			return 'object';
		default:
			return 'string';
	}
}

const DEFAULT_VALUES: Record<DatadogValueType, unknown> = {
	boolean: false,
	number: 0,
	string: '',
	object: {},
};

/** Evaluate one flag for one subject against a fetched configuration. */
export function evaluateDatadogFlag(
	configuration: FlagsConfiguration,
	variationType: string,
	flagKey: string,
	subjectKey: string,
	attributes: SubjectAttributes,
): Assignment {
	const { evaluate } = loadFlaggingCore();
	const type = datadogValueType(variationType);
	const context: Record<string, string | number | boolean> = {
		targetingKey: subjectKey,
	};
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== null) context[key] = value;
	}
	const details = evaluate(
		configuration,
		type,
		flagKey,
		DEFAULT_VALUES[type] as never,
		context,
	);
	const allocation = details.flagMetadata?.allocationKey;
	if (details.errorCode !== undefined) {
		return {
			assigned: false,
			value: undefined,
			variant: null,
			allocation: null,
			detail: details.errorCode,
		};
	}
	if (details.variant === undefined) {
		return {
			assigned: false,
			value: undefined,
			variant: null,
			allocation: null,
			detail: details.reason,
		};
	}
	return {
		assigned: true,
		value: details.value,
		variant: details.variant,
		allocation: typeof allocation === 'string' ? allocation : null,
	};
}
