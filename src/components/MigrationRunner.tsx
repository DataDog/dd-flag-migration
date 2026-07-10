import chalk from 'chalk';
import { Box, Static, Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { mountLive } from './mount.js';

const UPDATE_INTERVAL = 20;
const WINDOW_SIZE = 20;
const MAX_SETTLED = 500;

export type SettleStatus = 'created' | 'synced' | 'skipped' | 'failed';

export type ProgressBarStats = {
	created: number;
	skipped: number;
	failed: number;
	retrying?: number;
};

export type MigrationRunnerHandle = {
	beginFlag(key: string): void;
	updateText(text: string): void;
	/**
	 * Persist a message line above the sticky region without advancing the
	 * progress bar. Used for intra-flag warnings that don't settle the flag.
	 */
	printMessage(message: string): void;
	settleFlag(args: {
		status: SettleStatus;
		message: string;
		stats: ProgressBarStats;
	}): void;
	finalize(): void;
};

type SettledItem = { id: string; message: string };

type ViewState = {
	total: number;
	subheader?: string;
	value: number;
	stats: Required<ProgressBarStats>;
	currentFlag: string | null;
	currentText: string;
	settled: SettledItem[];
	eta: string;
	columns: number;
};

function renderBarLine(state: ViewState): string {
	const { value, total, stats, eta, columns } = state;
	const { created, skipped, failed, retrying } = stats;
	const pct = total === 0 ? 0 : Math.round((value / total) * 100);
	const suffixPlain = ` ${value}/${total} · ${pct}% · ✓ ${created}  ⚠ ${skipped}  ✗ ${failed}  ⏳ ${retrying}  ·  ETA ${eta}`;
	const barWidth = Math.max(5, Math.min(30, columns - suffixPlain.length - 4));
	const filled =
		total === 0
			? 0
			: Math.min(barWidth, Math.round((value / total) * barWidth));
	const empty = barWidth - filled;
	const coloredBar =
		chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
	const coloredSuffix =
		` ${chalk.white(`${value}/${total}`)}` +
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
		eta;
	return ` [${coloredBar}] ${coloredSuffix}`;
}

function RunnerView({ state }: { state: ViewState }): JSX.Element {
	const separator = chalk.gray('─'.repeat(state.columns));
	return (
		<>
			<Static items={state.settled}>
				{(item) => (
					<Box key={item.id}>
						<Text>{item.message}</Text>
					</Box>
				)}
			</Static>
			<Box flexDirection="column">
				{state.currentFlag !== null ? (
					<Text>
						<Text color="cyan">
							<InkSpinner type="dots" />
						</Text>
						<Text> {state.currentText}</Text>
					</Text>
				) : (
					<Text> </Text>
				)}
				{state.subheader !== undefined ? <Text>{state.subheader}</Text> : null}
				<Text>{separator}</Text>
				<Text>{renderBarLine(state)}</Text>
			</Box>
		</>
	);
}

function createNonTtyRunner(): MigrationRunnerHandle {
	return {
		beginFlag() {},
		updateText() {},
		printMessage(message: string): void {
			process.stderr.write(`${message}\n`);
		},
		settleFlag({ message }): void {
			process.stderr.write(`${message}\n`);
		},
		finalize() {},
	};
}

export function migrationRunner(opts: {
	total: number;
	subheader?: string;
}): MigrationRunnerHandle {
	if (!process.stderr.isTTY) return createNonTtyRunner();
	const state: ViewState = {
		total: opts.total,
		subheader: opts.subheader,
		value: 0,
		stats: { created: 0, skipped: 0, failed: 0, retrying: 0 },
		currentFlag: null,
		currentText: '',
		settled: [],
		eta: '?',
		columns: process.stderr.columns ?? 100,
	};
	const completionTimes: number[] = [];
	let idCounter = 0;

	const live = mountLive(<RunnerView state={state} />);

	const rerender = (): void => {
		live.rerender(
			<RunnerView state={{ ...state, settled: [...state.settled] }} />,
		);
	};

	const recomputeEta = (): void => {
		const n = completionTimes.length;
		if (n < 2) {
			state.eta = '?';
			return;
		}
		const elapsed = (completionTimes[n - 1] - completionTimes[0]) / 1000;
		if (elapsed < 0.1) {
			state.eta = '?';
			return;
		}
		const rate = (n - 1) / elapsed;
		const remaining = (state.total - state.value) / rate;
		if (!Number.isFinite(remaining) || remaining <= 0) {
			state.eta = '0s';
			return;
		}
		state.eta =
			remaining < 60 ? '< 1 min' : `${Math.round(remaining / 60)} min`;
	};

	return {
		beginFlag(key: string): void {
			state.currentFlag = key;
			state.currentText = `Migrating ${chalk.cyan(key)}…`;
			rerender();
		},
		updateText(text: string): void {
			state.currentText = text;
			rerender();
		},
		printMessage(message: string): void {
			state.settled.push({ id: `s${idCounter++}`, message });
			if (state.settled.length > MAX_SETTLED)
				state.settled = state.settled.slice(-MAX_SETTLED);
			rerender();
		},
		settleFlag({ status: _status, message, stats: nextStats }): void {
			state.settled.push({ id: `s${idCounter++}`, message });
			if (state.settled.length > MAX_SETTLED)
				state.settled = state.settled.slice(-MAX_SETTLED);
			state.value++;
			state.stats = { retrying: 0, ...nextStats };
			completionTimes.push(Date.now());
			if (completionTimes.length > WINDOW_SIZE) completionTimes.shift();
			if (state.value % UPDATE_INTERVAL === 0 || state.value === state.total) {
				recomputeEta();
			}
			state.currentFlag = null;
			state.currentText = '';
			rerender();
		},
		finalize(): void {
			live.unmount();
		},
	};
}
