import { describe, expect, it, jest } from '@jest/globals';
import {
	buildLDContext,
	evaluateLDFlagAdvanced,
	generateLDTestCases,
	type LDClient,
} from '../../src/launchdarkly/evaluate.js';
import type { LDFlag } from '../../src/launchdarkly/types.js';
import type { DDFlagValue } from '../../src/types.js';

// ─── Mock LDClient ────────────────────────────────────────────────────────────

type VariationDetailReturn = {
	value: unknown;
	variationIndex: number | null;
	reason: { kind: string; errorKind?: string };
};

function makeClient(
	impl: (
		flagKey: string,
		context: unknown,
		defaultValue: unknown,
	) => VariationDetailReturn | Promise<VariationDetailReturn>,
): LDClient {
	return {
		variationDetail: jest.fn(impl),
	} as unknown as LDClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('evaluateLDFlagAdvanced', () => {
	it('returns providerStatus="not-found" and empty results when LD reports FLAG_NOT_FOUND', async () => {
		const client = makeClient(() => ({
			value: '',
			variationIndex: null,
			reason: { kind: 'ERROR', errorKind: 'FLAG_NOT_FOUND' },
		}));

		const result = await evaluateLDFlagAdvanced(
			'missing-flag',
			'STRING',
			'user-1',
			{},
			client,
			{},
			new Set(),
		);

		expect(result.providerStatus).toBe('not-found');
		expect(result.providerResult).toBe('');
		expect(result.ddResult).toBe('');
		expect(result.ddStatus).toBe('not-in-dd');
	});

	it('passes a boolean default when vtype="BOOLEAN"', async () => {
		const variationDetail = jest.fn<
			(k: string, c: unknown, d: unknown) => Promise<VariationDetailReturn>
		>(async () => ({
			value: true,
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));
		const client = { variationDetail } as unknown as LDClient;

		await evaluateLDFlagAdvanced(
			'flag',
			'BOOLEAN',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(variationDetail).toHaveBeenCalledTimes(1);
		const callArgs = variationDetail.mock.calls[0];
		expect(callArgs[2]).toBe(false);
	});

	it('passes a numeric default when vtype="NUMERIC"', async () => {
		const variationDetail = jest.fn<
			(k: string, c: unknown, d: unknown) => Promise<VariationDetailReturn>
		>(async () => ({
			value: 42,
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));
		const client = { variationDetail } as unknown as LDClient;

		await evaluateLDFlagAdvanced(
			'flag',
			'NUMERIC',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(variationDetail.mock.calls[0][2]).toBe(0);
	});

	it('passes an empty-object default when vtype="JSON"', async () => {
		const variationDetail = jest.fn<
			(k: string, c: unknown, d: unknown) => Promise<VariationDetailReturn>
		>(async () => ({
			value: { a: 1 },
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));
		const client = { variationDetail } as unknown as LDClient;

		await evaluateLDFlagAdvanced(
			'flag',
			'JSON',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(variationDetail.mock.calls[0][2]).toEqual({});
	});

	it('stringifies a boolean variation value', async () => {
		const client = makeClient(async () => ({
			value: false,
			variationIndex: 1,
			reason: { kind: 'FALLTHROUGH' },
		}));

		const result = await evaluateLDFlagAdvanced(
			'flag',
			'BOOLEAN',
			'user-1',
			{},
			client,
			{ flag: { variationValue: false, variationType: 'BOOLEAN' } },
			new Set(['flag']),
		);

		expect(result.providerStatus).toBe('found');
		expect(result.providerResult).toBe('false');
		expect(result.ddResult).toBe('false');
		expect(result.ddStatus).toBe('assigned');
	});

	it('canonicalises JSON values (sorts keys) on both sides for comparison', async () => {
		const client = makeClient(async () => ({
			value: { b: 2, a: 1 },
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));

		const ddFlags: Record<string, DDFlagValue> = {
			flag: {
				variationValue: { a: 1, b: 2 },
				variationType: 'JSON',
			},
		};

		const result = await evaluateLDFlagAdvanced(
			'flag',
			'JSON',
			'user-1',
			{},
			client,
			ddFlags,
			new Set(['flag']),
		);

		expect(result.providerResult).toBe('{"a":1,"b":2}');
		expect(result.ddResult).toBe('{"a":1,"b":2}');
		expect(result.providerResult).toBe(result.ddResult);
	});

	it('detects JSON values even when vtype is not "JSON"', async () => {
		const client = makeClient(async () => ({
			value: { foo: 'bar' },
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));

		const result = await evaluateLDFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{},
			client,
			{},
			new Set(),
		);

		expect(result.providerResult).toBe('{"foo":"bar"}');
	});

	it('reports providerStatus="error" with the SDK error message on rejection', async () => {
		const client = makeClient(async () => {
			throw new Error('connection refused');
		});

		const result = await evaluateLDFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(result.providerStatus).toBe('error');
		expect(result.error).toBe('connection refused');
		expect(result.providerResult).toBe('ERROR');
		expect(result.ddResult).toBe('ERROR');
	});

	it('builds an LD context with kind="user" and skips the reserved "key" attribute', async () => {
		const variationDetail = jest.fn<
			(k: string, c: unknown, d: unknown) => Promise<VariationDetailReturn>
		>(async () => ({
			value: 'on',
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));
		const client = { variationDetail } as unknown as LDClient;

		await evaluateLDFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{ country: 'US', key: 'should-be-dropped', plan: 'pro' },
			client,
			{},
			new Set(['flag']),
		);

		const ctx = variationDetail.mock.calls[0][1] as Record<string, unknown>;
		expect(ctx.kind).toBe('user');
		expect(ctx.key).toBe('user-1');
		expect(ctx.country).toBe('US');
		expect(ctx.plan).toBe('pro');
	});

	it('reports ddStatus="not-assigned" when the flag exists in DD but no value was returned for the context', async () => {
		const client = makeClient(async () => ({
			value: 'on',
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));

		const result = await evaluateLDFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(result.ddStatus).toBe('not-assigned');
		expect(result.providerStatus).toBe('found');
	});
});

describe('buildLDContext', () => {
	it('returns kind="user" context with no contextAttributes', () => {
		const ctx = buildLDContext('user-1', { country: 'US' }) as Record<
			string,
			unknown
		>;
		expect(ctx.kind).toBe('user');
		expect(ctx.key).toBe('user-1');
		expect(ctx.country).toBe('US');
	});

	it('returns kind="user" context when contextAttributes is empty', () => {
		const ctx = buildLDContext('user-1', { country: 'US' }, {}) as Record<
			string,
			unknown
		>;
		expect(ctx.kind).toBe('user');
		expect(ctx.key).toBe('user-1');
	});

	it('returns kind="multi" context when contextAttributes has entries', () => {
		const ctx = buildLDContext(
			'user-1',
			{ plan: 'pro' },
			{ ld_application: { versionName: '4.9.0' } },
		) as Record<string, unknown>;
		expect(ctx.kind).toBe('multi');
		expect((ctx.user as Record<string, unknown>).key).toBe('user-1');
		expect((ctx.user as Record<string, unknown>).plan).toBe('pro');
		expect((ctx.ld_application as Record<string, unknown>).versionName).toBe(
			'4.9.0',
		);
		expect((ctx.ld_application as Record<string, unknown>).key).toBe(
			'synthetic',
		);
	});

	it('uses supplied key for non-user context instead of "synthetic"', () => {
		const ctx = buildLDContext(
			'user-1',
			{},
			{ org: { key: 'org-abc', plan: 'enterprise' } },
		) as Record<string, unknown>;
		expect((ctx.org as Record<string, unknown>).key).toBe('org-abc');
		expect((ctx.org as Record<string, unknown>).plan).toBe('enterprise');
	});

	it('falls back to "synthetic" when key is null', () => {
		const ctx = buildLDContext('user-1', {}, { org: { key: null } }) as Record<
			string,
			unknown
		>;
		expect((ctx.org as Record<string, unknown>).key).toBe('synthetic');
	});

	it('stringifies a numeric context key instead of falling back to "synthetic"', () => {
		const ctx = buildLDContext(
			'user-1',
			{},
			{ org: { key: 42 as unknown as string } },
		) as Record<string, unknown>;
		expect((ctx.org as Record<string, unknown>).key).toBe('42');
	});

	it('filters null values, "key", and "kind" from user context', () => {
		const ctx = buildLDContext('user-1', {
			plan: 'pro',
			key: 'should-be-dropped',
			kind: 'should-be-dropped',
			empty: null,
		}) as Record<string, unknown>;
		expect(ctx.kind).toBe('user');
		expect(ctx.key).toBe('user-1');
		expect(ctx.plan).toBe('pro');
		expect(ctx.empty).toBeUndefined();
	});

	it('expands slash-prefixed user attribute references into nested LD attributes', () => {
		const ctx = buildLDContext('user-1', {
			'/os/name': 'Android',
		}) as Record<string, unknown>;
		const os = ctx.os as Record<string, unknown>;

		expect(ctx.kind).toBe('user');
		expect(os.name).toBe('Android');
		expect(ctx['/os/name']).toBeUndefined();
	});

	it('filters non-user-context dotted keys from user subcontext (heuristic path, no ldUserAttributes)', () => {
		const ctx = buildLDContext(
			'user-1',
			{ 'ld_application.versionName': '4.9.0', 'app.version': '2.0' },
			{ ld_application: { versionName: '4.9.0' } },
		) as Record<string, unknown>;
		expect(ctx.kind).toBe('multi');
		const user = ctx.user as Record<string, unknown>;
		expect(user['ld_application.versionName']).toBeUndefined();
		expect(user['app.version']).toBe('2.0');
	});

	it('expands slash-prefixed non-user attribute references into nested LD attributes', () => {
		const ctx = buildLDContext(
			'user-1',
			{ 'ld_device./os/name': 'Android' },
			{ ld_device: { '/os/name': 'Android' } },
		) as Record<string, unknown>;
		const user = ctx.user as Record<string, unknown>;
		const device = ctx.ld_device as Record<string, unknown>;
		const os = device.os as Record<string, unknown>;

		expect(ctx.kind).toBe('multi');
		expect(user['ld_device./os/name']).toBeUndefined();
		expect(os.name).toBe('Android');
		expect(device['/os/name']).toBeUndefined();
	});

	it('uses ldUserAttributes for user subcontext, preserving dotted user attr even when prefix matches a context kind', () => {
		const ctx = buildLDContext(
			'user-1',
			{ 'org.plan': 'pro', 'org.plan_dd': 'enterprise' },
			{ org: { plan: 'enterprise' } },
			{ 'org.plan': 'pro' },
		) as Record<string, unknown>;
		expect(ctx.kind).toBe('multi');
		const user = ctx.user as Record<string, unknown>;
		expect(user['org.plan']).toBe('pro');
		expect((ctx.org as Record<string, unknown>).plan).toBe('enterprise');
	});

	it('filters null values from non-user context attributes', () => {
		const ctx = buildLDContext(
			'user-1',
			{},
			{ org: { plan: 'enterprise', tier: null } },
		) as Record<string, unknown>;
		const org = ctx.org as Record<string, unknown>;
		expect(org.plan).toBe('enterprise');
		expect(org.tier).toBeUndefined();
	});

	it('unescapes ~1 at the start of a path component (indexOf === 0 edge case)', () => {
		// "/~1foo" → component "~1foo" → indexOf('~') = 0 (falsy before fix) → must unescape to "/foo"
		const ctx = buildLDContext('user-1', { '/~1foo': 'bar' }) as Record<
			string,
			unknown
		>;
		expect(ctx['/foo']).toBe('bar');
		expect(ctx['~1foo']).toBeUndefined();
	});

	it('unescapes ~0 at the start of a path component (indexOf === 0 edge case)', () => {
		// "/~0foo" → component "~0foo" → indexOf('~') = 0 (falsy before fix) → must unescape to "~foo"
		const ctx = buildLDContext('user-1', { '/~0foo': 'baz' }) as Record<
			string,
			unknown
		>;
		expect(ctx['~foo']).toBe('baz');
		expect(ctx['~0foo']).toBeUndefined();
	});

	it('rejects attribute references with invalid ~| tilde sequence (character class fix)', () => {
		// "/path~|sub" — the old [^0|^1] treated | as in-class, so ~| was not rejected
		// The fixed [^01] correctly identifies ~| as invalid → nothing set in context
		const ctx = buildLDContext('user-1', { '/path~|sub': 'val' }) as Record<
			string,
			unknown
		>;
		expect(ctx['path~|sub']).toBeUndefined();
		expect(ctx.path).toBeUndefined();
	});

	it('rejects attribute references with invalid ~^ tilde sequence (character class fix)', () => {
		// The old [^0|^1] treated ^ as in-class, so ~^ was not rejected
		const ctx = buildLDContext('user-1', { '/path~^sub': 'val' }) as Record<
			string,
			unknown
		>;
		expect(ctx['path~^sub']).toBeUndefined();
		expect(ctx.path).toBeUndefined();
	});
});

describe('evaluateLDFlagAdvanced with contextAttributes', () => {
	it('builds kind="multi" context when contextAttributes is provided', async () => {
		const variationDetail = jest.fn<
			(k: string, c: unknown, d: unknown) => Promise<VariationDetailReturn>
		>(async () => ({
			value: 'on',
			variationIndex: 0,
			reason: { kind: 'FALLTHROUGH' },
		}));
		const client = { variationDetail } as unknown as LDClient;

		await evaluateLDFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{
				plan: 'pro',
				'ld_application.versionName': '4.9.0',
				'app.version': '2.0',
			},
			client,
			{},
			new Set(),
			undefined,
			{ ld_application: { versionName: '4.9.0' } },
		);

		const ctx = variationDetail.mock.calls[0][1] as Record<string, unknown>;
		expect(ctx.kind).toBe('multi');
		const user = ctx.user as Record<string, unknown>;
		expect(user.key).toBe('user-1');
		expect(user.plan).toBe('pro');
		expect(user['ld_application.versionName']).toBeUndefined();
		expect(user['app.version']).toBe('2.0');
		expect((ctx.ld_application as Record<string, unknown>).versionName).toBe(
			'4.9.0',
		);
		expect((ctx.ld_application as Record<string, unknown>).key).toBe(
			'synthetic',
		);
	});
});

describe('generateLDTestCases with non-user contextKind', () => {
	const makeFlag = (contextKind: string): LDFlag =>
		({
			name: 'App Version Flag',
			kind: 'boolean',
			key: 'app-version-flag',
			variations: [
				{ _id: 'v0', value: true, name: 'on' },
				{ _id: 'v1', value: false, name: 'off' },
			],
			defaults: { onVariation: 0, offVariation: 1 },
			environments: {
				production: {
					_environmentName: 'Production',
					on: true,
					archived: false,
					targets: [],
					contextTargets: [],
					rules: [
						{
							_id: 'r1',
							variation: 1,
							clauses: [
								{
									_id: 'c1',
									attribute: 'versionName',
									op: 'in',
									values: ['4.0.0'],
									contextKind,
									negate: false,
								},
							],
							trackEvents: false,
						},
					],
					fallthrough: { variation: 0 },
					offVariation: 1,
					prerequisites: [],
				},
			},
			tags: [],
			archived: false,
			deprecated: false,
			temporary: false,
		}) as LDFlag;

	const makeFlagWithContextTarget = (): LDFlag =>
		({
			name: 'Org Target Flag',
			kind: 'boolean',
			key: 'org-target-flag',
			variations: [
				{ _id: 'v0', value: true, name: 'on' },
				{ _id: 'v1', value: false, name: 'off' },
			],
			defaults: { onVariation: 0, offVariation: 1 },
			environments: {
				production: {
					_environmentName: 'Production',
					on: true,
					archived: false,
					targets: [],
					contextTargets: [
						{ values: ['org-abc'], variation: 0, contextKind: 'org' },
					],
					rules: [],
					fallthrough: { variation: 1 },
					offVariation: 1,
					prerequisites: [],
				},
			},
			tags: [],
			archived: false,
			deprecated: false,
			temporary: false,
		}) as LDFlag;

	it('does NOT set contextAttributes for user-context clauses', () => {
		const testCases = generateLDTestCases(makeFlag('user'), 'production');
		for (const tc of testCases) {
			expect(tc.contextAttributes).toBeUndefined();
		}
	});

	it('sets contextAttributes for non-user contextKind', () => {
		const testCases = generateLDTestCases(
			makeFlag('ld_application'),
			'production',
		);
		const caseWithAttr = testCases.find(
			(tc) => 'ld_application.versionName' in tc.attributes,
		);
		expect(caseWithAttr).toBeDefined();
		expect(
			caseWithAttr?.contextAttributes?.ld_application?.versionName,
		).toBeDefined();
	});

	it('stores non-user attr under full dotted name in flat attributes', () => {
		const testCases = generateLDTestCases(
			makeFlag('ld_application'),
			'production',
		);
		const caseWithAttr = testCases.find(
			(tc) => 'ld_application.versionName' in tc.attributes,
		);
		expect(
			caseWithAttr?.attributes['ld_application.versionName'],
		).toBeDefined();
		expect(caseWithAttr?.attributes.versionName).toBeUndefined();
	});

	it('does not set contextAttributes on the "no attributes" base case', () => {
		const testCases = generateLDTestCases(
			makeFlag('ld_application'),
			'production',
		);
		const baseCase = testCases.find((tc) => tc.label === 'no attributes');
		expect(baseCase).toBeDefined();
		expect(baseCase?.contextAttributes).toBeUndefined();
	});

	it('generates a test case from contextTargets with contextAttributes and dotted flat key', () => {
		const testCases = generateLDTestCases(
			makeFlagWithContextTarget(),
			'production',
		);
		const orgCase = testCases.find((tc) => tc.label === 'org key=org-abc');
		expect(orgCase).toBeDefined();
		expect(orgCase?.contextAttributes?.org?.key).toBe('org-abc');
		expect(orgCase?.attributes['org.key']).toBe('org-abc');
		expect(orgCase?.subjectIdOverride).toBeUndefined();
	});

	it('populates ldUserAttributes with user-context clause attrs (bare names)', () => {
		const testCases = generateLDTestCases(makeFlag('user'), 'production');
		const caseWithAttr = testCases.find((tc) => 'versionName' in tc.attributes);
		expect(caseWithAttr?.ldUserAttributes?.versionName).toBeDefined();
	});

	it('does not include non-user attrs in ldUserAttributes', () => {
		const testCases = generateLDTestCases(
			makeFlag('ld_application'),
			'production',
		);
		const caseWithAttr = testCases.find(
			(tc) => 'ld_application.versionName' in tc.attributes,
		);
		expect(caseWithAttr?.ldUserAttributes).toBeUndefined();
	});
});
