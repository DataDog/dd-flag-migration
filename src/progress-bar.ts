import chalk from 'chalk';

const UPDATE_INTERVAL = 20;
const WINDOW_SIZE = 20;

export interface ProgressBarStats {
	created: number;
	skipped: number;
	failed: number;
	retrying?: number;
}

export class MigrationProgressBar {
	private value = 0;
	private stats: Required<ProgressBarStats>;
	private readonly completionTimes: number[] = [];

	constructor(private readonly total: number) {
		this.stats = { created: 0, skipped: 0, failed: 0, retrying: 0 };
	}

	update(current: string, stats: ProgressBarStats): void {
		this.value++;
		this.stats = { retrying: 0, ...stats };
		this.completionTimes.push(Date.now());
		if (this.completionTimes.length > WINDOW_SIZE) {
			this.completionTimes.shift();
		}
		if (this.value % UPDATE_INTERVAL === 0 || this.value === this.total) {
			this.render(current);
		}
	}

	/** Advance past the bar so subsequent console output starts on a fresh line. */
	finalize(): void {
		process.stderr.write('\n');
	}

	clear(): void {
		process.stderr.write('\r\x1b[K');
	}

	private formatETA(): string {
		const n = this.completionTimes.length;
		if (n < 2) return '?';
		const elapsed =
			(this.completionTimes[n - 1] - this.completionTimes[0]) / 1000;
		if (elapsed < 0.1) return '?';
		// (n - 1) inter-completion intervals span `elapsed` seconds
		const rate = (n - 1) / elapsed;
		const remaining = (this.total - this.value) / rate;
		if (!Number.isFinite(remaining) || remaining <= 0) return '0s';
		if (remaining < 60) return '< 1 min';
		return `${Math.round(remaining / 60)} min`;
	}

	private render(current: string): void {
		const columns = process.stderr.columns ?? 100;
		const { created, skipped, failed, retrying } = this.stats;
		const pct = Math.round((this.value / this.total) * 100);
		const eta = this.formatETA();

		// Plain-text suffix for width calculation (no ANSI codes)
		const suffixPlain = ` ${this.value}/${this.total} · ${pct}% · ✓ ${created}  ⚠ ${skipped}  ✗ ${failed}  ⏳ ${retrying}  ·  ETA ${eta}  ·  current: ${current}`;
		const barWidth = Math.max(
			5,
			Math.min(30, columns - suffixPlain.length - 2),
		);
		const filled = Math.min(
			barWidth,
			Math.round((this.value / this.total) * barWidth),
		);
		const empty = barWidth - filled;

		const coloredBar =
			chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
		const coloredSuffix =
			` ${chalk.white(`${this.value}/${this.total}`)}` +
			chalk.gray(' · ') +
			chalk.yellow(`${pct}%`) +
			chalk.gray(' · ') +
			chalk.green('✓') +
			` ${created}  ` +
			chalk.yellow('⚠') +
			` ${skipped}  ` +
			chalk.red('✗') +
			` ${failed}  ` +
			chalk.cyan('⏳') +
			` ${retrying}` +
			chalk.gray('  ·  ETA ') +
			eta +
			chalk.gray('  ·  current: ') +
			chalk.cyan(current);

		process.stderr.write(`\r\x1b[K[${coloredBar}]${coloredSuffix}`);
	}
}
