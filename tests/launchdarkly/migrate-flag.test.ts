/**
 * Behavioral tests for LaunchDarkly → Datadog flag migration.
 *
 * Each test defines a realistic LD flag JSON, runs the full migration pipeline,
 * and asserts on the Datadog create-flag request that would be produced.
 */
import { describe, expect, it } from '@jest/globals';
import {
	buildAllocations,
	buildVariants,
	getEnvsToEnable,
	mapFlagType,
	shouldSkipFlag,
} from '../../src/launchdarkly/migration.js';
import type {
	LDEnvironmentConfig,
	LDFlag,
} from '../../src/launchdarkly/types.js';
import type {
	DatadogCreateFlagRequest,
	DatadogEnvironment,
} from '../../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ddStaging: DatadogEnvironment = {
	id: 'dd-staging',
	name: 'Staging',
	is_production: false,
	queries: ['staging'],
};

const ddProd: DatadogEnvironment = {
	id: 'dd-prod',
	name: 'Production',
	is_production: true,
	queries: ['prod'],
};

function makeEnv(
	overrides: Partial<LDEnvironmentConfig> & { _environmentName: string },
): LDEnvironmentConfig {
	return {
		on: true,
		archived: false,
		targets: [],
		contextTargets: [],
		rules: [],
		fallthrough: { variation: 0 },
		offVariation: 1,
		prerequisites: [],
		...overrides,
	};
}

