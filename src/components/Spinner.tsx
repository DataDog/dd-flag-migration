import chalk from 'chalk';
import { Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { mountLive } from './mount.js';

export type SpinnerOptions = {
	text?: string;
	// Accepted for source-compat with ora; mapped to Ink's disable path.
	isEnabled?: boolean;
	// Accepted and ignored: this adapter never puts stdin into raw mode.
	discardStdin?: boolean;
};

export type SpinnerHandle = {
	text: string;
	start(text?: string): SpinnerHandle;
	succeed(text?: string): SpinnerHandle;
	fail(text?: string): SpinnerHandle;
	warn(text?: string): SpinnerHandle;
	info(text?: string): SpinnerHandle;
	stop(): SpinnerHandle;
};

type LiveHandle = ReturnType<typeof mountLive>;

function SpinnerLine({ text }: { text: string }): JSX.Element {
	return (
		<Text>
			<Text color="cyan">
				<InkSpinner type="dots" />
			</Text>
			<Text> {text}</Text>
		</Text>
	);
}

class SpinnerAdapter implements SpinnerHandle {
	private state: 'idle' | 'active' = 'idle';
	private currentText: string;
	private live: LiveHandle | null = null;
	private readonly enabled: boolean;

	constructor(text: string, enabled: boolean) {
		this.currentText = text;
		this.enabled = enabled;
	}

	get text(): string {
		return this.currentText;
	}

	set text(next: string) {
		this.currentText = next;
		if (this.state === 'active' && this.live) {
			this.live.rerender(<SpinnerLine text={next} />);
		}
	}

	start(text?: string): SpinnerHandle {
		if (text !== undefined) this.currentText = text;
		if (!this.enabled) {
			this.state = 'active';
			return this;
		}
		if (this.state === 'active' && this.live) {
			this.live.rerender(<SpinnerLine text={this.currentText} />);
			return this;
		}
		this.live = mountLive(<SpinnerLine text={this.currentText} />);
		this.state = 'active';
		return this;
	}

	private settle(
		icon: string,
		color: keyof typeof chalk,
		text?: string,
	): SpinnerHandle {
		if (text !== undefined) this.currentText = text;
		if (this.state === 'active' && this.live) {
			this.live.unmount();
			this.live = null;
		}
		const colorFn = chalk[color] as (s: string) => string;
		process.stderr.write(`${colorFn(icon)} ${this.currentText}\n`);
		this.state = 'idle';
		return this;
	}

	succeed(text?: string): SpinnerHandle {
		return this.settle('✔', 'green', text);
	}
	fail(text?: string): SpinnerHandle {
		return this.settle('✖', 'red', text);
	}
	warn(text?: string): SpinnerHandle {
		return this.settle('⚠', 'yellow', text);
	}
	info(text?: string): SpinnerHandle {
		return this.settle('ℹ', 'blue', text);
	}
	stop(): SpinnerHandle {
		if (this.state === 'active' && this.live) {
			this.live.unmount();
			this.live = null;
		}
		this.state = 'idle';
		return this;
	}
}

/**
 * Ora-compatible spinner factory backed by Ink. Callers use it exactly like
 * `ora`: create with `spinner(text)`, call `.start()` to begin animating,
 * then `.succeed()/.fail()/.warn()/.info()/.stop()` to settle.
 *
 * The adapter has two states: `idle` (no Ink instance mounted) and `active`
 * (Ink instance animating). Settle operations always tear down the Ink
 * instance and write a single persistent line to stderr; the handle stays
 * usable across further `.start()` calls.
 */
export function spinner(input?: string | SpinnerOptions): SpinnerHandle {
	const text = typeof input === 'string' ? input : (input?.text ?? '');
	const enabled = typeof input === 'string' ? true : (input?.isEnabled ?? true);
	return new SpinnerAdapter(text, enabled);
}
