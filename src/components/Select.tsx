import chalk from 'chalk';
import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { mount, PromptCancelledError } from './mount.js';

export type SelectChoice<T> = {
	name: string;
	value: T;
	short?: string;
	description?: string;
};

export type SelectOptions<T> = {
	message: string;
	choices: SelectChoice<T>[];
	pageSize?: number;
	default?: T;
};

type SelectProps<T> = SelectOptions<T> & {
	onDone: (value: T) => void;
	onCancel: () => void;
};

export function SelectView<T>(props: SelectProps<T>): JSX.Element {
	const { exit } = useApp();
	const initialIndex =
		props.default !== undefined
			? Math.max(
					0,
					props.choices.findIndex((c) => c.value === props.default),
				)
			: 0;
	const [active, setActive] = useState(initialIndex);
	const [done, setDone] = useState<SelectChoice<T> | null>(null);
	const pageSize = props.pageSize ?? 10;

	useInput((_ch, key) => {
		if (done !== null) return;
		if (key.escape) {
			props.onCancel();
			exit();
			return;
		}
		if (key.return) {
			const chosen = props.choices[active];
			if (chosen) {
				setDone(chosen);
				props.onDone(chosen.value);
				exit();
			}
			return;
		}
		if (key.upArrow) {
			setActive(Math.max(0, active - 1));
		} else if (key.downArrow) {
			setActive(Math.min(props.choices.length - 1, active + 1));
		} else if (key.pageUp) {
			setActive(Math.max(0, active - pageSize));
		} else if (key.pageDown) {
			setActive(Math.min(props.choices.length - 1, active + pageSize));
		}
	});

	if (done !== null) {
		return (
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text color="cyan">{done.short ?? done.name}</Text>
			</Box>
		);
	}

	// Windowed view around active
	const start = Math.max(
		0,
		Math.min(
			active - Math.floor(pageSize / 2),
			props.choices.length - pageSize,
		),
	);
	const clampedStart = Math.max(0, start);
	const end = Math.min(props.choices.length, clampedStart + pageSize);
	const items = props.choices.slice(clampedStart, end);

	return (
		<Box flexDirection="column">
			<Box>
				<Text color="green">? </Text>
				<Text bold>{props.message}</Text>
			</Box>
			{items.map((c, i) => {
				const idx = clampedStart + i;
				const isActive = idx === active;
				const cursor = isActive ? chalk.cyan('❯') : ' ';
				const label = isActive ? chalk.cyan(c.name) : c.name;
				return (
					<Box key={idx}>
						<Text>{`${cursor} ${label}`}</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export async function select<T>(opts: SelectOptions<T>): Promise<T> {
	let resolved = false;
	let value: T | undefined;
	let cancelled = false;
	const { promise } = mount<void>(
		<SelectView<T>
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
	return value as T;
}
