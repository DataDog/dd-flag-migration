import chalk from 'chalk';
import { Box, Text, useApp, useInput } from 'ink';
import { useMemo, useState } from 'react';
import stripAnsi from 'strip-ansi';
import {
	type FilterCategory,
	type FilterCategoryScope,
	itemMatchesFilters,
} from './filter-matching.js';
import { mount, PromptCancelledError } from './mount.js';

export type FilterableChoice<T> = {
	name: string;
	value: T;
	checked?: boolean;
	migrated?: boolean;
	categories?: string[];
};

export type FilterableCheckboxOptions<T> = {
	message: string;
	choices: FilterableChoice<T>[];
	pageSize?: number;
	filterCategories?: FilterCategory[];
};

type NormalizedChoice<T> = {
	name: string;
	value: T;
	checked: boolean;
	migrated: boolean;
	categories: string[];
};

const scopeStyles: Record<FilterCategoryScope, (value: string) => string> = {
	'any environment': chalk.cyan,
	'all environments': chalk.yellow,
	'selected environments': chalk.magenta,
	flag: chalk.blue,
};

type Props<T> = FilterableCheckboxOptions<T> & {
	onDone: (values: T[]) => void;
	onCancel: () => void;
};

export function FilterableCheckboxView<T>(props: Props<T>): JSX.Element {
	const { exit } = useApp();
	const pageSize = props.pageSize ?? 10;
	const filterCategories = props.filterCategories ?? [];

	const [filterText, setFilterText] = useState('');
	const [allItems, setAllItems] = useState<NormalizedChoice<T>[]>(() =>
		props.choices.map((c) => ({
			name: c.name,
			value: c.value,
			checked: c.checked ?? false,
			migrated: c.migrated ?? false,
			categories: c.categories ?? [],
		})),
	);
	const [active, setActive] = useState(0);
	const [status, setStatus] = useState<'idle' | 'done' | 'escaped'>('idle');
	const [mode, setMode] = useState<'list' | 'filter'>('list');
	const [activeFilters, setActiveFilters] = useState<Set<string>>(
		() => new Set(),
	);
	const [draftFilters, setDraftFilters] = useState<Set<string>>(
		() => new Set(),
	);
	const [filterActive, setFilterActive] = useState(0);

	const filteredItems = useMemo(() => {
		const lower = filterText.toLowerCase();
		const base = allItems.filter((item) =>
			itemMatchesFilters(item, activeFilters, filterCategories),
		);
		if (!lower) return base;
		return base.filter((item) =>
			stripAnsi(item.name).toLowerCase().includes(lower),
		);
	}, [allItems, filterText, activeFilters, filterCategories]);

	const safeActive = Math.min(active, Math.max(0, filteredItems.length - 1));
	const safeFilterActive = Math.min(
		filterActive,
		Math.max(0, filterCategories.length - 1),
	);

	const applyFilterSelection = (nextFilters: ReadonlySet<string>) => {
		setActiveFilters(new Set(nextFilters));
		setAllItems(
			allItems.map((item) =>
				item.checked && !itemMatchesFilters(item, nextFilters, filterCategories)
					? { ...item, checked: false }
					: item,
			),
		);
		setMode('list');
		setActive(0);
	};

	const cancelFilterSelection = () => {
		setDraftFilters(new Set(activeFilters));
		setMode('list');
		setActive(0);
	};

	useInput((inputChar, key) => {
		if (status !== 'idle') return;
		if (key.ctrl && inputChar === 'c') {
			setStatus('escaped');
			props.onCancel();
			exit(new PromptCancelledError());
			return;
		}

		// ── Advanced-filter sub-screen ─────────────────────────────
		if (mode === 'filter') {
			if (key.return) {
				applyFilterSelection(draftFilters);
				return;
			}
			if (key.escape) {
				cancelFilterSelection();
				return;
			}
			if (key.upArrow) {
				setFilterActive(Math.max(0, safeFilterActive - 1));
			} else if (key.downArrow) {
				setFilterActive(
					Math.min(filterCategories.length - 1, safeFilterActive + 1),
				);
			} else if (key.ctrl && inputChar === 'a') {
				const allFiltersSelected = filterCategories.every((cat) =>
					draftFilters.has(cat.id),
				);
				setDraftFilters(
					allFiltersSelected
						? new Set()
						: new Set(filterCategories.map((cat) => cat.id)),
				);
			} else if (inputChar === ' ') {
				const target = filterCategories[safeFilterActive];
				if (target) {
					const next = new Set(draftFilters);
					if (next.has(target.id)) next.delete(target.id);
					else next.add(target.id);
					setDraftFilters(next);
				}
			}
			return;
		}

		// ── Flag list ──────────────────────────────────────────────
		if (key.return) {
			setStatus('done');
			props.onDone(allItems.filter((i) => i.checked).map((i) => i.value));
			exit();
			return;
		}
		if (key.escape) {
			setStatus('escaped');
			props.onCancel();
			exit();
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
		} else if (inputChar === ' ') {
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
		} else if (key.ctrl && inputChar === 'a') {
			const visibleValues = new Set(filteredItems.map((i) => i.value));
			const allVisible = filteredItems.every((i) => i.checked);
			setAllItems(
				allItems.map((item) =>
					visibleValues.has(item.value)
						? { ...item, checked: !allVisible }
						: item,
				),
			);
		} else if (key.tab) {
			if (filterCategories.length > 0) {
				setDraftFilters(new Set(activeFilters));
				setMode('filter');
				setFilterActive(0);
			}
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
		const selected = allItems.filter((i) => i.checked);
		const answer =
			selected.length > 0
				? chalk.cyan(selected.map((i) => i.name).join(', '))
				: chalk.dim('(none)');
		return (
			<Box>
				<Text color="green">? </Text>
				<Text>{props.message} </Text>
				<Text>{answer}</Text>
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

	// ── Filter sub-screen render ───────────────────────────────
	if (mode === 'filter') {
		const draftMatchCount = allItems.filter((item) =>
			itemMatchesFilters(item, draftFilters, filterCategories),
		).length;
		const draftActiveCount = filterCategories.filter((c) =>
			draftFilters.has(c.id),
		).length;
		const filterSummaryText =
			draftActiveCount === 0
				? `${draftMatchCount} of ${allItems.length} flags visible with no category filters`
				: draftActiveCount === filterCategories.length
					? `${draftMatchCount} of ${allItems.length} flags visible with all category filters`
					: `${draftMatchCount} of ${allItems.length} flags match current filter selection`;
		const filterSummary =
			draftMatchCount === allItems.length
				? chalk.dim(filterSummaryText)
				: chalk.yellow(filterSummaryText);
		const filterNote = chalk.dim(
			'Categories combine with OR — a flag shows if it matches any checked category.',
		);
		const filterHelp = chalk.dim(
			'↑↓ navigate  ·  space toggle  ·  ctrl+a toggle all  ·  esc cancel filter changes  ·  ⏎ apply filter selection',
		);
		return (
			<Box flexDirection="column">
				<Box>
					<Text color="green">? </Text>
					<Text bold>Filter flags by category:</Text>
				</Box>
				<Text>{filterSummary}</Text>
				<Text>{filterNote}</Text>
				{filterCategories.map((cat, idx) => {
					const isActive = idx === safeFilterActive;
					const checkbox = draftFilters.has(cat.id) ? chalk.green('◉') : '◯';
					const cursor = isActive ? chalk.cyan('❯') : ' ';
					const name = isActive ? chalk.cyan(cat.label) : cat.label;
					const scope = cat.scope
						? scopeStyles[cat.scope](cat.scope)
						: undefined;
					const meta = [scope, chalk.dim(cat.description)]
						.filter(Boolean)
						.join(` ${chalk.dim('·')} `);
					return (
						<Text
							key={cat.id}
						>{`${cursor}${checkbox} ${name} ${chalk.dim('·')} ${meta}`}</Text>
					);
				})}
				<Text>{filterHelp}</Text>
			</Box>
		);
	}

	// ── List render ────────────────────────────────────────────
	const selectedCount = allItems.filter((i) => i.checked).length;
	const visibleCount = filteredItems.length;
	const visibleBadge =
		visibleCount === allItems.length
			? chalk.dim(`${visibleCount} visible`)
			: chalk.yellow(`${visibleCount} of ${allItems.length} visible`);
	const countBadge =
		selectedCount > 0
			? chalk.green(`${selectedCount} selected`)
			: chalk.dim('0 selected');
	const totalFilters = filterCategories.length;
	const activeCount = filterCategories.filter((c) =>
		activeFilters.has(c.id),
	).length;
	const filterState =
		activeCount === 0
			? 'none'
			: activeCount === totalFilters
				? 'all'
				: `${activeCount}/${totalFilters} on`;
	const filterToggle =
		totalFilters > 0
			? activeCount === 0 || activeCount === totalFilters
				? chalk.dim(`  ·  tab: filters (${filterState})`)
				: chalk.yellow(`  ·  tab: filters (${filterState})`)
			: '';
	const filterLine =
		chalk.cyan('Filter: ') +
		(filterText ? chalk.bold(filterText) : chalk.dim('type to filter…')) +
		'  ' +
		visibleBadge +
		'  ·  ' +
		countBadge +
		filterToggle;

	const helpTip = chalk.dim(
		'↑↓/pgup/pgdn navigate  ·  space select  ·  ctrl+a select all' +
			(totalFilters > 0 ? '  ·  tab filters' : '') +
			'  ·  esc back  ·  ⏎ confirm',
	);

	// Windowed pagination around safeActive
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
					const checkbox = item.checked ? chalk.green('◉') : '◯';
					const cursor = isActive ? chalk.cyan('❯') : ' ';
					const label = isActive ? chalk.cyan(item.name) : item.name;
					return <Text key={idx}>{`${cursor}${checkbox} ${label}`}</Text>;
				})
			)}
			<Text>{helpTip}</Text>
		</Box>
	);
}

export async function filterableCheckbox<T>(
	opts: FilterableCheckboxOptions<T>,
): Promise<T[] | null> {
	let resolved: T[] | null = null;
	let cancelled = false;
	const { promise } = mount<void>(
		<FilterableCheckboxView<T>
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
	return resolved;
}
