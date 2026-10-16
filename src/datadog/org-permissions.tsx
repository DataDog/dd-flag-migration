import { renderStatic } from '../components/mount.js';
import { PermissionsError } from '../components/PermissionsError.js';
import { fetchCurrentUserPermissions } from './api.js';
import type { DatadogOrgConnection, DatadogOrgPair } from './orgs.js';

/** Read scopes every org-to-org command needs in both orgs. */
export const DATADOG_ORG_REQUIRED_PERMISSIONS = [
	'feature_flag_config_read',
	'feature_flag_environment_config_read',
] as const;

function orgDescription(org: DatadogOrgConnection): string {
	return `${org.role} org (${org.site})`;
}

/**
 * Probe read permissions in both orgs and print a per-org error for any that
 * are missing. Returns false when either org is missing a permission.
 */
export async function checkDatadogOrgPermissions(
	pair: DatadogOrgPair,
	required: readonly string[] = DATADOG_ORG_REQUIRED_PERMISSIONS,
): Promise<boolean> {
	const orgs = [pair.source, pair.target];
	const results = await Promise.all(
		orgs.map((org) =>
			fetchCurrentUserPermissions(org.apiKey, org.appKey, org.site),
		),
	);
	let ok = true;
	for (const [index, org] of orgs.entries()) {
		const missing = required.filter(
			(permission) => !results[index].includes(permission),
		);
		if (missing.length === 0) continue;
		ok = false;
		await renderStatic(
			<PermissionsError missing={missing} orgLabel={orgDescription(org)} />,
		);
	}
	return ok;
}
