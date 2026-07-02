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
 * Selectable filter categories shown in the advanced-filter sub-screen.
 * Migration-state categories are derived from each choice's `migrated` flag;
 * all other ids match a choice's `categories` field.
 */
export const MIGRATED_FILTER_ID = 'previously-migrated';
export const NOT_MIGRATED_FILTER_ID = 'not-yet-migrated';

export type FilterCategoryScope =
	| 'any environment'
	| 'all environments'
	| 'selected environments';

export type FilterCategory = {
	id: string;
	label: string;
	scope?: FilterCategoryScope;
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
	 * LaunchDarkly passes statuses plus migration-state categories; Eppo passes
	 * only migration-state categories.
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
 * When no category filter is selected, no category filter is applied. When every
 * category is selected, the result is also unfiltered. Partial selections narrow
 * the list to items that belong to at least one selected category.
 *
 * Exported for unit testing.
 */
export function itemMatchesFilters(
	item: { migrated: boolean; categories?: string[] },
	activeFilters: ReadonlySet<string>,
	filterCategories: readonly FilterCategory[],
): boolean {
	if (filterCategories.length === 0) return true;

	const configuredIds = new Set(filterCategories.map((c) => c.id));
	const selectedIds = [...activeFilters].filter((id) => configuredIds.has(id));
	if (
		selectedIds.length === 0 ||
		selectedIds.length === filterCategories.length
	) {
		return true;
	}

	const itemFilterIds = new Set(
		(item.categories ?? []).filter((id) => configuredIds.has(id)),
	);

	if (configuredIds.has(MIGRATED_FILTER_ID) && item.migrated) {
		itemFilterIds.add(MIGRATED_FILTER_ID);
	}
	if (configuredIds.has(NOT_MIGRATED_FILTER_ID) && !item.migrated) {
		itemFilterIds.add(NOT_MIGRATED_FILTER_ID);
	}

	return selectedIds.some((id) => itemFilterIds.has(id));
}

const theme = {
	icon: {
		checked: chalk.green(figures.circleFilled),
		unchecked: figures.circle,
		cursor: figures.pointer,
	},
};

const scopeStyles: Record<FilterCategoryScope, (value: string) => string> = {
	'any environment': chalk.cyan,
	'all environments': chalk.yellow,
	'selected environments': chalk.magenta,
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
		// Active (checked) category filters. Empty means no category filters.
		const [activeFilters, setActiveFilters] = useState<Set<string>>(
			() => new Set(),
		);
		// Draft filter ids while the advanced-filter screen is open.
		const [draftFilters, setDraftFilters] = useState<Set<string>>(
			() => new Set(),
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
		 * Apply the draft filter selection and return to the list, unchecking any
		 * items that no longer match so selection stays consistent with visibility.
		 */
		const applyFilterSelection = (nextFilters: ReadonlySet<string>) => {
			setActiveFilters(new Set(nextFilters));
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

		const cancelFilterSelection = () => {
			setDraftFilters(new Set(activeFilters));
			setMode('list');
			setActive(0);
		};

		useKeypress((key) => {
			// ─── Advanced-filter sub-screen ─────────────────────────────────
			if (mode === 'filter') {
				if (isEnterKey(key)) {
					applyFilterSelection(draftFilters);
					return;
				}
				if (key.name === 'escape') {
					cancelFilterSelection();
					return;
				}
				if (isUpKey(key)) {
					setFilterActive(Math.max(0, safeFilterActive - 1));
				} else if (isDownKey(key)) {
					setFilterActive(
						Math.min(filterCategories.length - 1, safeFilterActive + 1),
					);
				} else if (key.ctrl && key.name === 'a') {
					const allFiltersSelected = filterCategories.every((cat) =>
						draftFilters.has(cat.id),
					);
					setDraftFilters(
						allFiltersSelected
							? new Set()
							: new Set(filterCategories.map((cat) => cat.id)),
					);
				} else if (isSpaceKey(key)) {
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
					setDraftFilters(new Set(activeFilters));
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
			const rows = filterCategories.map((cat, idx) => {
				const isActive = idx === safeFilterActive;
				const checkbox = draftFilters.has(cat.id)
					? theme.icon.checked
					: theme.icon.unchecked;
				const cursor = isActive ? theme.icon.cursor : ' ';
				const name = isActive ? chalk.cyan(cat.label) : cat.label;
				const scope = cat.scope ? scopeStyles[cat.scope](cat.scope) : undefined;
				const meta = [scope, chalk.dim(cat.description)]
					.filter(Boolean)
					.join(` ${chalk.dim('·')} `);
				return `${cursor}${checkbox} ${name} ${chalk.dim('·')} ${meta}`;
			});
			const filterHelp = chalk.dim(
				'↑↓ navigate  ·  space toggle  ·  ctrl+a toggle all  ·  esc cancel filter changes  ·  ⏎ apply filter selection',
			);
			return (
				[
					`${prefix} ${builtTheme.style.message('Filter flags by category:', 'idle')}`,
					filterSummary,
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
