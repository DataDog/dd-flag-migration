import chalk from 'chalk';
import { Box, Text, useApp, useInput } from 'ink';
import { useMemo, useState } from 'react';
import stripAnsi from 'strip-ansi';
import { mount, PromptCancelledError } from './mount.js';

export type FilterableSelectChoice<T> = {
	name: string;
	value: T;
};

export type FilterableSelectOptions<T> = {
	message: string;
	choices: FilterableSelectChoice<T>[];
	pageSize?: number;
};

type Props<T> = FilterableSelectOptions<T> & {
	onDone: (value: T) => void;
	onCancel: () => void;
};

export function FilterableSelectView<T>(props: Props<T>): JSX.Element {
	const { exit } = useApp();
	const pageSize = props.pageSize ?? 10;
	const [filterText, setFilterText] = useState('');
	const [active, setActive] = useState(0);
	const [status, setStatus] = useState<'idle' | 'done' | 'escaped'>('idle');
	const [selectedName, setSelectedName] = useState<string | null>(null);

	const items = props.choices;
	const filteredItems = useMemo(() => {
		const lower = filterText.toLowerCase();
		if (!lower) return items;
		return items.filter((item) =>
			stripAnsi(item.name).toLowerCase().includes(lower),
		);
	}, [items, filterText]);
	const safeActive = Math.min(active, Math.max(0, filteredItems.length - 1));

	useInput((inputChar, key) => {
		if (status !== 'idle') return;
		if (key.ctrl && inputChar === 'c') {
			setStatus('escaped');
			props.onCancel();
			exit(new PromptCancelledError());
			return;
		}
		if (key.escape) {
			setStatus('escaped');
			props.onCancel();
			exit();
			return;
		}
		if (key.return) {
			const selected = filteredItems[safeActive];
			if (selected) {
				setSelectedName(selected.name);
				setStatus('done');
				props.onDone(selected.value);
				exit();
			} else {
				setStatus('escaped');
				props.onCancel();
				exit();
			}
			return;
		}
		if (key.upArrow) {
			setActive(Math.max(0, safeActive - 1));
		} else if (key.downArrow) {
			setActive(Math.min(filteredItems.length - 1, safeActive + 1));
		} else if (key.pageUp) {
			setActive(Math.max(0, safeActive - pageSize));
		} else if (key.pageDown) {
			setActive(Math.min(filteredItems.length - 1, safeActive + pageSize));
		} else if (key.backspace || key.delete) {
			if (key.meta) {
				setFilterText(filterText.replace(/\S+\s*$/, ''));
			} else {
				setFilterText(filterText.slice(0, -1));
			}
			setActive(0);
		} else if (!key.ctrl && !key.meta && inputChar) {
			const printable = [...inputChar]
				.filter((c) => c.charCodeAt(0) >= 32)
				.join('');
			if (printable.length > 0) {
				setFilterText(filterText + printable);
				setActive(0);
			}
		}
	});

	if (status === 'done') {
		return (
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text>
					{selectedName ? chalk.cyan(selectedName) : chalk.dim('(none)')}
				</Text>
			</Box>
		);
	}
	if (status === 'escaped') {
		return (
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text>{chalk.dim('(cancelled)')}</Text>
			</Box>
		);
	}

	const filterLine =
		chalk.cyan('Filter: ') +
		(filterText ? chalk.bold(filterText) : chalk.dim('type to filter…'));

	const helpTip = chalk.dim('↑↓/pgup/pgdn navigate  ·  esc back  ·  ⏎ select');

	const start = Math.max(
		0,
		Math.min(
			safeActive - Math.floor(pageSize / 2),
			Math.max(0, filteredItems.length - pageSize),
		),
	);
	const end = Math.min(filteredItems.length, start + pageSize);
	const page = filteredItems.slice(start, end);

	return (
		<Box flexDirection="column">
			<Box>
				<Text color="green">? </Text>
				<Text bold>{props.message}</Text>
			</Box>
			<Text>{filterLine}</Text>
			{filteredItems.length === 0 ? (
				<Text>{chalk.yellow('  No matches')}</Text>
			) : (
				page.map((item, i) => {
					const idx = start + i;
					const isActive = idx === safeActive;
					const cursor = isActive ? chalk.cyan('❯') : ' ';
					const label = isActive ? chalk.cyan(item.name) : item.name;
					return <Text key={idx}>{`${cursor} ${label}`}</Text>;
				})
			)}
			<Text>{helpTip}</Text>
		</Box>
	);
}

export async function filterableSelect<T>(
	opts: FilterableSelectOptions<T>,
): Promise<T | null> {
	let resolved: T | undefined;
	let cancelled = false;
	const { promise } = mount<void>(
		<FilterableSelectView<T>
			{...opts}
			onDone={(v) => {
				resolved = v;
			}}
			onCancel={() => {
				cancelled = true;
			}}
		/>,
	);
	await promise;
	if (cancelled) return null;
	return resolved as T;
}
