import ora, { type Options, type Ora } from 'ora';

/**
 * Ora discards stdin by default by putting it into raw mode. That can make
 * Ctrl+C unreliable while a spinner is active, especially in non-interactive
 * migrations where the user expects the terminal interrupt to stop the run.
 */
export function createSpinner(options?: string | Options): Ora {
	if (typeof options === 'string') {
		return ora({ text: options, discardStdin: false });
	}
	return ora({ ...options, discardStdin: false });
}
