import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { withConsoleLogToStderr, writeJsonOutput } from '../src/output.js';

describe('output helpers', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('routes console.log through stderr while the callback runs', async () => {
		const stdoutSpy = jest
			.spyOn(process.stdout, 'write')
			.mockReturnValue(true as never);
		const stderrSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);

		await withConsoleLogToStderr(async () => {
			console.log('status %s', 'line');
		});

		expect(stderrSpy).toHaveBeenCalledWith('status line\n');
		expect(stdoutSpy).not.toHaveBeenCalled();
	});

	it('writes formatted JSON to stdout', () => {
		const stdoutSpy = jest
			.spyOn(process.stdout, 'write')
			.mockReturnValue(true as never);
		const stderrSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);

		writeJsonOutput({ success: true, summary: { created: 1 } });

		expect(stdoutSpy).toHaveBeenCalledWith(
			'{\n  "success": true,\n  "summary": {\n    "created": 1\n  }\n}\n',
		);
		expect(stderrSpy).not.toHaveBeenCalled();
	});
});
