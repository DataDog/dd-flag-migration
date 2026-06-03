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
	private cachedETA = '?';
	private lastCurrent = '—';
	private active = false;

	constructor(
		private readonly total: number,
		private readonly subheader?: string,
	) {
		this.stats = { created: 0, skipped: 0, failed: 0, retrying: 0 };
	}

	/**
	 * Reserve the bottom terminal rows as sticky rows by setting a scroll region
	 * over all rows above them. Layout (bottom-up):
	 *   row N    — progress bar
	 *   row N-1  — separator line
	 *   row N-2  — subheader (optional)
	 *   row N-3  — blank padding row (N-2 when no subheader)
	 */
	start(): void {
		if (!process.stderr.isTTY) return;
		this.active = true;
		this.setScrollRegion();
		this.redraw(this.lastCurrent);
		process.stderr.on('resize', this.handleResize);
	}

	update(current: string, stats: ProgressBarStats): void {
		this.lastCurrent = current;
		this.value++;
		this.stats = { retrying: 0, ...stats };
		this.completionTimes.push(Date.now());
		if (this.completionTimes.length > WINDOW_SIZE) {
			this.completionTimes.shift();
		}
		if (this.value % UPDATE_INTERVAL === 0 || this.value === this.total) {
			this.cachedETA = this.formatETA();
		}
		this.redraw(current);
	}

	/** Reset the scroll region, clear the fixed rows, and restore the cursor. */
	finalize(): void {
		if (!this.active) return;
		process.stderr.off('resize', this.handleResize);
		const rows = process.stderr.rows ?? 24;
		const paddingRow = this.subheader ? rows - 4 : rows - 3;
		let seq =
			'\x1b[s' + // save cursor
			'\x1b[r' + // reset scroll region to full screen
			`\x1b[${rows - 1};1H\x1b[K` + // clear bar row
			`\x1b[${rows - 2};1H\x1b[K` + // clear separator row
			`\x1b[${paddingRow};1H\x1b[K`; // clear padding row
		if (this.subheader) {
			seq += `\x1b[${rows - 3};1H\x1b[K`; // clear subheader row
		}
		seq += '\x1b[u'; // restore cursor
		process.stderr.write(seq);
		this.active = false;
	}

	clear(): void {
		this.finalize();
	}

	// Clear the screen, re-initialize the scroll region, and redraw on resize.
	private readonly handleResize = (): void => {
		if (!this.active) return;
		process.stderr.write(
			'\x1b[r' + // reset scroll region so clear covers full screen
				'\x1b[2J' + // clear entire screen
				'\x1b[H', // move cursor to top-left
		);
		this.setScrollRegion();
		this.redraw(this.lastCurrent);
	};

	private setScrollRegion(): void {
		const rows = process.stderr.rows ?? 24;
		// bottom margin + blank padding + separator + bar = 4 fixed rows; +1 if subheader
		const fixedRows = this.subheader ? 5 : 4;
		process.stderr.write(`\x1b[1;${rows - fixedRows}r`);
	}

	private redraw(current: string): void {
		if (!this.active) return;
		const rows = process.stderr.rows ?? 24;
		const columns = process.stderr.columns ?? 100;
		const separator = chalk.gray('─'.repeat(columns));
		// Layout (bottom-up): blank margin · bar · separator · blank padding · subheader?
		const barRow = rows - 1;
		const separatorRow = rows - 2;
		const paddingRow = this.subheader ? rows - 4 : rows - 3;
		let seq = `\x1b[s\x1b[${paddingRow};1H\x1b[K`; // save cursor, clear padding row
		if (this.subheader) {
			seq += `\x1b[${rows - 3};1H\x1b[K${this.subheader}`; // subheader row
		}
		seq +=
			`\x1b[${separatorRow};1H\x1b[K${separator}` + // separator row
			`\x1b[${barRow};1H\x1b[K${this.renderLine(current)}` + // bar row
			'\x1b[u'; // restore cursor
		process.stderr.write(seq);
	}

	private formatETA(): string {
		const n = this.completionTimes.length;
		if (n < 2) return '?';
		const elapsed =
			(this.completionTimes[n - 1] - this.completionTimes[0]) / 1000;
		if (elapsed < 0.1) return '?';
		const rate = (n - 1) / elapsed;
		const remaining = (this.total - this.value) / rate;
		if (!Number.isFinite(remaining) || remaining <= 0) return '0s';
		if (remaining < 60) return '< 1 min';
		return `${Math.round(remaining / 60)} min`;
	}

	private renderLine(current: string): string {
		const columns = process.stderr.columns ?? 100;
		const { created, skipped, failed, retrying } = this.stats;
		const pct =
			this.total === 0 ? 0 : Math.round((this.value / this.total) * 100);
		const eta = this.cachedETA;

		// Plain-text suffix for width calculation (no ANSI codes)
		const suffixPlain = ` ${this.value}/${this.total} · ${pct}% · ✓ ${created}  ⚠ ${skipped}  ✗ ${failed}  ⏳ ${retrying}  ·  ETA ${eta}  ·  current: ${current}`;
		const barWidth = Math.max(
			5,
			Math.min(30, columns - suffixPlain.length - 4), // -4 for " [" + "] " padding
		);
		const filled =
			this.total === 0
				? 0
				: Math.min(barWidth, Math.round((this.value / this.total) * barWidth));
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

		return ` [${coloredBar}] ${coloredSuffix}`;
	}
}
