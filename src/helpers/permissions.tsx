import { renderStatic } from '../components/mount.js';
import { PermissionsError } from '../components/PermissionsError.js';
import { fetchCurrentUserPermissions } from '../datadog/api.js';

export async function checkRequiredPermissions(
	apiKey: string,
	appKey: string,
	site: string,
	requiredPermissions: readonly string[],
): Promise<void> {
	const actual = await fetchCurrentUserPermissions(apiKey, appKey, site);
	const missing = requiredPermissions.filter(
		(permission) => !actual.includes(permission),
	);
	if (missing.length > 0) {
		await renderStatic(<PermissionsError missing={missing} />);
		process.exit(1);
	}
}
