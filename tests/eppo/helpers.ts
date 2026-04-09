import type { EppoAllocation, EppoFlag } from '../../src/eppo/types.js';
import type { DatadogEnvironment } from '../../src/types.js';

export const ddDev: DatadogEnvironment = {
	id: 'dd-dev',
	name: 'Development',
	is_production: false,
	queries: ['dev'],
};

export const ddProd: DatadogEnvironment = {
	id: 'dd-prod',
	name: 'Production',
	is_production: true,
	queries: ['prod'],
};

export const ddStaging: DatadogEnvironment = {
	id: 'dd-staging',
	name: 'Staging',
	is_production: false,
	queries: ['staging'],
};

export function makeFlag(
	overrides: Partial<EppoFlag> & { id: number; key: string },
): EppoFlag {
	return {
		name: overrides.key,
		variation_type: 'BOOLEAN',
		tag_names: [],
		updated_at: '2024-01-01T00:00:00Z',
		created_at: '2024-01-01T00:00:00Z',
		variations: [
			{ id: 1, name: 'On', variant_key: 'on' },
			{ id: 2, name: 'Off', variant_key: 'off' },
		],
		environments: [],
		allocations: [],
		...overrides,
	};
}

export function makeAllocation(
	overrides: Partial<EppoAllocation> & { id: number },
): EppoAllocation {
	return {
		key: `alloc-${overrides.id}`,
		name: `Allocation ${overrides.id}`,
		type: 'FEATURE_GATE',
		percent_exposure: 100,
		is_default: false,
		variation_weight: [],
		targeting_rules: [],
		...overrides,
	};
}
