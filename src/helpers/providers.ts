import type { MigrateProviderValue } from '../args.js';

/** Source platforms offered by `migrate`, in prompt order. */
export const MIGRATION_PROVIDERS: ReadonlyArray<{
	name: string;
	value: MigrateProviderValue;
}> = [
	{ name: 'Eppo → Datadog', value: 'eppo' },
	{ name: 'Datadog → Datadog', value: 'datadog' },
	{ name: 'LaunchDarkly → Datadog', value: 'launchdarkly' },
];
