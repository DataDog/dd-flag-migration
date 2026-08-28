import fs from 'node:fs';
import path from 'node:path';
import type { PrecomputedAssignmentsResponse } from '../datadog/types.js';

export type SavedAssignmentsResponse = {
	filepath: string;
	sizeBytes: number;
	retrievedAt: Date;
};

function timestampFilename(retrievedAt: Date): string {
	return `${retrievedAt.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function saveAssignmentsResponse(
	response: PrecomputedAssignmentsResponse,
	baseDirectory = process.cwd(),
	retrievedAt = new Date(),
): SavedAssignmentsResponse {
	const outputDirectory = path.join(baseDirectory, 'get-assignments');
	fs.mkdirSync(outputDirectory, { recursive: true });

	const body = `${JSON.stringify(response, null, 2)}\n`;
	const filepath = path.join(outputDirectory, timestampFilename(retrievedAt));
	fs.writeFileSync(filepath, body, { encoding: 'utf8', flag: 'wx' });

	return {
		filepath,
		sizeBytes: Buffer.byteLength(body),
		retrievedAt,
	};
}

export function formatAssignmentsStats({
	httpStatus,
	durationMs,
	assignmentCount,
	ddEnv,
	subjectKey,
	saved,
}: {
	httpStatus: number;
	durationMs: number;
	assignmentCount: number;
	ddEnv: string;
	subjectKey: string;
	saved: SavedAssignmentsResponse;
}): string {
	return [
		`HTTP status:       ${httpStatus}`,
		`Request duration:  ${durationMs.toFixed(2)} ms`,
		`Response size:     ${saved.sizeBytes.toLocaleString()} bytes`,
		`Assignments:       ${assignmentCount.toLocaleString()}`,
		`DD_ENV:            ${ddEnv}`,
		`Subject:           ${subjectKey}`,
		`Retrieved at:      ${saved.retrievedAt.toISOString()}`,
		`Saved to:          ${path.relative(process.cwd(), saved.filepath) || saved.filepath}`,
	].join('\n');
}
