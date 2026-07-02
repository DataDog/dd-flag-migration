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

/**
 * A selectable filter category shown in the advanced-filter sub-screen. The
 * `previously-migrated` category is special-cased (it maps to each choice's
 * `migrated` flag rather than its `category`); all other ids match a choice's
 * `category` field.
 */
export const MIGRATED_FILTER_ID = 'previously-migrated';

export type FilterCategory = {
	id: string;
	label: string;
	description: string;
};

type Choice<T> = {
	name: string;
	value: T;
	checked?: boolean;
	migrated?: boolean;
	/**
	 * Lifecycle category ids (e.g. LD statuses) this item belongs to. A flag
	 * can belong to more than one when its environments differ. Matched against
	 * the active filters: the item is visible if any of its categories is
	 * active. Omit or leave empty when no lifecycle filtering applies.
	 */
	categories?: string[];
};

type Config<T> = {
	message: string;
	choices: Choice<T>[];
	pageSize?: number;
	/**
	 * Categories shown in the advanced-filter sub-screen (opened with Tab).
	 * When omitted or empty, Tab is disabled and no filtering sub-screen is
	 * available. Providers supply only the categories relevant to them (e.g.
	 * LaunchDarkly passes all statuses plus previously-migrated; Eppo passes
	 * only previously-migrated).
	 */
	filterCategories?: FilterCategory[];
};

type NormalizedChoice<T> = {
	name: string;
	value: T;
	checked: boolean;
	migrated: boolean;
	categories: string[];
};

/**
 * Whether an item is visible given the set of active (checked) filter ids.
 *
 * An item is visible when:
 *  - its lifecycle `category` is active (or it has no category / no category
 *    filters are configured), AND
 *  - if it is a previously-migrated item, the `previously-migrated` filter is
 *    active.
 *
 * Exported for unit testing.
 */
export function itemMatchesFilters(
	item: { migrated: boolean; categories?: string[] },
	activeFilters: ReadonlySet<string>,
	filterCategories: readonly FilterCategory[],
): boolean {
	// Previously-migrated gate: if the migrated filter exists and is inactive,
	// hide migrated items.
	const hasMigratedFilter = filterCategories.some(
		(c) => c.id === MIGRATED_FILTER_ID,
	);
	if (
		hasMigratedFilter &&
		item.migrated &&
		!activeFilters.has(MIGRATED_FILTER_ID)
	) {
		return false;
	}

	// Lifecycle gate: only applies when lifecycle categories are configured and
	// the item declares at least one of them. The item is visible if any of its
	// lifecycle categories is currently active (union semantics).
	const lifecycleIds = new Set(
		filterCategories.map((c) => c.id).filter((id) => id !== MIGRATED_FILTER_ID),
	);
	const itemLifecycle = (item.categories ?? []).filter((c) =>
		lifecycleIds.has(c),
	);
	if (itemLifecycle.length > 0) {
		const anyActive = itemLifecycle.some((c) => activeFilters.has(c));
		if (!anyActive) return false;
	}

	return true;
}

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

		const filterCategories = config.filterCategories ?? [];

		const [filterText, setFilterText] = useState('');
		const [allItems, setAllItems] = useState<NormalizedChoice<T>[]>(() =>
			config.choices.map((c) => ({
				name: c.name,
				value: c.value,
				checked: c.checked ?? false,
				migrated: c.migrated ?? false,
				categories: c.categories ?? [],
			})),
		);
		const [active, setActive] = useState(0);
		const [status, setStatus] = useState<'idle' | 'done' | 'escaped'>('idle');
		// Which screen is showing: the flag list, or the advanced-filter picker.
		const [mode, setMode] = useState<'list' | 'filter'>('list');
		// Active (checked) filter ids. All categories start checked.
		const [activeFilters, setActiveFilters] = useState<Set<string>>(
			() => new Set(filterCategories.map((c) => c.id)),
		);
		// Cursor position within the filter sub-screen.
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

		/**
		 * Return from the filter sub-screen to the list, unchecking any items
		 * that no longer match the active filters so selection stays consistent
		 * with what is visible.
		 */
		const returnToList = (nextFilters: ReadonlySet<string>) => {
			setAllItems(
				allItems.map((item) =>
					item.checked &&
					!itemMatchesFilters(item, nextFilters, filterCategories)
						? { ...item, checked: false }
						: item,
				),
			);
			setMode('list');
			setActive(0);
		};

		useKeypress((key) => {
			// ─── Advanced-filter sub-screen ─────────────────────────────────
			if (mode === 'filter') {
				if (isEnterKey(key) || key.name === 'tab' || key.name === 'escape') {
					returnToList(activeFilters);
					return;
				}
				if (isUpKey(key)) {
					setFilterActive(Math.max(0, safeFilterActive - 1));
				} else if (isDownKey(key)) {
					setFilterActive(
						Math.min(filterCategories.length - 1, safeFilterActive + 1),
					);
				} else if (isSpaceKey(key)) {
					const target = filterCategories[safeFilterActive];
					if (target) {
						const next = new Set(activeFilters);
						if (next.has(target.id)) next.delete(target.id);
						else next.add(target.id);
						setActiveFilters(next);
					}
				}
				return;
			}

			// ─── Flag list ──────────────────────────────────────────────────
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
			} else if (key.name === 'tab') {
				if (filterCategories.length > 0) {
					setMode('filter');
					setFilterActive(0);
				}
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
		const filterToggle =
			totalFilters > 0
				? activeCount < totalFilters
					? chalk.yellow(
							`  ·  tab: filters (${activeCount}/${totalFilters} on)`,
						)
					: chalk.dim(`  ·  tab: filters (${totalFilters})`)
				: '';
		const filterLine =
			chalk.cyan('Filter: ') +
			(filterText ? chalk.bold(filterText) : chalk.dim('type to filter…')) +
			'  ' +
			visibleBadge +
			'  ·  ' +
			countBadge +
			filterToggle;

		// usePagination is a hook and must be called on every render, even when
		// the filter sub-screen is showing.
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

		// ─── Advanced-filter sub-screen ────────────────────────────────────
		if (mode === 'filter') {
			const rows = filterCategories.map((cat, idx) => {
				const isActive = idx === safeFilterActive;
				const checkbox = activeFilters.has(cat.id)
					? theme.icon.checked
					: theme.icon.unchecked;
				const cursor = isActive ? theme.icon.cursor : ' ';
				const name = isActive ? chalk.cyan(cat.label) : chalk.bold(cat.label);
				return `${cursor}${checkbox} ${name} ${chalk.dim(`· ${cat.description}`)}`;
			});
			const filterHelp = chalk.dim(
				'↑↓ navigate  ·  space toggle  ·  ⏎ return to flag selection',
			);
			return (
				[
					`${prefix} ${builtTheme.style.message('Filter flags by status:', 'idle')}`,
					rows.join('\n'),
					filterHelp,
				]
					.filter(Boolean)
					.join('\n') + cursorHide
			);
		}

		const helpTip = chalk.dim(
			'↑↓/pgup/pgdn navigate  ·  space select  ·  ctrl+a select all' +
				(totalFilters > 0 ? '  ·  tab filters' : '') +
				'  ·  esc back  ·  ⏎ confirm',
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
					migrated: false,
					categories: [],
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
