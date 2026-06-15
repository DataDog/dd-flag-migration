/**
 * Behavioral tests for LaunchDarkly → Datadog flag migration.
 *
 * Each test defines a realistic LD flag JSON, runs the full migration pipeline,
 * and asserts on the Datadog create-flag request that would be produced.
 */
import { describe, expect, it } from '@jest/globals';
import {
	type ConflictResolution,
	classifyConflict,
} from '../../src/launchdarkly/index.js';
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
	DatadogFlagEntry,
	MigrationMetadata,
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
	const allocationsResult = buildAllocations(flag, envMapping);
	if (!Array.isArray(allocationsResult)) {
		return {
			skipped: true,
			skipReason: allocationsResult.flagSkip,
			envsToEnable: [],
		};
	}
	const allocations = allocationsResult;
	const envsToEnable = getEnvsToEnable(flag, envMapping);
	const tags = flag.tags;

	const request: DatadogCreateFlagRequest = {
		key: flag.key,
		name: flag.name,
		value_type: mapFlagType(flag),
		variants,
		allocations: allocations.length > 0 ? allocations : undefined,
		...(tags.length > 0 ? { tags } : {}),
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

describe('migrate a JSON flag whose variation value is an array', () => {
	const flag: LDFlag = {
		name: 'Primer Queries',
		kind: 'multivariate',
		key: 'primer-queries',
		variations: [
			{
				_id: 'v0',
				value: [{ category: 'Health' }, { category: 'Law' }],
				name: 'Production',
			},
			{ _id: 'v1', value: [], name: 'Empty' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};

	const variants = buildVariants(flag);

	it('wraps array values in an object', () => {
		expect(variants[0].value).toBe(
			'{"value":[{"category":"Health"},{"category":"Law"}]}',
		);
	});

	it('wraps empty array values in an object', () => {
		expect(variants[1].value).toBe('{"value":[]}');
	});

	it('uses slugified name as variant key', () => {
		expect(variants.map((v) => v.key)).toEqual(['production', 'empty']);
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

describe('skip a flag with segmentMatch operator (no saved filter lookup)', () => {
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

	it('gives a reason mentioning segment not migrated', () => {
		expect(result.skipReason).toContain('segment not migrated');
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
	// segmentMatch is now handled — with empty lookup it causes a flag-level skip
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
						// This rule has a segmentMatch clause — now causes flag-level skip (no lookup)
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
						// This rule is fully supported
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

	it('is NOT skipped at the flag level by shouldSkipFlag (segmentMatch no longer in UNSUPPORTED_OPS)', () => {
		// shouldSkipFlag no longer skips for segmentMatch
		const skip = shouldSkipFlag(flag, ['production']);
		expect(skip.skip).toBe(false);
	});

	it('buildAllocations returns flagSkip when segment is not in the lookup', () => {
		// No lookup provided — segmentMatch clause cannot be resolved → flag-level skip
		const result = buildAllocations(flag, envMapping);
		expect(Array.isArray(result)).toBe(false);
		expect((result as { flagSkip: string }).flagSkip).toBeDefined();
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

describe('migrate a flag with segmentMatch resolved via an empty segment constant', () => {
	// An empty LD segment (no rules, no included users) matches no contexts.
	// A rule that ANDs against it is unreachable, so the migration should omit
	// that rule allocation and keep the fallthrough.
	const flag: LDFlag = {
		name: 'My Feature Flag',
		kind: 'boolean',
		key: 'my-feature-flag',
		variations: [
			{ _id: 'v0', value: true },
			{ _id: 'v1', value: false },
		],
		defaults: { onVariation: 1, offVariation: 1 },
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
								values: ['empty-segment'],
								contextKind: 'user',
								negate: false,
							},
							{
								_id: 'c2',
								attribute: 'plan',
								op: 'in',
								values: ['enterprise'],
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
		temporary: true,
	};

	const envMapping = new Map([['production', ddProd]]);
	const segmentConstantLookup = new Map([
		['empty-segment:production:false', false],
	]);

	const allocationsResult = buildAllocations(
		flag,
		envMapping,
		new Map(),
		segmentConstantLookup,
	);

	it('resolves the segmentMatch and does not produce a flagSkip', () => {
		expect(Array.isArray(allocationsResult)).toBe(true);
	});

	it('produces only the fallthrough allocation', () => {
		expect(Array.isArray(allocationsResult) && allocationsResult).toHaveLength(
			1,
		);
	});

	it('fallthrough has no targeting rules', () => {
		expect(
			Array.isArray(allocationsResult) && allocationsResult[0].targeting_rules,
		).toBeUndefined();
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

// ─── Conflict-aware Migration Helper ──────────────────────────────────────────

/**
 * Simulate the full migration pipeline for a single flag, including conflict
 * classification against existing Datadog flags.  This mirrors the logic in
 * executeMigration so behavioural tests can assert on the outcome without
 * touching any interactive prompts.
 */
function migrateFlagWithConflicts(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
	selectedEnvs: string[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	conflictResolution?: ConflictResolution,
): {
	action: 'create' | 'sync' | 'skip';
	skipReason?: string;
	request?: DatadogCreateFlagRequest;
	existingFlagId?: string;
	envsToEnable: DatadogEnvironment[];
} {
	const skipResult = shouldSkipFlag(flag, selectedEnvs);
	if (skipResult.skip) {
		return {
			action: 'skip',
			skipReason: skipResult.reason,
			envsToEnable: [],
		};
	}

	const variants = buildVariants(flag);
	const allocationsResult = buildAllocations(flag, envMapping);
	if (!Array.isArray(allocationsResult)) {
		return {
			action: 'skip',
			skipReason: allocationsResult.flagSkip,
			envsToEnable: [],
		};
	}
	const allocations = allocationsResult;
	const envsToEnable = getEnvsToEnable(flag, envMapping);
	const conflict = classifyConflict(datadogFlags, projectKey, flag.key);

	// Cross-project conflict: skip or prefix
	if (conflict.type === 'cross_project') {
		if (!conflictResolution || conflictResolution.action === 'skip') {
			return {
				action: 'skip',
				skipReason:
					'Key conflict: flag key already exists in Datadog from a different LaunchDarkly project',
				envsToEnable: [],
			};
		}
		// prefix: fall through to creation below
	}

	// Same-project or manual: sync onto existing flag
	const existingFlagId =
		conflict.type === 'same_project' || conflict.type === 'manual'
			? conflict.existingFlag?.id
			: undefined;

	if (existingFlagId) {
		return {
			action: 'sync',
			existingFlagId,
			envsToEnable,
		};
	}

	// Create new flag (possibly with prefix)
	const usePrefix =
		conflict.type === 'cross_project' &&
		conflictResolution?.action === 'prefix';
	const ddKey = usePrefix
		? `${conflictResolution.prefix}-${flag.key}`
		: flag.key;

	const metadata: MigrationMetadata = {
		project_key: projectKey,
		flag_key: flag.key,
		...(usePrefix ? { key_prefix: conflictResolution.prefix } : {}),
	};

	const tags = flag.tags;

	const request: DatadogCreateFlagRequest = {
		key: ddKey,
		name: flag.name,
		value_type: mapFlagType(flag),
		variants,
		allocations: allocations.length > 0 ? allocations : undefined,
		migration_metadata: metadata,
		...(tags.length > 0 ? { tags } : {}),
	};

	return {
		action: 'create',
		request,
		envsToEnable,
	};
}

// ─── Conflict Scenarios ───────────────────────────────────────────────────────

const conflictFlag: LDFlag = {
	name: 'Enable Dark Mode',
	kind: 'boolean',
	key: 'enable-dark-mode',
	variations: [
		{ _id: 'v0', value: true, name: 'Enabled' },
		{ _id: 'v1', value: false, name: 'Disabled' },
	],
	defaults: { onVariation: 0, offVariation: 1 },
	environments: {
		production: makeEnv({
			_environmentName: 'Production',
			on: true,
			fallthrough: { variation: 0 },
		}),
	},
	tags: [],
	archived: false,
	deprecated: false,
	temporary: false,
};

const conflictEnvMapping = new Map([['production', ddProd]]);

describe('migrate a flag whose key already exists in Datadog without metadata (manually created)', () => {
	// A DD flag with the same key exists but has no migration_metadata.
	// The tool cannot tell who owns it, so it syncs targeting onto the
	// existing flag rather than creating a duplicate or skipping.
	const datadogFlags: DatadogFlagEntry[] = [
		{
			id: 'dd-uuid-manual',
			key: 'enable-dark-mode',
			// no migration_metadata — manually created
		},
	];

	const result = migrateFlagWithConflicts(
		conflictFlag,
		conflictEnvMapping,
		['production'],
		datadogFlags,
		'mobile',
	);

	it('classifies the conflict as manual', () => {
		const c = classifyConflict(datadogFlags, 'mobile', 'enable-dark-mode');
		expect(c.type).toBe('manual');
		expect(c.existingFlag?.id).toBe('dd-uuid-manual');
	});

	it('syncs targeting onto the existing flag instead of skipping', () => {
		expect(result.action).toBe('sync');
	});

	it('provides the existing flag ID for sync', () => {
		expect(result.existingFlagId).toBe('dd-uuid-manual');
	});

	it('does not produce a create request', () => {
		expect(result.request).toBeUndefined();
	});

	it('enables production because the flag is on', () => {
		expect(result.envsToEnable).toHaveLength(1);
		expect(result.envsToEnable[0].id).toBe('dd-prod');
	});
});

describe('migrate a flag whose key conflicts with a flag from a different LD project', () => {
	// A DD flag with the same key exists AND has migration_metadata from
	// project "web". The LD flag being migrated belongs to project "mobile".
	// This is a real cross-project conflict that requires user resolution.
	const datadogFlags: DatadogFlagEntry[] = [
		{
			id: 'dd-uuid-web',
			key: 'enable-dark-mode',
			migration_metadata: {
				project_key: 'web',
				flag_key: 'enable-dark-mode',
			},
		},
	];

	it('classifies the conflict as cross_project', () => {
		const c = classifyConflict(datadogFlags, 'mobile', 'enable-dark-mode');
		expect(c.type).toBe('cross_project');
		expect(c.existingFlag?.id).toBe('dd-uuid-web');
	});

	describe('when user chooses to skip', () => {
		const result = migrateFlagWithConflicts(
			conflictFlag,
			conflictEnvMapping,
			['production'],
			datadogFlags,
			'mobile',
			{ action: 'skip' },
		);

		it('skips the flag', () => {
			expect(result.action).toBe('skip');
		});

		it('gives a reason mentioning the key conflict', () => {
			expect(result.skipReason).toContain('Key conflict');
		});

		it('does not produce a create request', () => {
			expect(result.request).toBeUndefined();
		});

		it('does not enable any environments', () => {
			expect(result.envsToEnable).toHaveLength(0);
		});
	});

	describe('when user chooses to prefix with "mobile"', () => {
		const result = migrateFlagWithConflicts(
			conflictFlag,
			conflictEnvMapping,
			['production'],
			datadogFlags,
			'mobile',
			{ action: 'prefix', prefix: 'mobile' },
		);

		it('creates a new flag', () => {
			expect(result.action).toBe('create');
		});

		it('prefixes the Datadog flag key', () => {
			expect(result.request?.key).toBe('mobile-enable-dark-mode');
		});

		it('preserves the original flag name', () => {
			expect(result.request?.name).toBe('Enable Dark Mode');
		});

		it('stores the original LD key in migration_metadata.flag_key', () => {
			expect(result.request?.migration_metadata?.flag_key).toBe(
				'enable-dark-mode',
			);
		});

		it('stores the prefix in migration_metadata.key_prefix', () => {
			expect(result.request?.migration_metadata?.key_prefix).toBe('mobile');
		});

		it('stores the project key in migration_metadata.project_key', () => {
			expect(result.request?.migration_metadata?.project_key).toBe('mobile');
		});

		it('enables production because the flag is on', () => {
			expect(result.envsToEnable).toHaveLength(1);
			expect(result.envsToEnable[0].id).toBe('dd-prod');
		});

		it('still produces correct variants and targeting', () => {
			expect(result.request?.variants).toHaveLength(2);
			expect(result.request?.allocations).toHaveLength(1);
			expect(result.request?.allocations?.[0].environment_id).toBe('dd-prod');
		});
	});

	describe('when no conflict resolution is provided (default behavior)', () => {
		const result = migrateFlagWithConflicts(
			conflictFlag,
			conflictEnvMapping,
			['production'],
			datadogFlags,
			'mobile',
			// no conflictResolution — defaults to skip
		);

		it('defaults to skipping the flag', () => {
			expect(result.action).toBe('skip');
		});
	});
});

describe('classifyConflict edge cases', () => {
	it('returns none when no DD flag has the same key', () => {
		const c = classifyConflict([], 'mobile', 'brand-new-flag');
		expect(c.type).toBe('none');
		expect(c.existingFlag).toBeUndefined();
	});

	it('returns same_project when metadata matches the current project', () => {
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'dd-uuid-same',
				key: 'enable-dark-mode',
				migration_metadata: {
					project_key: 'mobile',
					flag_key: 'enable-dark-mode',
				},
			},
		];
		const c = classifyConflict(datadogFlags, 'mobile', 'enable-dark-mode');
		expect(c.type).toBe('same_project');
		expect(c.existingFlag?.id).toBe('dd-uuid-same');
	});

	it('returns same_project even when a prefixed key was used', () => {
		// Previously migrated with prefix — the DD key is different but
		// migration_metadata still matches on (project_key, flag_key).
		const datadogFlags: DatadogFlagEntry[] = [
			{
				id: 'dd-uuid-prefixed',
				key: 'mobile-enable-dark-mode',
				migration_metadata: {
					project_key: 'mobile',
					flag_key: 'enable-dark-mode',
					key_prefix: 'mobile',
				},
			},
		];
		const c = classifyConflict(datadogFlags, 'mobile', 'enable-dark-mode');
		expect(c.type).toBe('same_project');
		expect(c.existingFlag?.id).toBe('dd-uuid-prefixed');
	});
});

describe('migrate a cross-project prefixed flag that also has team tags', () => {
	// A flag whose key conflicts with another LD project. The user chose to
	// prefix with "mobile". The flag also has a team maintainer. Both the
	// prefixed key and team tags should appear correctly in the request.
	const flag: LDFlag = {
		name: 'Feature Toggle',
		kind: 'boolean',
		key: 'feature-toggle',
		variations: [
			{ _id: 'v0', value: true, name: 'on' },
			{ _id: 'v1', value: false, name: 'off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				fallthrough: { variation: 0 },
			}),
		},
		tags: ['mobile-app'],
		archived: false,
		deprecated: false,
		temporary: false,
		maintainerTeamKey: 'mobile-eng',
		_maintainerTeam: { key: 'mobile-eng', name: 'Mobile Engineering' },
	};

	// A DD flag from a different project already has this key
	const datadogFlags: DatadogFlagEntry[] = [
		{
			id: 'dd-uuid-web',
			key: 'feature-toggle',
			migration_metadata: {
				project_key: 'web',
				flag_key: 'feature-toggle',
			},
		},
	];

	const envMapping = new Map([['production', ddProd]]);
	const result = migrateFlagWithConflicts(
		flag,
		envMapping,
		['production'],
		datadogFlags,
		'mobile',
		{ action: 'prefix', prefix: 'mobile' },
	);

	it('creates a new flag with prefixed key', () => {
		expect(result.action).toBe('create');
		expect(result.request?.key).toBe('mobile-feature-toggle');
	});

	it('includes LD source tags', () => {
		expect(result.request?.tags).toContain('mobile-app');
	});

	it('has prefixed key and migration metadata in the same request', () => {
		expect(result.request?.key).toBe('mobile-feature-toggle');
		expect(result.request?.tags).toEqual(['mobile-app']);
		expect(result.request?.migration_metadata?.key_prefix).toBe('mobile');
	});
});

describe('migrate a realistic flag with targets, rules, LD tags, and a team maintainer', () => {
	// End-to-end: a flag with real-world complexity — targeting rules, rollout,
	// LD source tags, and a team maintainer. Verifies that team tagging
	// integrates cleanly with the full targeting pipeline.
	const flag: LDFlag = {
		name: 'Checkout V2',
		kind: 'boolean',
		key: 'checkout-v2',
		variations: [
			{ _id: 'v0', value: true, name: 'Enabled' },
			{ _id: 'v1', value: false, name: 'Disabled' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			staging: makeEnv({
				_environmentName: 'Staging',
				on: true,
				fallthrough: { variation: 0 },
			}),
			production: makeEnv({
				_environmentName: 'Production',
				on: true,
				targets: [
					{
						values: ['user-qa-1', 'user-qa-2'],
						variation: 0,
						contextKind: 'user',
					},
				],
				rules: [
					{
						_id: 'r1',
						rollout: {
							variations: [
								{ variation: 0, weight: 20000 },
								{ variation: 1, weight: 80000 },
							],
						},
						clauses: [
							{
								_id: 'c1',
								attribute: 'country',
								op: 'in',
								values: ['US', 'CA'],
								contextKind: 'user',
								negate: false,
							},
						],
						trackEvents: false,
						description: 'NA 20% rollout',
					},
				],
				fallthrough: { variation: 1 },
			}),
		},
		tags: ['checkout', 'q3-launch'],
		archived: false,
		deprecated: false,
		temporary: false,
		maintainerTeamKey: 'payments',
		_maintainerTeam: { key: 'payments', name: 'Payments' },
	};

	const envMapping = new Map<string, DatadogEnvironment>([
		['staging', ddStaging],
		['production', ddProd],
	]);
	const result = migrateFlag(flag, envMapping, ['staging', 'production']);

	it('produces the correct number of allocations (1 staging ft + 1 target + 1 rule + 1 prod ft)', () => {
		expect(result.request?.allocations).toHaveLength(4);
	});

	it('includes both LD source tags', () => {
		expect(result.request?.tags).toContain('checkout');
		expect(result.request?.tags).toContain('q3-launch');
	});

	it('produces the full tag list from LD source tags', () => {
		expect(result.request?.tags).toEqual(['checkout', 'q3-launch']);
	});

	it('has correct targeting on the production rule allocation', () => {
		// staging fallthrough + prod target + prod rule + prod fallthrough
		const prodRule = result.request?.allocations?.[2];
		expect(prodRule?.name).toBe('NA 20% rollout');
		expect(prodRule?.targeting_rules?.[0].conditions[0]).toEqual({
			operator: 'ONE_OF',
			attribute: 'country',
			value: ['US', 'CA'],
		});
		expect(prodRule?.variant_weights).toEqual([
			{ variant_key: 'enabled', value: 20 },
			{ variant_key: 'disabled', value: 80 },
		]);
	});

	it('enables both environments since both are on', () => {
		expect(result.envsToEnable).toHaveLength(2);
	});
});
