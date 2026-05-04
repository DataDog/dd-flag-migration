import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import type {
	LDCustomRole,
	LDEnvironment,
	LDFlag,
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

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validate a LaunchDarkly API key by attempting to list projects. */
export async function validateLDApiKey(apiKey: string): Promise<boolean> {
	try {
		await ldClient.get(`${LD_BASE_URL}/api/v2/projects`, {
			headers: ldHeaders(apiKey),
			params: { limit: 1 },
		});
		return true;
	} catch {
		return false;
	}
}

// ─── Custom Roles ────────────────────────────────────────────────────────────

/**
 * Fetch all custom roles from the LaunchDarkly API.
 * Returns empty array on 403 (Enterprise-only feature).
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

// expand=roles was removed in LD API version 20240415; this older version still supports it.
const LD_LEGACY_TEAMS_API_VERSION = '20220603';

interface LDTeamsResponse {
	items: Array<{
		key: string;
		name: string;
		roles?: { items: Array<{ key: string }> };
	}>;
	totalCount: number;
}

function parseTeams(data: LDTeamsResponse): LDTeamWithRoles[] {
	return (data.items ?? []).map((t) => ({
		key: t.key,
		name: t.name,
		roles: t.roles?.items ?? [],
	}));
}

/**
 * Fetch all teams with their assigned custom roles from the LaunchDarkly API.
 * Uses expand=roles to include role assignments. If roles come back empty on
 * all teams, retries with an older API version header (LD-API-Version: 20220603)
 * since expand=roles was removed in version 20240415.
 * Returns empty array on 403 (Enterprise-only feature).
 */
export async function fetchTeamsWithRoles(
	apiKey: string,
	apiVersion?: string,
): Promise<LDTeamWithRoles[]> {
	try {
		const teams: LDTeamWithRoles[] = [];
		let offset = 0;
		const limit = 100;

		while (true) {
			const headers: Record<string, string> = {
				...ldHeaders(apiKey),
				...(apiVersion ? { 'LD-API-Version': apiVersion } : {}),
			};

			const response = await ldClient.get<LDTeamsResponse>(
				`${LD_BASE_URL}/api/v2/teams`,
				{
					headers,
					params: { expand: 'roles', limit, offset },
				},
			);

			teams.push(...parseTeams(response.data));
			offset += (response.data.items ?? []).length;
			if (
				(response.data.items ?? []).length < limit ||
				offset >= response.data.totalCount
			) {
				break;
			}
		}

		// If no team has any roles and we haven't tried the older API version,
		// retry with the pre-20240415 version where expand=roles was supported.
		if (
			!apiVersion &&
			teams.length > 0 &&
			teams.every((t) => t.roles.length === 0)
		) {
			return fetchTeamsWithRoles(apiKey, LD_LEGACY_TEAMS_API_VERSION);
		}

		return teams;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			return [];
		}
		throw err;
	}
}
