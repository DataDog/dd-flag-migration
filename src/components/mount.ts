import { type Instance, render } from 'ink';
import type { ReactElement } from 'react';

export type MountOptions = {
	stream?: NodeJS.WriteStream;
	stdin?: NodeJS.ReadStream;
};

const activeInstances = new Set<Instance>();
let exitHandlerInstalled = false;

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

function createInstance(
	element: ReactElement,
	options: MountOptions,
): Instance {
	installExitHandler();
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
	const wrappedUnmount = instance.unmount.bind(instance);
	instance.unmount = ((...args: Parameters<typeof wrappedUnmount>) => {
		activeInstances.delete(instance);
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
	const instance = createInstance(element, options);
	return {
		promise: instance.waitUntilExit() as Promise<T>,
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
	const { promise } = mount(element, options);
	await promise;
}
