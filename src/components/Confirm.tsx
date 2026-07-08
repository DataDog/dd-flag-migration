import chalk from 'chalk';
import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { mount, PromptCancelledError } from './mount.js';

export type ConfirmOptions = {
	message: string;
	default?: boolean;
};

type ConfirmProps = ConfirmOptions & {
	onDone: (value: boolean) => void;
	onCancel: () => void;
};

export function ConfirmView(props: ConfirmProps): JSX.Element {
	const { exit } = useApp();
	const [answered, setAnswered] = useState<boolean | null>(null);
	const defaultValue = props.default ?? true;

	useInput((inputChar, key) => {
		if (answered !== null) return;
		if (key.escape || (key.ctrl && inputChar === 'c')) {
			setAnswered(false);
			props.onCancel();
			exit();
			return;
		}
		if (key.return) {
			setAnswered(defaultValue);
			props.onDone(defaultValue);
			exit();
			return;
		}
		const ch = inputChar.toLowerCase();
		if (ch === 'y') {
			setAnswered(true);
			props.onDone(true);
			exit();
			return;
		}
		if (ch === 'n') {
			setAnswered(false);
			props.onDone(false);
			exit();
			return;
		}
	});

	const hint = defaultValue ? chalk.dim('(Y/n)') : chalk.dim('(y/N)');

	if (answered !== null) {
		return (
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text color="cyan">{answered ? 'yes' : 'no'}</Text>
			</Box>
		);
	}
	return (
		<Box>
			<Text color="green">? </Text>
			<Text>{props.message} </Text>
			<Text>{hint}</Text>
		</Box>
	);
}

export async function confirm(opts: ConfirmOptions): Promise<boolean> {
	let resolved = false;
	let value: boolean = opts.default ?? true;
	let cancelled = false;
	const { promise } = mount<void>(
		<ConfirmView
			{...opts}
			onDone={(v) => {
				resolved = true;
				value = v;
			}}
			onCancel={() => {
				cancelled = true;
			}}
		/>,
	);
	await promise;
	if (cancelled && !resolved) throw new PromptCancelledError();
	return value;
}
