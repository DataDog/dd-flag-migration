import axios from 'axios';
import type { LDEnvironment, LDFlag } from './types.js';

const LD_BASE_URL = 'https://app.launchdarkly.com';

function ldHeaders(apiKey: string) {
	return { Authorization: apiKey };
}

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
		const response = await axios.get<{
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
	const response = await axios.get<{
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
		const response = await axios.get<{
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
	const response = await axios.get<LDFlag>(
		`${LD_BASE_URL}/api/v2/flags/${projectKey}/${flagKey}`,
		{ headers: ldHeaders(apiKey) },
	);
	return response.data;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validate a LaunchDarkly API key by attempting to list projects. */
export async function validateLDApiKey(apiKey: string): Promise<boolean> {
	try {
		await axios.get(`${LD_BASE_URL}/api/v2/projects`, {
			headers: ldHeaders(apiKey),
			params: { limit: 1 },
		});
		return true;
	} catch {
		return false;
	}
}
