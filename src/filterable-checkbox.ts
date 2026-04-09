import { cursorHide } from '@inquirer/ansi';
import {
	createPrompt,
	isBackspaceKey,
	isDownKey,
	isEnterKey,
	isSpaceKey,
	isUpKey,
	makeTheme,
	useKeypress,
	useMemo,
	usePagination,
	usePrefix,
	useState,
} from '@inquirer/core';
import figures from '@inquirer/figures';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

type Choice<T> = {
	name: string;
	value: T;
	checked?: boolean;
};

type Config<T> = {
	message: string;
	choices: Choice<T>[];
	pageSize?: number;
};

type NormalizedChoice<T> = {
	name: string;
	value: T;
	checked: boolean;
};

const theme = {
	icon: {
		checked: chalk.green(figures.circleFilled),
		unchecked: figures.circle,
		cursor: figures.pointer,
	},
};

const _filterableCheckbox = createPrompt(
	<T>(config: Config<T>, done: (value: T[]) => void) => {
		const { pageSize = 10 } = config;
		const builtTheme = makeTheme(theme, (config as { theme?: object }).theme);
		const prefix = usePrefix({ theme: builtTheme });

		const [filterText, setFilterText] = useState('');
		const [allItems, setAllItems] = useState<NormalizedChoice<T>[]>(() =>
			config.choices.map((c) => ({
				name: c.name,
				value: c.value,
				checked: c.checked ?? false,
			})),
		);
		const [active, setActive] = useState(0);
		const [status, setStatus] = useState<'idle' | 'done' | 'escaped'>('idle');

		const filteredItems = useMemo(() => {
			const lower = filterText.toLowerCase();
			if (!lower) return allItems;
			return allItems.filter((item) =>
				stripAnsi(item.name).toLowerCase().includes(lower),
			);
		}, [allItems, filterText]);

		const safeActive = Math.min(active, Math.max(0, filteredItems.length - 1));

		useKeypress((key) => {
			if (isEnterKey(key)) {
				setStatus('done');
				done(allItems.filter((i) => i.checked).map((i) => i.value));
				return;
			}

			if (isUpKey(key)) {
				setActive(Math.max(0, safeActive - 1));
			} else if (isDownKey(key)) {
				setActive(Math.min(filteredItems.length - 1, safeActive + 1));
			} else if (key.name === 'pageup') {
				setActive(Math.max(0, safeActive - pageSize));
			} else if (key.name === 'pagedown') {
				setActive(Math.min(filteredItems.length - 1, safeActive + pageSize));
			} else if (isSpaceKey(key)) {
				const target = filteredItems[safeActive];
				if (target) {
					setAllItems(
						allItems.map((item) =>
							item.value === target.value
								? { ...item, checked: !item.checked }
								: item,
						),
					);
				}
			} else if (key.ctrl && key.name === 'a') {
				// Select all visible (filtered) items, or deselect all if all are already selected
				const visibleValues = new Set(filteredItems.map((i) => i.value));
				const allVisible = filteredItems.every((i) => i.checked);
				setAllItems(
					allItems.map((item) =>
						visibleValues.has(item.value)
							? { ...item, checked: !allVisible }
							: item,
					),
				);
			} else if (key.name === 'escape') {
				setStatus('escaped');
				done(null as unknown as T[]);
				return;
			} else if (isBackspaceKey(key) && (key as { meta?: boolean }).meta) {
				setFilterText(filterText.replace(/\S+\s*$/, ''));
				setActive(0);
			} else if (isBackspaceKey(key)) {
				setFilterText(filterText.slice(0, -1));
				setActive(0);
			} else {
				const { meta, sequence } = key as { meta?: boolean; sequence?: string };
				if (
					!key.ctrl &&
					!meta &&
					sequence &&
					sequence.length === 1 &&
					sequence.charCodeAt(0) >= 32
				) {
					setFilterText(filterText + sequence);
					setActive(0);
				}
			}
		});

		const message = builtTheme.style.message(
			config.message,
			status === 'escaped' ? 'idle' : status,
		);

		if (status === 'done') {
			const selected = allItems.filter((i) => i.checked);
			const answer = selected.length
				? chalk.cyan(selected.map((i) => i.name).join(', '))
				: chalk.dim('(none)');
			return `${prefix} ${message} ${answer}`;
		}

		if (status === 'escaped') {
			return `${prefix} ${message} ${chalk.dim('(cancelled)')}`;
		}

		const selectedCount = allItems.filter((i) => i.checked).length;
		const countBadge =
			selectedCount > 0
				? chalk.green(`${selectedCount} selected`)
				: chalk.dim('0 selected');
		const filterLine =
			chalk.cyan('Filter: ') +
			(filterText ? chalk.bold(filterText) : chalk.dim('type to filter…')) +
			'  ' +
			countBadge;

		const page = usePagination({
			items: filteredItems,
			active: safeActive,
			renderItem({ item, isActive }) {
				const checkbox = item.checked
					? theme.icon.checked
					: theme.icon.unchecked;
				const cursor = isActive ? theme.icon.cursor : ' ';
				const label = isActive ? chalk.cyan(item.name) : item.name;
				return `${cursor}${checkbox} ${label}`;
			},
			pageSize,
			loop: false,
		});

		const helpTip = chalk.dim(
			'↑↓/pgup/pgdn navigate  ·  space select  ·  ctrl+a select all  ·  esc back  ·  ⏎ confirm',
		);

		const emptyMsg =
			filteredItems.length === 0 ? chalk.yellow('  No matches') : '';

		return (
			[`${prefix} ${message}`, filterLine, emptyMsg || page, helpTip]
				.filter(Boolean)
				.join('\n') + cursorHide
		);
	},
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const filterableCheckbox = _filterableCheckbox as unknown as <T>(
	config: Config<T>,
) => Promise<T[] | null>;

// ─── Single-select variant ──────────────────────────────────────────────────

const _filterableSelect = createPrompt(
	<T>(config: Config<T>, done: (value: T | null) => void) => {
		const { pageSize = 10 } = config;
		const builtTheme = makeTheme(theme, (config as { theme?: object }).theme);
		const prefix = usePrefix({ theme: builtTheme });

		const [filterText, setFilterText] = useState('');
		const items = useMemo<NormalizedChoice<T>[]>(
			() =>
				config.choices.map((c) => ({
					name: c.name,
					value: c.value,
					checked: false,
				})),
			[],
		);
		const [active, setActive] = useState(0);
		const [status, setStatus] = useState<'idle' | 'done' | 'escaped'>('idle');

		const filteredItems = useMemo(() => {
			const lower = filterText.toLowerCase();
			if (!lower) return items;
			return items.filter((item) =>
				stripAnsi(item.name).toLowerCase().includes(lower),
			);
		}, [items, filterText]);

		const safeActive = Math.min(active, Math.max(0, filteredItems.length - 1));

		useKeypress((key) => {
			if (isEnterKey(key)) {
				const selected = filteredItems[safeActive];
				setStatus('done');
				done(selected ? selected.value : null);
				return;
			}

			if (isUpKey(key)) {
				setActive(Math.max(0, safeActive - 1));
			} else if (isDownKey(key)) {
				setActive(Math.min(filteredItems.length - 1, safeActive + 1));
			} else if (key.name === 'pageup') {
				setActive(Math.max(0, safeActive - pageSize));
			} else if (key.name === 'pagedown') {
				setActive(Math.min(filteredItems.length - 1, safeActive + pageSize));
			} else if (key.name === 'escape') {
				setStatus('escaped');
				done(null);
				return;
			} else if (isBackspaceKey(key) && (key as { meta?: boolean }).meta) {
				setFilterText(filterText.replace(/\S+\s*$/, ''));
				setActive(0);
			} else if (isBackspaceKey(key)) {
				setFilterText(filterText.slice(0, -1));
				setActive(0);
			} else {
				const { meta, sequence } = key as { meta?: boolean; sequence?: string };
				if (
					!key.ctrl &&
					!meta &&
					sequence &&
					sequence.length === 1 &&
					sequence.charCodeAt(0) >= 32
				) {
					setFilterText(filterText + sequence);
					setActive(0);
				}
			}
		});

		const message = builtTheme.style.message(
			config.message,
			status === 'escaped' ? 'idle' : status,
		);

		if (status === 'done') {
			const selected = filteredItems[safeActive];
			const answer = selected ? chalk.cyan(selected.name) : chalk.dim('(none)');
			return `${prefix} ${message} ${answer}`;
		}

		if (status === 'escaped') {
			return `${prefix} ${message} ${chalk.dim('(cancelled)')}`;
		}

		const filterLine =
			chalk.cyan('Filter: ') +
			(filterText ? chalk.bold(filterText) : chalk.dim('type to filter…'));

		const page = usePagination({
			items: filteredItems,
			active: safeActive,
			renderItem({ item, isActive }) {
				const cursor = isActive ? theme.icon.cursor : ' ';
				const label = isActive ? chalk.cyan(item.name) : item.name;
				return `${cursor} ${label}`;
			},
			pageSize,
			loop: false,
		});

		const helpTip = chalk.dim(
			'↑↓/pgup/pgdn navigate  ·  esc back  ·  ⏎ select',
		);

		const emptyMsg =
			filteredItems.length === 0 ? chalk.yellow('  No matches') : '';

		return (
			[`${prefix} ${message}`, filterLine, emptyMsg || page, helpTip]
				.filter(Boolean)
				.join('\n') + cursorHide
		);
	},
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const filterableSelect = _filterableSelect as unknown as <T>(
	config: Config<T>,
) => Promise<T | null>;
