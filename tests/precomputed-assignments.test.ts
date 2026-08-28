import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import {
	DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
	fetchPrecomputedAssignments,
	fetchPrecomputedAssignmentsWithStats,
	parsePrecomputedAssignmentsSubject,
} from '../src/datadog/precomputed-assignments.js';
import type { PrecomputedAssignmentsResponse } from '../src/datadog/types.js';

const RESPONSE: PrecomputedAssignmentsResponse = {
	data: {
		id: 'test_subject',
		type: 'precomputed-assignments',
		attributes: {
			createdAt: '2026-08-27T12:00:00Z',
			environment: { name: 'Production' },
			flags: {
				'checkout-flow': {
					variationValue: true,
					variationType: 'boolean',
					variationKey: 'enabled',
					reason: 'STATIC',
				},
			},
			format: 'PRECOMPUTED',
			obfuscated: false,
		},
	},
};

describe('fetchPrecomputedAssignments', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(axios);
	});

	afterEach(() => {
		mock.restore();
	});

	it('posts the subject to the regional preview CDN', async () => {
		const url =
			'https://preview.ff-cdn.us5.datadoghq.com/precompute-assignments?dd_env=prod%20east';
		mock.onPost(url).reply((config) => {
			expect(config.headers?.['dd-client-token']).toBe('client-token');
			expect(config.headers?.['Content-Type']).toBe('application/vnd.api+json');
			expect(JSON.parse(config.data as string)).toEqual({
				data: {
					type: 'precompute-assignments-request',
					attributes: {
						env: { dd_env: 'prod east' },
						sdk: { name: 'test-suite', version: '1.0.0' },
						subject: DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
					},
				},
			});
			return [200, RESPONSE];
		});

		await expect(
			fetchPrecomputedAssignments({
				clientToken: 'client-token',
				site: 'us5.datadoghq.com',
				ddEnv: 'prod east',
				subject: DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
				sdk: { name: 'test-suite', version: '1.0.0' },
			}),
		).resolves.toEqual(RESPONSE);
	});

	it('includes the HTTP status and response body in API errors', async () => {
		mock.onPost().reply(401, { errors: [{ detail: 'invalid token' }] });

		await expect(
			fetchPrecomputedAssignments({
				clientToken: 'bad-token',
				site: 'datadoghq.com',
				ddEnv: 'prod',
				subject: DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
			}),
		).rejects.toThrow(/HTTP 401.*invalid token/s);
	});

	it('reports HTTP status and request duration', async () => {
		mock.onPost().reply(200, RESPONSE);

		const result = await fetchPrecomputedAssignmentsWithStats({
			clientToken: 'client-token',
			site: 'datadoghq.com',
			ddEnv: 'prod',
			subject: DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
		});

		expect(result.response).toEqual(RESPONSE);
		expect(result.httpStatus).toBe(200);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});

describe('parsePrecomputedAssignmentsSubject', () => {
	it('accepts primitive targeting attributes and trims the key', () => {
		expect(
			parsePrecomputedAssignmentsSubject(
				'{"targeting_key":" user-1 ","targeting_attributes":{"company":"1","admin":true,"age":42,"region":null}}',
			),
		).toEqual({
			targeting_key: 'user-1',
			targeting_attributes: {
				company: '1',
				admin: true,
				age: 42,
				region: null,
			},
		});
	});

	it.each([
		['[]', /JSON object/],
		['{"targeting_key":"","targeting_attributes":{}}', /non-empty string/],
		[
			'{"targeting_key":"user","targeting_attributes":{"nested":{}}}',
			/must be a string, number, boolean, or null/,
		],
	])('rejects invalid subject %s', (raw, message) => {
		expect(() => parsePrecomputedAssignmentsSubject(raw)).toThrow(message);
	});
});
