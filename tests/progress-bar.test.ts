import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import { MigrationProgressBar } from '../src/progress-bar.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTTY(rows = 24, columns = 80): void {
	Object.defineProperty(process.stderr, 'isTTY', {
		value: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, 'rows', {
		value: rows,
		configurable: true,
	});
	Object.defineProperty(process.stderr, 'columns', {
		value: columns,
		configurable: true,
	});
}

function clearTTY(): void {
	Object.defineProperty(process.stderr, 'isTTY', {
		value: undefined,
		configurable: true,
	});
}

// Cast to reach private state in tests.
function priv(bar: MigrationProgressBar): Record<string, unknown> {
	return bar as unknown as Record<string, unknown>;
}

// ─── Non-TTY: pure logic ──────────────────────────────────────────────────────

describe('MigrationProgressBar — non-TTY (value/stats tracking)', () => {
	it('value increments with each update call', () => {
		const bar = new MigrationProgressBar(10);
		bar.update('flag-a', { created: 1, skipped: 0, failed: 0 });
		bar.update('flag-b', { created: 2, skipped: 0, failed: 0 });
		expect(priv(bar).value).toBe(2);
	});

	it('tracks latest stats after update', () => {
		const bar = new MigrationProgressBar(10);
		bar.update('flag-a', { created: 3, skipped: 1, failed: 2 });
		const stats = priv(bar).stats as Record<string, number>;
		expect(stats.created).toBe(3);
		expect(stats.skipped).toBe(1);
		expect(stats.failed).toBe(2);
	});

	it('defaults retrying to 0 when not provided', () => {
		const bar = new MigrationProgressBar(10);
		bar.update('flag-a', { created: 1, skipped: 0, failed: 0 });
		const stats = priv(bar).stats as Record<string, number>;
		expect(stats.retrying).toBe(0);
	});

	it('tracks the last current flag key', () => {
		const bar = new MigrationProgressBar(10);
		bar.update('flag-a', { created: 1, skipped: 0, failed: 0 });
		bar.update('flag-b', { created: 2, skipped: 0, failed: 0 });
		expect(priv(bar).lastCurrent).toBe('flag-b');
	});

	it('sliding window caps completionTimes at 20 entries', () => {
		const bar = new MigrationProgressBar(100);
		for (let i = 0; i < 25; i++) {
			bar.update(`flag-${i}`, { created: i, skipped: 0, failed: 0 });
		}
		const times = priv(bar).completionTimes as unknown[];
		expect(times.length).toBeLessThanOrEqual(20);
	});

	it('start() writes nothing when not a TTY', () => {
		const writeSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);
		const bar = new MigrationProgressBar(10);
		bar.start();
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it('finalize() writes nothing when never started', () => {
		const writeSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);
		const bar = new MigrationProgressBar(10);
		bar.finalize();
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});
});

// ─── ETA calculation ──────────────────────────────────────────────────────────

describe('MigrationProgressBar — ETA calculation', () => {
	it('returns "?" with fewer than 2 data points', () => {
		const bar = new MigrationProgressBar(10);
		(priv(bar).completionTimes as number[]).push(Date.now());
		priv(bar).value = 1;
		const eta = (bar as unknown as { formatETA: () => string }).formatETA();
		expect(eta).toBe('?');
	});

	it('returns "?" when elapsed is under 100ms', () => {
		const bar = new MigrationProgressBar(10);
		const now = Date.now();
		(priv(bar).completionTimes as number[]).push(now - 50, now);
		priv(bar).value = 2;
		const eta = (bar as unknown as { formatETA: () => string }).formatETA();
		expect(eta).toBe('?');
	});

	it('returns "< 1 min" when remaining time is under 60 seconds', () => {
		const bar = new MigrationProgressBar(100);
		const now = Date.now();
		// 2 completions over 2 seconds = 0.5 flags/sec; 98 remaining = 196 seconds
		// Wait — with only 2 points the window is fine, but let me pick numbers where remaining < 60
		// 2 completions over 0.2 seconds = 5 flags/sec; 98 remaining = 19.6 seconds < 60
		(priv(bar).completionTimes as number[]).push(now - 200, now);
		priv(bar).value = 2;
		const eta = (bar as unknown as { formatETA: () => string }).formatETA();
		expect(eta).toBe('< 1 min');
	});

	it('returns minutes when remaining time is 60 seconds or more', () => {
		const bar = new MigrationProgressBar(1000);
		const now = Date.now();
		// 2 completions over 1 second = 1 flag/sec; 998 remaining ≈ 998 seconds ≈ 17 min
		(priv(bar).completionTimes as number[]).push(now - 1000, now);
		priv(bar).value = 2;
		const eta = (bar as unknown as { formatETA: () => string }).formatETA();
		expect(eta).toBe('17 min');
	});

	it('returns "0s" when all flags are done', () => {
		const bar = new MigrationProgressBar(10);
		const now = Date.now();
		(priv(bar).completionTimes as number[]).push(now - 1000, now);
		priv(bar).value = 10; // value === total, so remaining = 0
		const eta = (bar as unknown as { formatETA: () => string }).formatETA();
		expect(eta).toBe('0s');
	});

	it('cachedETA starts as "?"', () => {
		const bar = new MigrationProgressBar(10);
		expect(priv(bar).cachedETA).toBe('?');
	});

	it('cachedETA is recalculated when value reaches total', () => {
		const bar = new MigrationProgressBar(5);
		// Pre-load timestamps so formatETA returns something non-'?'
		const now = Date.now();
		(priv(bar).completionTimes as number[]).push(
			now - 500,
			now - 400,
			now - 300,
			now - 200,
		);
		for (let i = 0; i < 5; i++) {
			bar.update(`flag-${i}`, { created: i, skipped: 0, failed: 0 });
		}
		// At value === total the cache is refreshed; with 5 flags done, remaining <= 0 → "0s"
		expect(priv(bar).cachedETA).toBe('0s');
	});
});

