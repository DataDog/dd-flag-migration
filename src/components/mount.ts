import { type Instance, render } from 'ink';
import type { ReactElement } from 'react';

export type MountOptions = {
	stream?: NodeJS.WriteStream;
	stdin?: NodeJS.ReadStream;
};

/**
 * Thrown when the user cancels an interactive prompt (Ctrl+C or Escape).
 * Top-level catch blocks in `src/index.tsx` and `src/evaluate.tsx` translate
 * this into a graceful "Bye!" exit.
 */
export class PromptCancelledError extends Error {
	constructor() {
		super('Prompt cancelled');
		this.name = 'PromptCancelledError';
	}
}

const activeInstances = new Set<Instance>();
const sigintCancellableInstances = new Map<Instance, (error: Error) => void>();
let exitHandlerInstalled = false;
let sigintHandlerInstalled = false;

function installExitHandler(): void {
	if (exitHandlerInstalled) return;
	exitHandlerInstalled = true;
	const cleanup = (): void => {
		for (const inst of activeInstances) {
			try {
				inst.unmount();
			} catch {
				// ignore
			}
		}
		activeInstances.clear();
	};
	process.on('exit', cleanup);
}

function installSigintHandler(): void {
	if (sigintHandlerInstalled) return;
	sigintHandlerInstalled = true;
	process.on('SIGINT', sigintHandler);
}

function uninstallSigintHandlerIfIdle(): void {
	if (!sigintHandlerInstalled || sigintCancellableInstances.size > 0) {
		return;
	}
	sigintHandlerInstalled = false;
	process.removeListener('SIGINT', sigintHandler);
}

function unregisterInstance(instance: Instance): void {
	activeInstances.delete(instance);
	sigintCancellableInstances.delete(instance);
	uninstallSigintHandlerIfIdle();
}

function sigintHandler(): void {
	if (sigintCancellableInstances.size === 0) {
		uninstallSigintHandlerIfIdle();
		process.kill(process.pid, 'SIGINT');
		return;
	}
	for (const [inst, cancel] of sigintCancellableInstances) {
		const error = new PromptCancelledError();
		cancel(error);
		try {
			inst.unmount();
		} catch {
			// ignore
		} finally {
			unregisterInstance(inst);
		}
	}
	sigintCancellableInstances.clear();
	uninstallSigintHandlerIfIdle();
}

function createInstance(
	element: ReactElement,
	options: MountOptions,
	cancelOnSigint?: (error: Error) => void,
): Instance {
	installExitHandler();
	if (cancelOnSigint) installSigintHandler();
	const stream = (options.stream ?? process.stderr) as NodeJS.WriteStream;
	const stdin = (options.stdin ?? process.stdin) as NodeJS.ReadStream;
	const instance = render(element, {
		stdout: stream,
		stderr: process.stderr as NodeJS.WriteStream,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	activeInstances.add(instance);
	if (cancelOnSigint) sigintCancellableInstances.set(instance, cancelOnSigint);
	void instance.waitUntilExit().then(
		() => unregisterInstance(instance),
		() => unregisterInstance(instance),
	);
	const wrappedUnmount = instance.unmount.bind(instance);
	instance.unmount = ((...args: Parameters<typeof wrappedUnmount>) => {
		unregisterInstance(instance);
		return wrappedUnmount(...args);
	}) as typeof instance.unmount;
	return instance;
}

/**
 * Renders an interactive Ink element. The returned promise resolves when the
 * component calls `useApp().exit()` (or exits with an error). Used by prompts
 * and one-shot renders like the header.
 */
export function mount<T = void>(
	element: ReactElement,
	options: MountOptions = {},
): { promise: Promise<T>; unmount: () => void; instance: Instance } {
	// Ink's public render wrapper ignores unmount(error), so keep the
	// cancellation error on the promise we hand to prompt callers.
	let cancel!: (error: Error) => void;
	const cancellationPromise = new Promise<never>((_, reject) => {
		cancel = reject;
	});
	const instance = createInstance(element, options, cancel);
	return {
		promise: Promise.race([
			instance.waitUntilExit() as Promise<T>,
			cancellationPromise,
		]),
		unmount: () => instance.unmount(),
		instance,
	};
}

/**
 * Renders a live Ink element that will be updated over time via `rerender()`.
 * Used by spinners and progress bars.
 */
export function mountLive(
	element: ReactElement,
	options: MountOptions = {},
): {
	rerender: (next: ReactElement) => void;
	unmount: () => void;
	instance: Instance;
} {
	const instance = createInstance(element, options);
	return {
		rerender: (next) => instance.rerender(next),
		unmount: () => instance.unmount(),
		instance,
	};
}

/**
 * Convenience helper: render an Ink element that calls `useApp().exit()` on
 * mount (a fire-and-forget "print this static block" pattern), and resolve
 * once it has exited.
 */
export async function renderStatic(
	element: ReactElement,
	options: MountOptions = {},
): Promise<void> {
	const instance = createInstance(element, options);
	await instance.waitUntilExit();
}
