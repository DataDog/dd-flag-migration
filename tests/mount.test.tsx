import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Text, useApp } from 'ink';
import { useEffect } from 'react';
import {
	mount,
	PromptCancelledError,
	renderStatic,
} from '../src/components/mount.js';
import { spinner as createSpinner } from '../src/components/Spinner.js';

function ExitOnMount(): JSX.Element {
	const { exit } = useApp();
	useEffect(() => {
		exit();
	}, [exit]);
	return <Text>Done</Text>;
}

describe('mount SIGINT handling', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	function muteInkOutput() {
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
	}

	function appSigintHandlers(): NodeJS.SignalsListener[] {
		return process
			.listeners('SIGINT')
			.filter(
				(listener): listener is NodeJS.SignalsListener =>
					listener.name === 'sigintHandler',
			);
	}

	it('does not install a SIGINT handler for passive live UI', () => {
		muteInkOutput();
		const before = appSigintHandlers().length;
		const activeSpinner = createSpinner('Loading').start();
		try {
			expect(appSigintHandlers()).toHaveLength(before);
		} finally {
			activeSpinner.stop();
		}
		expect(appSigintHandlers()).toHaveLength(before);
	});

	it('installs SIGINT handling only while a cancellable mount is active', async () => {
		muteInkOutput();
		const { promise, unmount } = mount(<Text>Prompt</Text>);
		try {
			expect(appSigintHandlers()).toHaveLength(1);
		} finally {
			unmount();
			await promise;
		}
		expect(appSigintHandlers()).toHaveLength(0);
	});

	it('removes SIGINT handling when a cancellable mount exits itself', async () => {
		muteInkOutput();
		const { promise } = mount(<ExitOnMount />);
		expect(appSigintHandlers()).toHaveLength(1);

		await promise;

		expect(appSigintHandlers()).toHaveLength(0);
	});

	it('does not install a prompt SIGINT handler for static renders', async () => {
		muteInkOutput();
		await renderStatic(<ExitOnMount />);
		expect(appSigintHandlers()).toHaveLength(0);
	});

	it('rejects a cancellable mount on SIGINT and removes its handler', async () => {
		muteInkOutput();
		const { promise } = mount(<Text>Prompt</Text>);
		const [sigintHandler] = appSigintHandlers();
		expect(sigintHandler).toBeDefined();

		sigintHandler('SIGINT');

		await expect(promise).rejects.toBeInstanceOf(PromptCancelledError);
		expect(appSigintHandlers()).toHaveLength(0);
	});
});
