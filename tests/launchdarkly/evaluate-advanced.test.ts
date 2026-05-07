import { describe, expect, it, jest } from '@jest/globals';
import type { LDClient } from '../../src/launchdarkly/evaluate.js';
import { evaluateLDFlagAdvanced } from '../../src/launchdarkly/evaluate.js';
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
