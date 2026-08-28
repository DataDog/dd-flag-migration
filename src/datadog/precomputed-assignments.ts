import { performance } from 'node:perf_hooks';
import axios from 'axios';
import type {
	PrecomputedAssignment,
	PrecomputedAssignmentsResponse,
	PrecomputedAssignmentsSubject,
} from './types.js';

export const DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT: PrecomputedAssignmentsSubject =
	{
		targeting_key: 'test_subject',
		targeting_attributes: {
			attr1: 'value1',
			companyId: '1',
		},
	};

export type FetchPrecomputedAssignmentsOptions = {
	clientToken: string;
	site: string;
	ddEnv: string;
	subject: PrecomputedAssignmentsSubject;
	sdk?: {
		name: string;
		version: string;
	};
};

export type PrecomputedAssignmentsFetchResult = {
	response: PrecomputedAssignmentsResponse;
	httpStatus: number;
	durationMs: number;
};

export function parsePrecomputedAssignmentsSubject(
	raw: string,
): PrecomputedAssignmentsSubject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('Subject must be valid JSON');
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Subject must be a JSON object');
	}

	const candidate = parsed as Record<string, unknown>;
	if (
		typeof candidate.targeting_key !== 'string' ||
		candidate.targeting_key.trim().length === 0
	) {
		throw new Error('Subject targeting_key must be a non-empty string');
	}

	const attributes = candidate.targeting_attributes;
	if (
		typeof attributes !== 'object' ||
		attributes === null ||
		Array.isArray(attributes)
	) {
		throw new Error('Subject targeting_attributes must be a JSON object');
	}

	for (const [key, value] of Object.entries(attributes)) {
		if (
			value !== null &&
			typeof value !== 'string' &&
			typeof value !== 'number' &&
			typeof value !== 'boolean'
		) {
			throw new Error(
				`Subject targeting attribute "${key}" must be a string, number, boolean, or null`,
			);
		}
	}

	return {
		targeting_key: candidate.targeting_key.trim(),
		targeting_attributes:
			attributes as PrecomputedAssignmentsSubject['targeting_attributes'],
	};
}

export async function fetchPrecomputedAssignments(
	options: FetchPrecomputedAssignmentsOptions,
): Promise<PrecomputedAssignmentsResponse> {
	const result = await fetchPrecomputedAssignmentsWithStats(options);
	return result.response;
}

export async function fetchPrecomputedAssignmentsWithStats({
	clientToken,
	site,
	ddEnv,
	subject,
	sdk = { name: 'migration', version: 'dev' },
}: FetchPrecomputedAssignmentsOptions): Promise<PrecomputedAssignmentsFetchResult> {
	const url = `https://preview.ff-cdn.${site}/precompute-assignments?dd_env=${encodeURIComponent(ddEnv)}`;
	const startedAt = performance.now();

	try {
		const response = await axios.post<PrecomputedAssignmentsResponse>(
			url,
			{
				data: {
					type: 'precompute-assignments-request',
					attributes: {
						env: { dd_env: ddEnv },
						sdk,
						subject,
					},
				},
			},
			{
				headers: {
					'Content-Type': 'application/vnd.api+json',
					'dd-client-token': clientToken,
				},
			},
		);
		return {
			response: response.data,
			httpStatus: response.status,
			durationMs: performance.now() - startedAt,
		};
	} catch (error) {
		if (axios.isAxiosError(error) && error.response) {
			const detail = JSON.stringify(error.response.data);
			throw new Error(`HTTP ${error.response.status} from ${url}\n  ${detail}`);
		}
		throw error;
	}
}

export async function fetchPrecomputedAssignmentFlags(
	options: FetchPrecomputedAssignmentsOptions,
): Promise<Record<string, PrecomputedAssignment>> {
	const response = await fetchPrecomputedAssignments(options);
	return response.data?.attributes?.flags ?? {};
}
