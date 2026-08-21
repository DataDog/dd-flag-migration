import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { mount, PromptCancelledError } from './mount.js';

export type InputOptions = {
	message: string;
	default?: string;
	hint?: string;
	validate?: (value: string) => true | string | Promise<true | string>;
};

type InputProps = InputOptions & {
	onDone: (value: string) => void;
	onCancel: () => void;
};

export function InputView(props: InputProps): JSX.Element {
	const { exit } = useApp();
	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [validating, setValidating] = useState(false);
	const [submitted, setSubmitted] = useState<string | null>(null);

	useInput((inputChar, key) => {
		if (submitted !== null) return;
		if (key.escape || (key.ctrl && inputChar === 'c')) {
			props.onCancel();
			exit();
			return;
		}
		if (key.return) {
			const effective = value.length > 0 ? value : (props.default ?? '');
			const run = async () => {
				setValidating(true);
				try {
					if (props.validate) {
						const result = await props.validate(effective);
						if (result !== true) {
							setError(typeof result === 'string' ? result : 'Invalid input');
							setValidating(false);
							return;
						}
					}
					setError(null);
					setValidating(false);
					setSubmitted(effective);
					props.onDone(effective);
					exit();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					setValidating(false);
				}
			};
			void run();
			return;
		}
		if (key.backspace || key.delete) {
			setValue(value.slice(0, -1));
			setError(null);
			return;
		}
		if (key.ctrl || key.meta) return;
		if (inputChar && inputChar.length >= 1) {
			// Add all typed characters (paste can supply >1)
			const printable = [...inputChar]
				.filter((c) => c.charCodeAt(0) >= 32)
				.join('');
			if (printable.length > 0) {
				setValue(value + printable);
				setError(null);
			}
		}
	});

	if (submitted !== null) {
		return (
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text color="cyan">{submitted}</Text>
			</Box>
		);
	}

	// Show defaults as an explicit value rather than dim placeholder text. Enter
	// already accepts the default when no characters have been entered.
	const showingDefault = value.length === 0 && props.default !== undefined;
	const shown = value.length > 0 ? value : (props.default ?? '');

	return (
		<Box flexDirection="column">
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text color={showingDefault ? 'cyan' : undefined}>{shown}</Text>
				{validating ? <Text color="gray"> (validating…)</Text> : null}
			</Box>
			{props.hint ? (
				<Box>
					<Text color="gray">{props.hint}</Text>
				</Box>
			) : null}
			{error ? (
				<Box>
					<Text color="red">{`> ${error}`}</Text>
				</Box>
			) : null}
		</Box>
	);
}

export async function input(opts: InputOptions): Promise<string> {
	let resolved = false;
	let value = opts.default ?? '';
	let cancelled = false;
	const { promise } = mount<void>(
		<InputView
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