// ─── TTY: active flag and output ──────────────────────────────────────────────

describe('MigrationProgressBar — TTY mode', () => {
	let writeSpy: ReturnType<typeof jest.spyOn>;

	beforeEach(() => {
		makeTTY();
		writeSpy = jest
			.spyOn(process.stderr, 'write')
			.mockReturnValue(true as never);
		// Suppress event listener calls on stderr so resize events don't interfere.
		jest.spyOn(process.stderr, 'on').mockReturnValue(process.stderr as never);
		jest.spyOn(process.stderr, 'off').mockReturnValue(process.stderr as never);
	});

	afterEach(() => {
		jest.restoreAllMocks();
		clearTTY();
	});

	it('start() sets active to true', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		expect(priv(bar).active).toBe(true);
	});

	it('start() writes a scroll-region escape sequence', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		const written = (writeSpy.mock.calls as [string][])
			.map((c) => c[0])
			.join('');
		expect(written).toContain('\x1b[1;');
	});

	it('finalize() sets active to false', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		bar.finalize();
		expect(priv(bar).active).toBe(false);
	});

	it('finalize() resets the scroll region', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		writeSpy.mockClear();
		bar.finalize();
		const written = (writeSpy.mock.calls as [string][])
			.map((c) => c[0])
			.join('');
		expect(written).toContain('\x1b[r');
	});

	it('finalize() called a second time is a no-op', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		bar.finalize();
		writeSpy.mockClear();
		bar.finalize();
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('clear() is an alias for finalize()', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		bar.clear();
		expect(priv(bar).active).toBe(false);
	});

	it('update() writes to stderr', () => {
		const bar = new MigrationProgressBar(10);
		bar.start();
		writeSpy.mockClear();
		bar.update('my-flag', { created: 1, skipped: 0, failed: 0 });
		expect(writeSpy).toHaveBeenCalled();
	});

	it('subheader text appears in start() output', () => {
		const bar = new MigrationProgressBar(10, 'Phase 1 — Audiences: 3 created');
		bar.start();
		const written = (writeSpy.mock.calls as [string][])
			.map((c) => c[0])
			.join('');
		expect(written).toContain('Phase 1 — Audiences: 3 created');
	});

	it('scroll region uses more rows when subheader is provided', () => {
		// rows=24, fixedRows=5 with subheader → scroll region ends at row 19
		const barWith = new MigrationProgressBar(10, 'subheader');
		barWith.start();
		const withSub = (writeSpy.mock.calls as [string][])
			.map((c) => c[0])
			.join('');
		expect(withSub).toContain('\x1b[1;19r');

		writeSpy.mockClear();

		// rows=24, fixedRows=4 without subheader → scroll region ends at row 20
		const barWithout = new MigrationProgressBar(10);
		barWithout.start();
		const withoutSub = (writeSpy.mock.calls as [string][])
			.map((c) => c[0])
			.join('');
		expect(withoutSub).toContain('\x1b[1;20r');
	});
});
