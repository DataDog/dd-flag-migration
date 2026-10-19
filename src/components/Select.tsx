import chalk from 'chalk';
import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { mount, PromptCancelledError } from './mount.js';

export type SelectChoice<T> = {
	name: string;
	value: T;
	short?: string;
	description?: string;
	/** Shown dimmed; the cursor skips it and it cannot be selected. */
	disabled?: boolean;
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

/**
 * Nearest enabled index from `from` moving in `step` direction, or `from`
 * itself when every choice that way is disabled.
 */
function enabledIndex<T>(
	choices: SelectChoice<T>[],
	from: number,
	step: 1 | -1,
): number {
	for (let i = from; i >= 0 && i < choices.length; i += step) {
		if (!choices[i]?.disabled) return i;
	}
	return -1;
}

export function SelectView<T>(props: SelectProps<T>): JSX.Element {
	const { exit } = useApp();
	const defaultIndex =
		props.default !== undefined
			? Math.max(
					0,
					props.choices.findIndex((c) => c.value === props.default),
				)
			: 0;
	const initialIndex = Math.max(
		0,
		enabledIndex(props.choices, defaultIndex, 1) === -1
			? enabledIndex(props.choices, defaultIndex, -1)
			: enabledIndex(props.choices, defaultIndex, 1),
	);
	const [active, setActive] = useState(initialIndex);
	const [done, setDone] = useState<SelectChoice<T> | null>(null);
	const pageSize = props.pageSize ?? 10;

	useInput((inputChar, key) => {
		if (done !== null) return;
		if (key.escape || (key.ctrl && inputChar === 'c')) {
			props.onCancel();
			exit();
			return;
		}
		if (key.return) {
			const chosen = props.choices[active];
			if (chosen && !chosen.disabled) {
				setDone(chosen);
				props.onDone(chosen.value);
				exit();
			}
			return;
		}
		const move = (target: number, step: 1 | -1) => {
			const clamped = Math.max(0, Math.min(props.choices.length - 1, target));
			const next = enabledIndex(props.choices, clamped, step);
			if (next !== -1) setActive(next);
		};
		if (key.upArrow) {
			move(active - 1, -1);
		} else if (key.downArrow) {
			move(active + 1, 1);
		} else if (key.pageUp) {
			move(active - pageSize, -1);
		} else if (key.pageDown) {
			move(active + pageSize, 1);
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
				const label = c.disabled
					? chalk.dim(c.name)
					: isActive
						? chalk.cyan(c.name)
						: c.name;
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
