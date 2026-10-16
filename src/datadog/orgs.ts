import chalk from 'chalk';
import { type EnvVarName, requireEnvVars } from '../helpers/env.js';
import { fetchCurrentUserIdentity } from './api.js';
import { DATADOG_BASE_URL_ENV, DATADOG_HTTP_HEADERS_ENV } from './auth.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DatadogOrgRole = 'source' | 'target';

/** Credentials and site for one of the two orgs in an org-to-org command. */
export interface DatadogOrgConnection {
	role: DatadogOrgRole;
	apiKey: string;
	appKey: string;
	site: string;
}

export interface DatadogOrgPair {
	source: DatadogOrgConnection;
	target: DatadogOrgConnection;
}

export const DATADOG_ORG_ENV_VARS: readonly EnvVarName[] = [
	'SOURCE_DD_API_KEY',
	'SOURCE_DD_APP_KEY',
	'SOURCE_DD_SITE',
	'TARGET_DD_API_KEY',
	'TARGET_DD_APP_KEY',
	'TARGET_DD_SITE',
];

/**
 * Process-wide Datadog overrides that would be sent to both orgs. Org-to-org
 * commands cannot tell which org they belong to, so they are rejected rather
 * than silently routing both orgs to the same host or credentials.
 */
const SINGLE_ORG_OVERRIDES = [
	DATADOG_BASE_URL_ENV,
	DATADOG_HTTP_HEADERS_ENV,
] as const;

// ─── Resolution ───────────────────────────────────────────────────────────────

/** Pure check for overrides that cannot be scoped to a single org. */
export function findUnsupportedOrgOverrides(
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	return SINGLE_ORG_OVERRIDES.filter((name) => env[name]?.trim());
}

export function datadogOrgPairFromValues(
	values: Record<EnvVarName, string>,
): DatadogOrgPair {
	return {
		source: {
			role: 'source',
			apiKey: values.SOURCE_DD_API_KEY,
			appKey: values.SOURCE_DD_APP_KEY,
			site: values.SOURCE_DD_SITE,
		},
		target: {
			role: 'target',
			apiKey: values.TARGET_DD_API_KEY,
			appKey: values.TARGET_DD_APP_KEY,
			site: values.TARGET_DD_SITE,
		},
	};
}

/**
 * Read both orgs' credentials from SOURCE_DD_* and TARGET_DD_*. Exits with the
 * standard missing-variable message when any of the six variables is unset.
 */
export function requireDatadogOrgPair(): DatadogOrgPair {
	const unsupported = findUnsupportedOrgOverrides(process.env);
	if (unsupported.length > 0) {
		process.stderr.write(
			chalk.red(
				`\n${unsupported.join(' and ')} cannot be used when working with two Datadog orgs.\n`,
			),
		);
		process.stderr.write(
			chalk.gray(
				'Unset them and provide SOURCE_DD_* and TARGET_DD_* credentials instead.\n\n',
			),
		);
		process.exit(1);
	}
	return datadogOrgPairFromValues(requireEnvVars([...DATADOG_ORG_ENV_VARS]));
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Refuse to run when both credential sets resolve to the same org: a migration
 * would rewrite flags from themselves and a diff would always report no
 * differences. Identity lookup failures only warn, because the check is a
 * safety net rather than a required permission.
 */
export async function assertDistinctDatadogOrgs(
	pair: DatadogOrgPair,
): Promise<void> {
	if (
		pair.source.site === pair.target.site &&
		pair.source.apiKey === pair.target.apiKey &&
		pair.source.appKey === pair.target.appKey
	) {
		throw new Error(
			'SOURCE_DD_* and TARGET_DD_* point at the same Datadog org. Use credentials for two different orgs.',
		);
	}
	let sourceOrgId: string;
	let targetOrgId: string;
	try {
		[{ orgId: sourceOrgId }, { orgId: targetOrgId }] = await Promise.all([
			fetchCurrentUserIdentity(
				pair.source.apiKey,
				pair.source.appKey,
				pair.source.site,
			),
			fetchCurrentUserIdentity(
				pair.target.apiKey,
				pair.target.appKey,
				pair.target.site,
			),
		]);
	} catch {
		console.warn(
			chalk.yellow(
				'  Could not confirm that the source and target credentials belong to different orgs.',
			),
		);
		return;
	}
	if (pair.source.site === pair.target.site && sourceOrgId === targetOrgId) {
		throw new Error(
			'SOURCE_DD_* and TARGET_DD_* point at the same Datadog org. Use credentials for two different orgs.',
		);
	}
}