/** Simulate the full migration pipeline for a single flag and return the DD request. */
function migrateFlag(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
	selectedEnvs: string[],
): {
	skipped: boolean;
	skipReason?: string;
	warn?: string;
	request?: DatadogCreateFlagRequest;
	envsToEnable: DatadogEnvironment[];
} {
	const skipResult = shouldSkipFlag(flag, selectedEnvs);
	if (skipResult.skip) {
		return {
			skipped: true,
			skipReason: skipResult.reason,
			envsToEnable: [],
		};
	}

	const variants = buildVariants(flag);
	const allocations = buildAllocations(flag, envMapping);
	const envsToEnable = getEnvsToEnable(flag, envMapping);

	const request: DatadogCreateFlagRequest = {
		key: flag.key,
		name: flag.name,
		value_type: mapFlagType(flag),
		variants,
		allocations: allocations.length > 0 ? allocations : undefined,
	};

	return {
		skipped: false,
		warn: skipResult.warn,
		request,
		envsToEnable,
	};
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe('migrate a simple boolean flag (on in one env, off in another)', () => {
	const flag: LDFlag = {
		name: 'Enable Dark Mode',
		kind: 'boolean',
		key: 'enable-dark-mode',
		variations: [
			{ _id: 'v0', value: true, name: 'Enabled' },
			{ _id: 'v1', value: false, name: 'Disabled' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			test: makeEnv({
				_environmentName: 'Test',
				on: true,
				fallthrough: { variation: 0 },
			}),
			production: makeEnv({
				_environmentName: 'Production',
				on: false,
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map<string, DatadogEnvironment>([
		['test', ddStaging],
		['production', ddProd],
	]);
	const result = migrateFlag(flag, envMapping, ['test', 'production']);

	it('is not skipped', () => {
		expect(result.skipped).toBe(false);
	});

	it('produces BOOLEAN value_type', () => {
		expect(result.request?.value_type).toBe('BOOLEAN');
	});

	it('has two variants with slugified keys', () => {
		expect(result.request?.variants).toEqual([
			{ key: 'enabled', name: 'Enabled', value: 'true' },
			{ key: 'disabled', name: 'Disabled', value: 'false' },
		]);
	});

	it('produces one fallthrough allocation per environment', () => {
		const allocs = result.request?.allocations ?? [];
		expect(allocs).toHaveLength(2);
		expect(allocs[0].environment_id).toBe('dd-staging');
		expect(allocs[1].environment_id).toBe('dd-prod');
	});

	it('enables only the environment where the flag is on', () => {
		expect(result.envsToEnable).toHaveLength(1);
		expect(result.envsToEnable[0].id).toBe('dd-staging');
	});
});

describe('migrate a flag with individual targets, rules, and fallthrough', () => {
	// Modeled after a real flag: fflag-pdp-spl-mockadj-cost
	const flag: LDFlag = {
		name: 'PDP SPL Mock Adj Cost',
		kind: 'boolean',
		key: 'fflag-pdp-spl-mockadj-cost',
		variations: [
			{ _id: 'v0', value: true },
			{ _id: 'v1', value: false },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				targets: [
					{
						values: ['user-aaa', 'user-bbb', 'user-ccc'],
						variation: 0,
						contextKind: 'user',
					},
				],
				rules: [
					{
						_id: 'r1',
						rollout: {
							variations: [
								{ variation: 0, weight: 0 },
								{ variation: 1, weight: 100000 },
							],
						},
						clauses: [
							{
								_id: 'c1',
								attribute: 'parentTenant',
								op: 'in',
								values: ['cvs', 'caremark', 'specialty'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
					},
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: ['2025', 'PDP', 'q2'],
		archived: false,
		deprecated: false,
		temporary: true,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('produces 3 allocations: target + rule + fallthrough', () => {
		expect(result.request?.allocations).toHaveLength(3);
	});

	it('first allocation targets individual users via ONE_OF on key', () => {
		const target = result.request?.allocations?.[0];
		expect(target?.targeting_rules).toHaveLength(1);
		expect(target?.targeting_rules?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'key',
			value: ['user-aaa', 'user-bbb', 'user-ccc'],
		});
		// 100% on variation 0 (true)
		expect(target?.variant_weights).toEqual([
			{ variant_key: 'variation-0', value: 100 },
			{ variant_key: 'variation-1', value: 0 },
		]);
	});

	it('second allocation has rule targeting with rollout weights', () => {
		const rule = result.request?.allocations?.[1];
		expect(rule?.targeting_rules).toHaveLength(1);
		expect(rule?.targeting_rules?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'parentTenant',
			value: ['cvs', 'caremark', 'specialty'],
		});
		// Rollout: 0% true, 100% false
		expect(rule?.variant_weights).toEqual([
			{ variant_key: 'variation-0', value: 0 },
			{ variant_key: 'variation-1', value: 100 },
		]);
	});

	it('third allocation is fallthrough with no targeting rules', () => {
		const ft = result.request?.allocations?.[2];
		expect(ft?.targeting_rules).toBeUndefined();
		// 100% on variation 1 (false)
		expect(ft?.variant_weights).toEqual([
			{ variant_key: 'variation-0', value: 0 },
			{ variant_key: 'variation-1', value: 100 },
		]);
	});

	it('enables production because flag is on', () => {
		expect(result.envsToEnable).toHaveLength(1);
		expect(result.envsToEnable[0].id).toBe('dd-prod');
	});
});

describe('migrate a multivariate JSON flag', () => {
	const flag: LDFlag = {
		name: 'Auth Login Config',
		kind: 'multivariate',
		key: 'auth-login-config',
		variations: [
			{
				_id: 'v0',
				value: { cookie: 'token-a', roles: ['admin'] },
				name: 'Config A',
			},
			{
				_id: 'v1',
				value: { cookie: 'token-b', roles: ['user'] },
				name: 'Config B',
			},
			{ _id: 'v2', value: {}, name: 'Default' },
		],
		defaults: { onVariation: 0, offVariation: 2 },
		environments: {
			dev: makeEnv({
				_environmentName: 'Dev',
				on: true,
				rules: [
					{
						_id: 'r1',
						variation: 0,
						clauses: [
							{
								_id: 'c1',
								attribute: 'name',
								op: 'in',
								values: ['ADMIN'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
					},
				],
				fallthrough: { variation: 2 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['dev', ddStaging]]);
	const result = migrateFlag(flag, envMapping, ['dev']);

	it('infers JSON value_type from object variation values', () => {
		expect(result.request?.value_type).toBe('JSON');
	});

	it('serializes object values as JSON strings', () => {
		expect(result.request?.variants?.[0].value).toBe(
			'{"cookie":"token-a","roles":["admin"]}',
		);
		expect(result.request?.variants?.[2].value).toBe('{}');
	});

	it('slugifies variant keys from names', () => {
		expect(result.request?.variants?.map((v) => v.key)).toEqual([
			'config-a',
			'config-b',
			'default',
		]);
	});

	it('rule allocation gives 100% to the targeted variation', () => {
		const rule = result.request?.allocations?.[0];
		expect(rule?.variant_weights).toEqual([
			{ variant_key: 'config-a', value: 100 },
			{ variant_key: 'config-b', value: 0 },
			{ variant_key: 'default', value: 0 },
		]);
	});

	it('fallthrough gives 100% to the default variation', () => {
		const ft = result.request?.allocations?.[1];
		expect(ft?.variant_weights).toEqual([
			{ variant_key: 'config-a', value: 0 },
			{ variant_key: 'config-b', value: 0 },
			{ variant_key: 'default', value: 100 },
		]);
	});
});

describe('migrate a multivariate numeric flag', () => {
	const flag: LDFlag = {
		name: 'Retry Count',
		kind: 'multivariate',
		key: 'retry-count',
		variations: [
			{ _id: 'v0', value: 1, name: '1 retry' },
			{ _id: 'v1', value: 3, name: '3 retries' },
			{ _id: 'v2', value: 5, name: '5 retries' },
		],
		defaults: { onVariation: 1, offVariation: 0 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('infers NUMERIC value_type', () => {
		expect(result.request?.value_type).toBe('NUMERIC');
	});

	it('stringifies numeric values', () => {
		expect(result.request?.variants?.map((v) => v.value)).toEqual([
			'1',
			'3',
			'5',
		]);
	});
});

describe('migrate a flag with regex-converted operators (contains, startsWith, endsWith)', () => {
	const flag: LDFlag = {
		name: 'Feature By Tenant',
		kind: 'boolean',
		key: 'feature-by-tenant',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				rules: [
					{
						_id: 'r1',
						variation: 0,
						clauses: [
							{
								_id: 'c1',
								attribute: 'email',
								op: 'contains',
								values: ['@acme.com'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'Acme employees',
					},
					{
						_id: 'r2',
						variation: 0,
						clauses: [
							{
								_id: 'c2',
								attribute: 'hostname',
								op: 'startsWith',
								values: ['api-v2'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'V2 API hosts',
					},
					{
						_id: 'r3',
						variation: 0,
						clauses: [
							{
								_id: 'c3',
								attribute: 'path',
								op: 'endsWith',
								values: ['/health'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'Health endpoints',
					},
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('converts "contains" to MATCHES with .*value.* regex', () => {
		const cond =
			result.request?.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('MATCHES');
		expect(cond?.value).toEqual(['.*@acme\\.com.*']);
	});

	it('converts "startsWith" to MATCHES with ^value.* regex', () => {
		const cond =
			result.request?.allocations?.[1].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('MATCHES');
		expect(cond?.value).toEqual(['^api-v2.*']);
	});

	it('converts "endsWith" to MATCHES with .*value$ regex', () => {
		const cond =
			result.request?.allocations?.[2].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('MATCHES');
		expect(cond?.value).toEqual(['.*/health$']);
	});

	it('produces 4 allocations total (3 rules + fallthrough)', () => {
		expect(result.request?.allocations).toHaveLength(4);
	});
});

describe('migrate a flag with negated operators', () => {
	const flag: LDFlag = {
		name: 'Exclude Beta Users',
		kind: 'boolean',
		key: 'exclude-beta',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				rules: [
					{
						_id: 'r1',
						variation: 1,
						clauses: [
							{
								_id: 'c1',
								attribute: 'group',
								op: 'in',
								values: ['beta-testers'],
								contextKind: 'user',
								negate: true,
							},
						],
						trackEvents: false,
					},
					{
						_id: 'r2',
						variation: 1,
						clauses: [
							{
								_id: 'c2',
								attribute: 'name',
								op: 'contains',
								values: ['test'],
								contextKind: 'user',
								negate: true,
							},
						],
						trackEvents: false,
					},
				],
				fallthrough: { variation: 0 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('converts "in" + negate to NOT_ONE_OF', () => {
		const cond =
			result.request?.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('NOT_ONE_OF');
	});

	it('converts "contains" + negate to NOT_MATCHES', () => {
		const cond =
			result.request?.allocations?.[1].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('NOT_MATCHES');
		expect(cond?.value).toEqual(['.*test.*']);
	});
});

describe('migrate a flag with semver operators', () => {
	const flag: LDFlag = {
		name: 'Min App Version',
		kind: 'boolean',
		key: 'min-app-version',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				rules: [
					{
						_id: 'r1',
						variation: 1,
						clauses: [
							{
								_id: 'c1',
								attribute: 'versionName',
								op: 'semVerLessThan',
								values: ['5.0.0'],
								contextKind: 'ld_application',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'Kill switch for old app versions',
					},
				],
				fallthrough: { variation: 0 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('maps semVerLessThan to SEMVER_LT', () => {
		const cond =
			result.request?.allocations?.[0].targeting_rules?.[0].conditions[0];
		expect(cond?.operator).toBe('SEMVER_LT');
		expect(cond?.value).toEqual(['5.0.0']);
		expect(cond?.attribute).toBe('versionName');
	});
});

describe('skip a flag with segmentMatch operator', () => {
	const flag: LDFlag = {
		name: 'Segment Flag',
		kind: 'boolean',
		key: 'segment-flag',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				rules: [
					{
						_id: 'r1',
						variation: 0,
						clauses: [
							{
								_id: 'c1',
								attribute: 'segmentMatch',
								op: 'segmentMatch',
								values: ['segment-premium-users'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
					},
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('is skipped', () => {
		expect(result.skipped).toBe(true);
	});

	it('gives a reason mentioning segment targeting', () => {
		expect(result.skipReason).toContain('Segment targeting');
	});

	it('does not produce a request', () => {
		expect(result.request).toBeUndefined();
	});
});

describe('migrate a flag with prerequisites (warn but do not skip)', () => {
	const flag: LDFlag = {
		name: 'Dependent Flag',
		kind: 'boolean',
		key: 'dependent-flag',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				prerequisites: [{ key: 'parent-flag', variation: 0 }],
				fallthrough: { variation: 0 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('is NOT skipped', () => {
		expect(result.skipped).toBe(false);
	});

	it('produces a valid request', () => {
		expect(result.request?.key).toBe('dependent-flag');
	});

	it('emits a warning about prerequisites', () => {
		expect(result.warn).toContain('prerequisites');
	});
});

describe('migrate a flag with rollout percentages in fallthrough', () => {
	const flag: LDFlag = {
		name: 'Gradual Rollout',
		kind: 'boolean',
		key: 'gradual-rollout',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				fallthrough: {
					rollout: {
						variations: [
							{ variation: 0, weight: 30000 },
							{ variation: 1, weight: 70000 },
						],
					},
				},
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('normalizes LD weights (out of 100,000) to 0-100', () => {
		const ft = result.request?.allocations?.[0];
		expect(ft?.variant_weights).toEqual([
			{ variant_key: 'on', value: 30 },
			{ variant_key: 'off', value: 70 },
		]);
	});
});

describe('migrate a flag with a rule containing mixed supported/unsupported clauses', () => {
	// If ANY clause in a rule is unsupported, the entire rule is dropped
	const flag: LDFlag = {
		name: 'Mixed Rule Flag',
		kind: 'boolean',
		key: 'mixed-rule',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				rules: [
					{
						// This rule has a segmentMatch clause — entire rule should be dropped
						_id: 'r1',
						variation: 0,
						clauses: [
							{
								_id: 'c1',
								attribute: 'country',
								op: 'in',
								values: ['US'],
								contextKind: 'user',
								negate: false,
							},
							{
								_id: 'c2',
								attribute: '',
								op: 'segmentMatch',
								values: ['vip-segment'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
					},
					{
						// This rule is fully supported — should be preserved
						_id: 'r2',
						variation: 0,
						clauses: [
							{
								_id: 'c3',
								attribute: 'plan',
								op: 'in',
								values: ['enterprise'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'Enterprise users',
					},
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);

	it('is NOT skipped at the flag level (shouldSkipFlag checks entire flag)', () => {
		// shouldSkipFlag sees the segmentMatch and skips the whole flag
		const skip = shouldSkipFlag(flag, ['production']);
		expect(skip.skip).toBe(true);
	});

	it('but buildAllocations gracefully drops only the unsupported rule', () => {
		// buildAllocations is more granular — it drops individual rules
		const allocations = buildAllocations(flag, envMapping);
		// rule 1 dropped (segmentMatch), rule 2 kept + fallthrough
		expect(allocations).toHaveLength(2);
		expect(allocations[0].name).toBe('Enterprise users');
		expect(allocations[0].key).toContain('rule-1');
	});
});

describe('migrate a flag across multiple environments with different configs', () => {
	const flag: LDFlag = {
		name: 'Multi-Env Feature',
		kind: 'boolean',
		key: 'multi-env-feature',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			staging: makeEnv({
				_environmentName: 'Staging',
				on: true,
				// 100% on in staging (no rules, fallthrough to variation 0)
				fallthrough: { variation: 0 },
			}),
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				// 50/50 rollout in production
				fallthrough: {
					rollout: {
						variations: [
							{ variation: 0, weight: 50000 },
							{ variation: 1, weight: 50000 },
						],
					},
				},
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map<string, DatadogEnvironment>([
		['staging', ddStaging],
		['production', ddProd],
	]);
	const result = migrateFlag(flag, envMapping, ['staging', 'production']);

	it('produces separate allocations per environment', () => {
		const allocs = result.request?.allocations ?? [];
		expect(allocs).toHaveLength(2);
	});

	it('staging allocation is 100% on', () => {
		const staging = result.request?.allocations?.[0];
		expect(staging?.environment_id).toBe('dd-staging');
		expect(staging?.variant_weights).toEqual([
			{ variant_key: 'on', value: 100 },
			{ variant_key: 'off', value: 0 },
		]);
	});

	it('production allocation is 50/50 rollout', () => {
		const prod = result.request?.allocations?.[1];
		expect(prod?.environment_id).toBe('dd-prod');
		expect(prod?.variant_weights).toEqual([
			{ variant_key: 'on', value: 50 },
			{ variant_key: 'off', value: 50 },
		]);
	});

	it('enables both environments since both are on', () => {
		expect(result.envsToEnable).toHaveLength(2);
	});
});

describe('migrate a flag where the mapped environment does not exist on the flag', () => {
	const flag: LDFlag = {
		name: 'Sparse Env Flag',
		kind: 'boolean',
		key: 'sparse-env',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			dev: makeEnv({
				_environmentName: 'Dev',
				on: true,
				fallthrough: { variation: 0 },
			}),
			// no "production" environment on this flag
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map<string, DatadogEnvironment>([
		['dev', ddStaging],
		['production', ddProd], // mapped but doesn't exist on flag
	]);
	const result = migrateFlag(flag, envMapping, ['dev', 'production']);

	it('only produces allocations for environments that exist on the flag', () => {
		const allocs = result.request?.allocations ?? [];
		expect(allocs).toHaveLength(1);
		expect(allocs[0].environment_id).toBe('dd-staging');
	});

	it('only enables environments that exist and are on', () => {
		expect(result.envsToEnable).toHaveLength(1);
		expect(result.envsToEnable[0].id).toBe('dd-staging');
	});
});

describe('migrate a flag with empty targets (no values)', () => {
	const flag: LDFlag = {
		name: 'Empty Target Flag',
		kind: 'boolean',
		key: 'empty-target',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				targets: [
					{ values: [], variation: 0, contextKind: 'user' }, // empty — should be skipped
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('skips empty targets and only produces fallthrough', () => {
		expect(result.request?.allocations).toHaveLength(1);
		expect(result.request?.allocations?.[0].key).toContain('fallthrough');
	});
});

describe('migrate a flag with a rule rollout in a rule (not fallthrough)', () => {
	const flag: LDFlag = {
		name: 'Rule Rollout',
		kind: 'boolean',
		key: 'rule-rollout',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				rules: [
					{
						_id: 'r1',
						rollout: {
							variations: [
								{ variation: 0, weight: 10000 },
								{ variation: 1, weight: 90000 },
							],
						},
						clauses: [
							{
								_id: 'c1',
								attribute: 'country',
								op: 'in',
								values: ['US'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'US 10% rollout',
					},
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlag(flag, envMapping, ['production']);

	it('applies rollout weights to the rule allocation', () => {
		const rule = result.request?.allocations?.[0];
		expect(rule?.name).toBe('US 10% rollout');
		expect(rule?.variant_weights).toEqual([
			{ variant_key: 'on', value: 10 },
			{ variant_key: 'off', value: 90 },
		]);
	});

	it('has targeting rules on the rule allocation', () => {
		const rule = result.request?.allocations?.[0];
		expect(rule?.targeting_rules?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US'],
		});
	});
});
