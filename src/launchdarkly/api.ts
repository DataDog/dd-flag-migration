import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import type {
	LDCustomRole,
	LDEnvironment,
	LDFlag,
	LDSegment,
	LDTeamWithRoles,
} from './types.js';

const LD_BASE_URL = 'https://app.launchdarkly.com';

function ldHeaders(apiKey: string) {
	return { Authorization: apiKey };
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

const ROUTE_REMAINING_THRESHOLD = 5;
const TOKEN_REMAINING_THRESHOLD = 50;
const GLOBAL_REMAINING_THRESHOLD = 50;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read rate-limit headers from a LaunchDarkly API response and sleep if
 * we're approaching the per-route, per-token, or global limit.
 */
async function respectRateLimit(response: AxiosResponse): Promise<void> {
	const headers = response.headers;

	const routeRemaining = Number(headers['x-ratelimit-route-remaining']);
	const tokenRemaining = Number(headers['x-ratelimit-auth-token-remaining']);
	const globalRemaining = Number(headers['x-ratelimit-global-remaining']);
	const routeReset = Number(headers['x-ratelimit-reset']);
	const tokenReset = Number(headers['x-ratelimit-auth-token-reset']);
	const globalReset = Number(headers['x-ratelimit-global-reset']);

	let waitUntil: number | null = null;

	if (
		!Number.isNaN(routeRemaining) &&
		routeRemaining <= ROUTE_REMAINING_THRESHOLD &&
		!Number.isNaN(routeReset)
	) {
		waitUntil = routeReset;
	}

	if (
		!Number.isNaN(tokenRemaining) &&
		tokenRemaining <= TOKEN_REMAINING_THRESHOLD &&
		!Number.isNaN(tokenReset)
	) {
		const candidate = tokenReset;
		if (waitUntil === null || candidate > waitUntil) {
			waitUntil = candidate;
		}
	}

	if (
		!Number.isNaN(globalRemaining) &&
		globalRemaining <= GLOBAL_REMAINING_THRESHOLD &&
		!Number.isNaN(globalReset)
	) {
		const candidate = globalReset;
		if (waitUntil === null || candidate > waitUntil) {
			waitUntil = candidate;
		}
	}

	if (waitUntil !== null) {
		const delayMs = Math.max(0, waitUntil - Date.now()) + 500; // 500ms buffer for clock skew
		if (delayMs > 0) {
			await sleep(delayMs);
		}
	}
}

/**
 * Create an axios instance that respects LaunchDarkly rate limits.
 * After each successful response it checks remaining quotas and pauses
 * if approaching the limit. On 429 responses it retries with exponential backoff.
 */
export function createLDClient(): AxiosInstance {
	const client = axios.create();

	client.interceptors.response.use(
		async (response) => {
			await respectRateLimit(response);
			return response;
		},
		async (error) => {
			if (!axios.isAxiosError(error) || error.response?.status !== 429) {
				throw error;
			}

			const config = error.config;
			if (!config) throw error;

			const configAny = config as unknown as Record<string, unknown>;
			const retryCount: number = (configAny.__retryCount as number) ?? 0;
			if (retryCount >= MAX_RETRIES) throw error;

			// Use Retry-After header if present, otherwise exponential backoff
			const retryAfterSec = Number(error.response?.headers?.['retry-after']);
			const delayMs =
				!Number.isNaN(retryAfterSec) && retryAfterSec > 0
					? retryAfterSec * 1000
					: RETRY_BASE_DELAY_MS * 2 ** retryCount;

			configAny.__retryCount = retryCount + 1;

			await sleep(delayMs);
			return client.request(config);
		},
	);

	return client;
}

// Module-level client used by all LD API functions.
// Exported for testing so AxiosMockAdapter can be attached to this instance.
export const ldClient = createLDClient();

// ─── Projects ────────────────────────────────────────────────────────────────

export interface LDProject {
	key: string;
	name: string;
}

/** Fetch all LaunchDarkly projects (paginated). */
export async function fetchProjects(apiKey: string): Promise<LDProject[]> {
	const projects: LDProject[] = [];
	let offset = 0;
	const limit = 20;

	while (true) {
		const response = await ldClient.get<{
			items: Array<{ key: string; name: string }>;
			totalCount: number;
		}>(`${LD_BASE_URL}/api/v2/projects`, {
			headers: ldHeaders(apiKey),
			params: { limit, offset },
		});

		const items = response.data.items ?? [];
		for (const item of items) {
			projects.push({ key: item.key, name: item.name });
		}

		offset += items.length;
		if (items.length < limit || offset >= response.data.totalCount) break;
	}

	return projects.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Environments ────────────────────────────────────────────────────────────

/** Fetch environments for a project from the LD API. */
export async function fetchProjectEnvironments(
	apiKey: string,
	projectKey: string,
): Promise<LDEnvironment[]> {
	const response = await ldClient.get<{
		environments:
			| {
					items: Array<{
						key: string;
						name: string;
						color: string;
						archived?: boolean;
					}>;
			  }
			| Array<{ key: string; name: string; color: string; archived?: boolean }>;
	}>(`${LD_BASE_URL}/api/v2/projects/${projectKey}`, {
		headers: ldHeaders(apiKey),
		params: { expand: 'environments' },
	});

	const rawEnvs = response.data.environments;
	const envs = Array.isArray(rawEnvs) ? rawEnvs : (rawEnvs?.items ?? []);
	return envs
		.map((e) => ({
			key: e.key,
			name: e.name,
			color: e.color,
			archived: e.archived ?? false,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Flags ───────────────────────────────────────────────────────────────────

/** Fetch all flag summaries for a project (lightweight, no environment configs). */
export async function fetchFlags(
	apiKey: string,
	projectKey: string,
): Promise<LDFlag[]> {
	const flags: LDFlag[] = [];
	let offset = 0;
	const limit = 20;

	while (true) {
		const response = await ldClient.get<{
			items: LDFlag[];
			totalCount: number;
		}>(`${LD_BASE_URL}/api/v2/flags/${projectKey}`, {
			headers: ldHeaders(apiKey),
			params: { limit, offset },
		});

		const items = response.data.items ?? [];
		for (const item of items) {
			if (item.key && item.variations) {
				flags.push(item);
			}
		}

		offset += items.length;
		if (items.length < limit || offset >= response.data.totalCount) break;
	}

	return flags;
}

/** Fetch a single flag with full environment configurations. */
export async function fetchFlag(
	apiKey: string,
	projectKey: string,
	flagKey: string,
): Promise<LDFlag> {
	const response = await ldClient.get<LDFlag>(
		`${LD_BASE_URL}/api/v2/flags/${projectKey}/${flagKey}`,
		{ headers: ldHeaders(apiKey) },
	);
	return response.data;
}

// ─── Releases ────────────────────────────────────────────────────────────────

export interface LDReleasePhase {
	_id: string;
	_name: string;
	status: 'NotStarted' | 'ReadyToStart' | 'Started' | 'Paused' | 'Complete';
	complete: boolean;
}

export interface LDRelease {
	phases: LDReleasePhase[];
}

/**
 * Fetch the release for a flag. Returns null if the flag has no release
 * (404 from the API).
 */
export async function fetchFlagRelease(
	apiKey: string,
	projectKey: string,
	flagKey: string,
): Promise<LDRelease | null> {
	try {
		const response = await ldClient.get<LDRelease>(
			`${LD_BASE_URL}/api/v2/flags/${projectKey}/${flagKey}/release`,
			{ headers: ldHeaders(apiKey) },
		);
		return response.data;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 404) {
			return null;
		}
		throw err;
	}
}

/**
 * Check if a flag's release has any in-progress (non-complete) phases.
 * Returns true if the progressive rollout is still active.
 */
export function isReleaseInProgress(release: LDRelease): boolean {
	return release.phases.some((phase) => phase.status !== 'Complete');
}

// ─── Custom Roles ────────────────────────────────────────────────────────────

/**
 * Fetch all custom roles from the LaunchDarkly API.
 * Returns empty array on 403 (Enterprise-only feature).
 * Loop terminates when items.length < limit OR offset >= totalCount; the
 * dual condition keeps termination safe when either signal is missing.
 */
export async function fetchCustomRoles(
	apiKey: string,
): Promise<LDCustomRole[]> {
	try {
		const roles: LDCustomRole[] = [];
		let offset = 0;
		const limit = 100;

		while (true) {
			const response = await ldClient.get<{
				items: LDCustomRole[];
				totalCount?: number;
			}>(`${LD_BASE_URL}/api/v2/roles`, {
				headers: ldHeaders(apiKey),
				params: { limit, offset },
			});

			const items = response.data.items ?? [];
			roles.push(...items);
			offset += items.length;

			const total = response.data.totalCount;
			if (items.length < limit || total === undefined || offset >= total) {
				break;
			}
		}

		return roles;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			return [];
		}
		throw err;
	}
}

// ─── Teams with Roles ────────────────────────────────────────────────────────

interface LDTeamsResponse {
	items: Array<{
		key: string;
		name: string;
		roles?: { items: Array<{ key: string }> };
	}>;
	totalCount?: number;
}

function parseTeams(data: LDTeamsResponse): LDTeamWithRoles[] {
	return (data.items ?? []).map((t) => ({
		key: t.key,
		name: t.name,
		roles: t.roles?.items ?? [],
	}));
}

async function fetchTeamRoles(
	apiKey: string,
	teamKey: string,
): Promise<Array<{ key: string }>> {
	const roles: Array<{ key: string }> = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const response = await ldClient.get<{
			items: Array<{ key: string }>;
			totalCount?: number;
		}>(`${LD_BASE_URL}/api/v2/teams/${teamKey}/roles`, {
			headers: ldHeaders(apiKey),
			params: { limit, offset },
		});

		const items = response.data.items ?? [];
		roles.push(...items.map((r) => ({ key: r.key })));
		offset += items.length;
		const total = response.data.totalCount;
		if (items.length < limit || total === undefined || offset >= total) {
			break;
		}
	}

	return roles;
}

/**
 * Fetch all teams with their assigned custom roles from the LaunchDarkly API.
 * Attempts expand=roles on the bulk teams call as a best-effort optimization.
 * If expand=roles is silently ignored (current LD API), falls back to fetching
 * roles per team via GET /api/v2/teams/{teamKey}/roles.
 * Returns empty array on 403 (Enterprise-only feature).
 */
export async function fetchTeamsWithRoles(
	apiKey: string,
): Promise<LDTeamWithRoles[]> {
	try {
		const teams: LDTeamWithRoles[] = [];
		let offset = 0;
		const limit = 100;

		while (true) {
			const response = await ldClient.get<LDTeamsResponse>(
				`${LD_BASE_URL}/api/v2/teams`,
				{
					headers: ldHeaders(apiKey),
					params: { expand: 'roles', limit, offset },
				},
			);

			teams.push(...parseTeams(response.data));
			const itemCount = (response.data.items ?? []).length;
			offset += itemCount;
			const total = response.data.totalCount;
			if (itemCount < limit || total === undefined || offset >= total) {
				break;
			}
		}

		// expand=roles is silently ignored in current LD API versions; fall back
		// to per-team role fetches when no roles came back on any team. Use
		// allSettled so a single failed team doesn't wipe out RBAC discovery
		// for every other team.
		if (teams.length > 0 && teams.every((t) => t.roles.length === 0)) {
			const results = await Promise.allSettled(
				teams.map((team) => fetchTeamRoles(apiKey, team.key)),
			);
			results.forEach((result, idx) => {
				const team = teams[idx];
				if (result.status === 'fulfilled') {
					team.roles = result.value;
				} else {
					console.warn(
						`Failed to fetch roles for team "${team.key}"; continuing with empty role set: ${
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason)
						}`,
					);
				}
			});
		}

		return teams;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			return [];
		}
		throw err;
	}
}

// ─── Segments ────────────────────────────────────────────────────────────────

/**
 * Fetch all segments for a project+environment.
 * LD uses Link-header pagination (rel="next"). We follow all pages because
 * needed segments can appear on any page.
 */
export async function fetchSegments(
	apiKey: string,
	projectKey: string,
	envKey: string,
): Promise<LDSegment[]> {
	const segments: LDSegment[] = [];
	let url: string | null =
		`${LD_BASE_URL}/api/v2/segments/${projectKey}/${envKey}?limit=50`;

	type SegmentsPage = {
		items: Array<Partial<LDSegment>>;
		_links?: { next?: { href?: string } };
	};

	while (url !== null) {
		// Explicit AxiosResponse annotation avoids TS7022 circular-initializer error
		// that arises when `url` (the while-condition variable) is reassigned from
		// the same response object inside the loop body.
		const response: AxiosResponse<SegmentsPage> =
			await ldClient.get<SegmentsPage>(url, {
				headers: ldHeaders(apiKey),
			});

		for (const item of response.data.items ?? []) {
			segments.push({
				key: item.key ?? '',
				name: item.name ?? '',
				description: item.description,
				tags: item.tags ?? [],
				included: item.included ?? [],
				excluded: item.excluded ?? [],
				includedContexts: item.includedContexts ?? [],
				excludedContexts: item.excludedContexts ?? [],
				rules: item.rules ?? [],
				deleted: item.deleted ?? false,
				_flags: item._flags ?? [],
			});
		}

		const rawHref = response.data._links?.next?.href ?? null;
		url =
			rawHref === null
				? null
				: rawHref.startsWith('/')
					? `${LD_BASE_URL}${rawHref}`
					: rawHref;
	}

	return segments;
}

/**
 * Fetch a single segment by key. Returns null on 404 (segment was deleted or
 * never existed). Used as fallback when a needed key is absent from the
 * list-endpoint pages.
 */
export async function fetchSegment(
	apiKey: string,
	projectKey: string,
	envKey: string,
	segmentKey: string,
): Promise<LDSegment | null> {
	try {
		const response = await ldClient.get<Partial<LDSegment>>(
			`${LD_BASE_URL}/api/v2/segments/${projectKey}/${envKey}/${segmentKey}`,
			{ headers: ldHeaders(apiKey) },
		);
		const item = response.data;
		return {
			key: item.key ?? segmentKey,
			name: item.name ?? segmentKey,
			description: item.description,
			tags: item.tags ?? [],
			included: item.included ?? [],
			excluded: item.excluded ?? [],
			includedContexts: item.includedContexts ?? [],
			excludedContexts: item.excludedContexts ?? [],
			rules: item.rules ?? [],
			deleted: item.deleted ?? false,
			_flags: item._flags ?? [],
		};
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 404) {
			return null;
		}
		throw err;
	}
}
