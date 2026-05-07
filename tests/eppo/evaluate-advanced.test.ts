import type * as EppoSdk from '@eppo/node-server-sdk';
import { describe, expect, it, jest } from '@jest/globals';
import { evaluateEppoFlagAdvanced } from '../../src/eppo/evaluate.js';
import type { DDFlagValue } from '../../src/types.js';

// ─── Mock EppoClient ──────────────────────────────────────────────────────────

type EppoClient = ReturnType<typeof EppoSdk.getInstance>;

type DetailReturn<V> = {
	variation: V;
	evaluationDetails: { flagEvaluationCode: string };
};

interface MockOverrides {
	boolean?: DetailReturn<boolean | null>;
	integer?: DetailReturn<number | null>;
	numeric?: DetailReturn<number | null>;
	json?: DetailReturn<unknown>;
	string?: DetailReturn<string | null>;
}

function makeClient(o: MockOverrides): EppoClient {
	return {
		getBooleanAssignmentDetails: jest.fn(
			() =>
				o.boolean ?? {
					variation: false,
					evaluationDetails: { flagEvaluationCode: 'MATCH' },
				},
		),
		getIntegerAssignmentDetails: jest.fn(
			() =>
				o.integer ?? {
					variation: 0,
					evaluationDetails: { flagEvaluationCode: 'MATCH' },
				},
		),
		getNumericAssignmentDetails: jest.fn(
			() =>
				o.numeric ?? {
					variation: 0,
					evaluationDetails: { flagEvaluationCode: 'MATCH' },
				},
		),
		getJSONAssignmentDetails: jest.fn(
			() =>
				o.json ?? {
					variation: {},
					evaluationDetails: { flagEvaluationCode: 'MATCH' },
				},
		),
		getStringAssignmentDetails: jest.fn(
			() =>
				o.string ?? {
					variation: 'control',
					evaluationDetails: { flagEvaluationCode: 'MATCH' },
				},
		),
	} as unknown as EppoClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('evaluateEppoFlagAdvanced', () => {
	it('returns providerStatus="not-found" when Eppo reports FLAG_UNRECOGNIZED_OR_DISABLED', async () => {
		const client = makeClient({
			string: {
				variation: null,
				evaluationDetails: {
					flagEvaluationCode: 'FLAG_UNRECOGNIZED_OR_DISABLED',
				},
			},
		});

		const result = await evaluateEppoFlagAdvanced(
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

	it('dispatches to BOOLEAN handler and stringifies a boolean variation', async () => {
		const client = makeClient({
			boolean: {
				variation: true,
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		const result = await evaluateEppoFlagAdvanced(
			'flag',
			'BOOLEAN',
			'user-1',
			{},
			client,
			{ flag: { variationValue: true, variationType: 'BOOLEAN' } },
			new Set(['flag']),
		);

		expect(result.providerStatus).toBe('found');
		expect(result.providerResult).toBe('true');
		expect(result.ddResult).toBe('true');
		expect(result.ddStatus).toBe('assigned');
		expect(client.getBooleanAssignmentDetails).toHaveBeenCalled();
	});

	it('dispatches to INTEGER handler', async () => {
		const client = makeClient({
			integer: {
				variation: 7,
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		const result = await evaluateEppoFlagAdvanced(
			'flag',
			'INTEGER',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(result.providerResult).toBe('7');
		expect(client.getIntegerAssignmentDetails).toHaveBeenCalled();
		expect(client.getBooleanAssignmentDetails).not.toHaveBeenCalled();
	});

	it('dispatches to NUMERIC handler', async () => {
		const client = makeClient({
			numeric: {
				variation: 3.14,
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		const result = await evaluateEppoFlagAdvanced(
			'flag',
			'NUMERIC',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(result.providerResult).toBe('3.14');
		expect(client.getNumericAssignmentDetails).toHaveBeenCalled();
	});

	it('dispatches to JSON handler and canonicalises keys on both sides', async () => {
		const client = makeClient({
			json: {
				variation: { b: 2, a: 1 },
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		const ddFlags: Record<string, DDFlagValue> = {
			flag: {
				variationValue: { a: 1, b: 2 },
				variationType: 'JSON',
			},
		};

		const result = await evaluateEppoFlagAdvanced(
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
	});

	it('falls back to STRING handler for unknown vtype values', async () => {
		const client = makeClient({
			string: {
				variation: 'on',
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		const result = await evaluateEppoFlagAdvanced(
			'flag',
			'WHATEVER',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(result.providerResult).toBe('on');
		expect(client.getStringAssignmentDetails).toHaveBeenCalled();
	});

	it('uppercases lowercase vtype before dispatch', async () => {
		const client = makeClient({
			boolean: {
				variation: true,
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		await evaluateEppoFlagAdvanced(
			'flag',
			'boolean',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(client.getBooleanAssignmentDetails).toHaveBeenCalled();
	});

	it('strips null attributes before passing them to the SDK', async () => {
		const client = makeClient({
			string: {
				variation: 'on',
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		await evaluateEppoFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{ country: 'US', plan: null, beta: true },
			client,
			{},
			new Set(['flag']),
		);

		const stringMock =
			client.getStringAssignmentDetails as unknown as jest.Mock;
		const passedAttrs = stringMock.mock.calls[0][2];
		expect(passedAttrs).toEqual({ country: 'US', beta: true });
	});

	it('reports providerStatus="error" when the SDK throws', async () => {
		const client = {
			getStringAssignmentDetails: jest.fn(() => {
				throw new Error('boom');
			}),
		} as unknown as EppoClient;

		const result = await evaluateEppoFlagAdvanced(
			'flag',
			'STRING',
			'user-1',
			{},
			client,
			{},
			new Set(['flag']),
		);

		expect(result.providerStatus).toBe('error');
		expect(result.error).toBe('boom');
		expect(result.providerResult).toBe('ERROR');
		expect(result.ddResult).toBe('ERROR');
	});

	it('reports ddStatus="not-assigned" when flag exists in DD but no value for the context', async () => {
		const client = makeClient({
			string: {
				variation: 'on',
				evaluationDetails: { flagEvaluationCode: 'MATCH' },
			},
		});

		const result = await evaluateEppoFlagAdvanced(
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
