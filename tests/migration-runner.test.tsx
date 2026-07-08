import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { migrationRunner } from '../src/components/MigrationRunner.js';

/**
 * These tests exercise the non-TTY branch of migrationRunner (Jest has no
 * TTY on stderr), which is the code path that runs in CI and non-interactive
 * migrations. The interactive Ink-rendered path is verified visually.
 */
describe('migrationRunner (non-TTY)', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('is a no-op for beginFlag/updateText/finalize', () => {
		const writeSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);
		const runner = migrationRunner({ total: 3 });
		runner.beginFlag('a');
		runner.updateText('working…');
		runner.finalize();
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('writes settleFlag messages to stderr with a trailing newline', () => {
		const writeSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);
		const runner = migrationRunner({ total: 2 });
		runner.settleFlag({
			status: 'created',
			message: 'Created foo',
			stats: { created: 1, skipped: 0, failed: 0 },
		});
		runner.settleFlag({
			status: 'failed',
			message: 'Failed bar',
			stats: { created: 1, skipped: 0, failed: 1 },
		});
		expect(writeSpy).toHaveBeenCalledWith('Created foo\n');
		expect(writeSpy).toHaveBeenCalledWith('Failed bar\n');
	});

	it('writes printMessage lines to stderr with a trailing newline', () => {
		const writeSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);
		const runner = migrationRunner({ total: 1 });
		runner.printMessage('flag exists — will overwrite');
		expect(writeSpy).toHaveBeenCalledWith('flag exists — will overwrite\n');
	});
});
