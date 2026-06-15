import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createSpinner } from '../src/spinner.js';

describe('createSpinner', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
	const originalSetRawMode = Object.getOwnPropertyDescriptor(
		process.stdin,
		'setRawMode',
	);

	afterEach(() => {
		jest.restoreAllMocks();
		if (originalIsTTY) {
			Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
		} else {
			delete (process.stdin as { isTTY?: boolean }).isTTY;
		}
		if (originalSetRawMode) {
			Object.defineProperty(process.stdin, 'setRawMode', originalSetRawMode);
		} else {
			delete (process.stdin as { setRawMode?: (enabled: boolean) => void })
				.setRawMode;
		}
	});

	it('does not put stdin in raw mode while a spinner runs', () => {
		const setRawMode = jest.fn();
		Object.defineProperty(process.stdin, 'isTTY', {
			value: true,
			configurable: true,
		});
		Object.defineProperty(process.stdin, 'setRawMode', {
			value: setRawMode,
			configurable: true,
		});
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);

		const spinner = createSpinner({
			text: 'Loading',
			isEnabled: true,
			discardStdin: true,
		}).start();
		spinner.stop();

		expect(setRawMode).not.toHaveBeenCalled();
	});
});
