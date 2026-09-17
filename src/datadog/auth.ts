import { requireEnvVars } from '../helpers/env.js';

export const DATADOG_HTTP_HEADERS_ENV = 'DD_HTTP_HEADERS';
export const DATADOG_BASE_URL_ENV = 'DD_BASE_URL';

export type DatadogCredentials = {
	apiKey: string;
	appKey: string;
};

/**
 * Read optional Datadog request headers from the environment. Keeping the
 * complete object in an environment variable means header names and values
 * (which may be credentials) are never persisted in the tool's config file.
 */
export function getDatadogHttpHeaders(): Record<string, string> {
	const raw = process.env[DATADOG_HTTP_HEADERS_ENV]?.trim();
	if (!raw) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${DATADOG_HTTP_HEADERS_ENV} must be a JSON object`);
	}

	if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
		throw new Error(`${DATADOG_HTTP_HEADERS_ENV} must be a JSON object`);
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (name.trim().length === 0 || typeof value !== 'string') {
			throw new Error(
				`${DATADOG_HTTP_HEADERS_ENV} must contain only non-empty header names with string values`,
			);
		}
		headers[name] = value;
	}
	return headers;
}

/** Use API/application keys by default, or allow custom headers to substitute. */
export function getDatadogCredentials(): DatadogCredentials {
	if (Object.keys(getDatadogHttpHeaders()).length > 0) {
		return {
			apiKey: process.env.DD_API_KEY?.trim() ?? '',
			appKey: process.env.DD_APP_KEY?.trim() ?? '',
		};
	}

	const env = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	return { apiKey: env.DD_API_KEY, appKey: env.DD_APP_KEY };
}

export function datadogHeaders(
	apiKey: string,
	appKey: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		...(apiKey ? { 'dd-api-key': apiKey } : {}),
		...(appKey ? { 'dd-application-key': appKey } : {}),
	};

	// Header names are case-insensitive. Remove an existing spelling before
	// applying each caller-provided header so custom values always take
	// precedence without sending duplicate logical headers.
	for (const [customName, customValue] of Object.entries(
		getDatadogHttpHeaders(),
	)) {
		const existingName = Object.keys(headers).find(
			(name) => name.toLowerCase() === customName.toLowerCase(),
		);
		if (existingName !== undefined) delete headers[existingName];
		headers[customName] = customValue;
	}

	return headers;
}

export function datadogBaseUrl(site = 'datadoghq.com'): string {
	const customBaseUrl = process.env[DATADOG_BASE_URL_ENV]?.trim();
	if (!customBaseUrl) return `https://api.${site}`;

	let url: URL;
	try {
		url = new URL(customBaseUrl);
	} catch {
		throw new Error(`${DATADOG_BASE_URL_ENV} must be an absolute HTTP(S) URL`);
	}
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:') ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(`${DATADOG_BASE_URL_ENV} must be an absolute HTTP(S) URL`);
	}

	return customBaseUrl.replace(/\/+$/, '');
}

export function datadogSensitiveHeaderNames(): Set<string> {
	return new Set([
		'dd-api-key',
		'dd-application-key',
		...Object.keys(getDatadogHttpHeaders()).map((name) => name.toLowerCase()),
	]);
}
