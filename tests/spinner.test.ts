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

	function stubTTY() {
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
		return setRawMode;
	}

	it('does not put stdin in raw mode when called with a string', () => {
		const setRawMode = stubTTY();
		const spinner = createSpinner('Loading').start();
		spinner.stop();
		expect(setRawMode).not.toHaveBeenCalled();
	});

	it('overrides a caller-supplied discardStdin:true and still does not put stdin in raw mode', () => {
		const setRawMode = stubTTY();
		const spinner = createSpinner({
			text: 'Loading',
			isEnabled: true,
			discardStdin: true,
		}).start();
		spinner.stop();
		expect(setRawMode).not.toHaveBeenCalled();
	});
});
