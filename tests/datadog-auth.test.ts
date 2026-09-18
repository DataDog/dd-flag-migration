import { afterEach, describe, expect, it } from '@jest/globals';
import {
	datadogBaseUrl,
	datadogHeaders,
	getDatadogCredentials,
	getDatadogHttpHeaders,
} from '../src/datadog/auth.js';

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

describe('Datadog HTTP authentication', () => {
	it('uses standard API credentials by default', () => {
		delete process.env.DD_HTTP_HEADERS;
		process.env.DD_API_KEY = 'api-key';
		process.env.DD_APP_KEY = 'app-key';

		expect(getDatadogCredentials()).toEqual({
			apiKey: 'api-key',
			appKey: 'app-key',
		});
		expect(datadogHeaders('api-key', 'app-key')).toEqual({
			'dd-api-key': 'api-key',
			'dd-application-key': 'app-key',
		});
	});

	it('accepts any caller-provided string headers without requiring API keys', () => {
		delete process.env.DD_API_KEY;
		delete process.env.DD_APP_KEY;
		process.env.DD_HTTP_HEADERS = JSON.stringify({
			'X-Custom-Auth': 'secret',
			'X-Organization': 'example',
		});

		expect(getDatadogCredentials()).toEqual({ apiKey: '', appKey: '' });
		expect(getDatadogHttpHeaders()).toEqual({
			'X-Custom-Auth': 'secret',
			'X-Organization': 'example',
		});
	});

	it('lets custom headers override standard headers case-insensitively', () => {
		process.env.DD_HTTP_HEADERS = JSON.stringify({
			'DD-API-KEY': 'custom-api-key',
		});

		expect(datadogHeaders('standard-api-key', 'app-key')).toEqual({
			'DD-API-KEY': 'custom-api-key',
			'dd-application-key': 'app-key',
		});
	});

	it('collapses caller-provided headers that differ only by case', () => {
		process.env.DD_HTTP_HEADERS = JSON.stringify({
			'X-Example': 'first',
			'x-example': 'second',
		});

		expect(datadogHeaders('', '')).toEqual({ 'x-example': 'second' });
	});

	it.each([
		'[]',
		'null',
		'"header"',
		'{"X-Test":1}',
		'{"":"value"}',
	])('rejects invalid header JSON: %s', (value) => {
		process.env.DD_HTTP_HEADERS = value;
		expect(() => getDatadogHttpHeaders()).toThrow(/DD_HTTP_HEADERS/);
	});

	it('uses and normalizes a caller-provided base URL', () => {
		process.env.DD_BASE_URL = 'https://example.test/proxy///';
		expect(datadogBaseUrl('ignored.example')).toBe(
			'https://example.test/proxy',
		);
	});

	it.each([
		'example.test',
		'file:///tmp/socket',
		'https://user:password@example.test',
		'https://example.test?token=secret',
		'https://example.test#fragment',
	])('rejects an invalid caller-provided base URL: %s', (value) => {
		process.env.DD_BASE_URL = value;
		expect(() => datadogBaseUrl()).toThrow(/DD_BASE_URL/);
	});
});
