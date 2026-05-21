import axios, { type AxiosInstance } from 'axios';
import type { EppoAudience, EppoFlag, EppoFlagEnvironment } from './types.js';

const EPPO_BASE_URL = 'https://eppo.cloud';
const EPPO_PAGE_SIZE = 100;

// ─── Rate Limiting ──────────────────────────────────────────────────────────

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_FACTOR = 2;
const RETRY_MAX_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Eppo's 429 response body is plain text like
 * "Too many requests. Rate limit is 200 requests per 15 minute(s)."
 * Pull (limit, windowSeconds) when present so we can wait roughly one window
 * on the first retry; fall back to exponential backoff otherwise.
 */
function parseRateLimitBody(body: unknown): { windowSeconds: number } | null {
	const text =
		typeof body === 'string'
			? body
			: typeof (body as { message?: unknown })?.message === 'string'
				? (body as { message: string }).message
				: null;
	if (!text) return null;
	const match = text.match(
		/Rate limit is \d+ requests? per (\d+) (second|minute|hour)/i,
	);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const unit = match[2].toLowerCase();
	const seconds =
		unit === 'hour' ? amount * 3600 : unit === 'minute' ? amount * 60 : amount;
	return { windowSeconds: seconds };
}

function backoffDelayMs(attempt: number): number {
	const exp = RETRY_BASE_DELAY_MS * RETRY_FACTOR ** attempt;
	const jitter = Math.random() * RETRY_BASE_DELAY_MS;
	return Math.min(RETRY_MAX_DELAY_MS, exp + jitter);
}

/**
 * Create an axios instance that retries Eppo 429 responses with
 * exponential backoff. Eppo emits no rate-limit headers, so this is
 * purely reactive: we can only catch 429, optionally parse the body
 * for the limit window, sleep, and retry.
 */
export function createEppoClient(): AxiosInstance {
	const client = axios.create();

	client.interceptors.response.use(
		(response) => response,
		async (error) => {
			if (!axios.isAxiosError(error) || error.response?.status !== 429) {
				throw error;
			}

			const config = error.config;
			if (!config) throw error;

			const configAny = config as unknown as Record<string, unknown>;
			const retryCount: number = (configAny.__retryCount as number) ?? 0;
			if (retryCount >= MAX_RETRIES) {
				throw new Error(
					`Eppo rate-limited after ${MAX_RETRIES} retries; try again later`,
				);
			}

			let delayMs = backoffDelayMs(retryCount);
			if (retryCount === 0) {
				const parsed = parseRateLimitBody(error.response?.data);
				if (parsed) {
					delayMs = parsed.windowSeconds * 1_000;
				}
			}

			configAny.__retryCount = retryCount + 1;
			await sleep(delayMs);
			return client.request(config);
		},
	);

	return client;
}

// Module-level client used by all Eppo API functions.
// Exported for testing so AxiosMockAdapter can be attached to this instance.
export const eppoClient = createEppoClient();

// ─── Flags ───────────────────────────────────────────────────────────────────

type EppoFlagsResponse = EppoFlag[] | { data: EppoFlag[]; total?: number };

function unwrapPage(data: EppoFlagsResponse | undefined): EppoFlag[] {
	if (Array.isArray(data)) return data;
	if (data && 'data' in data && Array.isArray(data.data)) return data.data;
	return [];
}

export interface FetchEppoFlagsOptions {
	/** Called as each page lands, with the running total fetched so far. */
	onProgress?: (fetched: number) => void;
	/** Override the page size (primarily for tests). */
	pageSize?: number;
}

export async function fetchEppoFlags(
	apiKey: string,
	options: FetchEppoFlagsOptions = {},
): Promise<EppoFlag[]> {
	const pageSize = options.pageSize ?? EPPO_PAGE_SIZE;
	const all: EppoFlag[] = [];
	let offset = 0;

	while (true) {
		const response = await eppoClient.get<EppoFlagsResponse>(
			`${EPPO_BASE_URL}/api/v1/feature-flags`,
			{
				headers: {
					'x-eppo-token': apiKey,
					'Content-Type': 'application/json',
				},
				params: {
					offset,
					limit: pageSize,
					include_detailed_allocations: true,
				},
			},
		);

		const page = unwrapPage(response.data);
		all.push(...page);
		options.onProgress?.(all.length);

		// Eppo returns no count header / no next-cursor, so detect end-of-pagination
		// by a short page. If a page is exactly pageSize we must request again —
		// the next page will be empty (length 0 < pageSize) and the loop exits.
		if (page.length < pageSize) break;
		offset += pageSize;
	}

	return all;
}

export function extractEnvironments(flags: EppoFlag[]): EppoFlagEnvironment[] {
	const seen = new Map<number, EppoFlagEnvironment>();
	for (const flag of flags) {
		for (const env of flag.environments ?? []) {
			if (!seen.has(env.id)) seen.set(env.id, env);
		}
	}
	return [...seen.values()].sort((a, b) => {
		if (a.is_production !== b.is_production) return a.is_production ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

// ─── Audiences ───────────────────────────────────────────────────────────────

export async function fetchEppoAudiences(
	apiKey: string,
): Promise<EppoAudience[]> {
	const response = await eppoClient.get<EppoAudience[]>(
		`${EPPO_BASE_URL}/api/v1/audiences`,
		{
			headers: {
				'x-eppo-token': apiKey,
				'Content-Type': 'application/json',
			},
			params: { status: 'active' },
		},
	);
	return Array.isArray(response.data) ? response.data : [];
}

export async function validateEppoApiKey(apiKey: string): Promise<boolean> {
	try {
		// Probe with a single-row page rather than fetching every flag.
		await eppoClient.get(`${EPPO_BASE_URL}/api/v1/feature-flags`, {
			headers: {
				'x-eppo-token': apiKey,
				'Content-Type': 'application/json',
			},
			params: { offset: 0, limit: 1 },
		});
		return true;
	} catch {
		return false;
	}
}
