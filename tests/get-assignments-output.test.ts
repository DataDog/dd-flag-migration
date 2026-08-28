import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import type { PrecomputedAssignmentsResponse } from '../src/datadog/types.js';
import {
	formatAssignmentsStats,
	saveAssignmentsResponse,
} from '../src/get-assignments/output.js';

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
				},
			},
			format: 'PRECOMPUTED',
			obfuscated: false,
		},
	},
};

describe('get-assignments output', () => {
	const tempDirectories: string[] = [];

	afterEach(() => {
		for (const directory of tempDirectories) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
		tempDirectories.length = 0;
	});

	it('writes the response under a timestamp filename', () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'get-assignments-'),
		);
		tempDirectories.push(directory);
		const retrievedAt = new Date('2026-08-27T16:01:02.345Z');

		const saved = saveAssignmentsResponse(RESPONSE, directory, retrievedAt);

		expect(saved.filepath).toBe(
			path.join(directory, 'get-assignments', '2026-08-27T16-01-02-345Z.json'),
		);
		expect(JSON.parse(fs.readFileSync(saved.filepath, 'utf8'))).toEqual(
			RESPONSE,
		);
		expect(saved.sizeBytes).toBeGreaterThan(0);
	});

	it('formats request and response statistics', () => {
		const stats = formatAssignmentsStats({
			httpStatus: 200,
			durationMs: 123.456,
			assignmentCount: 42,
			ddEnv: 'prod',
			subjectKey: 'test_subject',
			saved: {
				filepath: path.join(process.cwd(), 'get-assignments', 'result.json'),
				sizeBytes: 2048,
				retrievedAt: new Date('2026-08-27T16:01:02.345Z'),
			},
		});

		expect(stats).toContain('HTTP status:       200');
		expect(stats).toContain('Request duration:  123.46 ms');
		expect(stats).toContain('Response size:     2,048 bytes');
		expect(stats).toContain('Assignments:       42');
		expect(stats).toContain('DD_ENV:            prod');
		expect(stats).toContain('Subject:           test_subject');
		expect(stats).toContain('Retrieved at:      2026-08-27T16:01:02.345Z');
		expect(stats).toContain('Saved to:          get-assignments/result.json');
	});
});
