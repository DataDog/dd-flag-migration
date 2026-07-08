import chalk from 'chalk';
import { Box, Text, useApp } from 'ink';
import { useEffect } from 'react';
import {
	type ClassifiedRow,
	classifyRow,
	type RowColor,
} from '../evaluate/result-classifier.js';
import type { DDStatus, MigrationMetadata, TestCase } from '../types.js';

export type MigrationStatus =
	| 'created'
	| 'partial'
	| 'failed'
	| 'skipped'
	| 'unknown'
	| 'not-in-migration-file';

export interface FlagTestResult {
	testCase: TestCase;
	providerResult: string;
	ddResult: string;
	ddStatus: DDStatus;
	match: boolean;
	error?: string;
	providerStatus: 'found' | 'not-found' | 'error' | 'not-evaluated';
}

export interface TableRow {
	key: string;
	testResults: FlagTestResult[];
	migrationStatus: MigrationStatus;
	ddEnabled: boolean | null;
	partialDetails: string[];
	inMigrationFile: boolean;
	ddMigrationMetadata?: MigrationMetadata;
}

type ResultsTableProps = {
	rows: TableRow[];
	providerLabel: string;
};

type LineItem = { id: string; text: string };

const COL_FLAG = 32;
const COL_TEST = 26;
const COL_EVAL = 14;
const COL_MIG = 12;
const COL_ENA = 10;

const pad = (s: string, len: number): string =>
	s.length >= len ? `${s.slice(0, len - 1)}…` : s.padEnd(len);

const sep = chalk.gray(' │ ');

const divider = chalk.gray(
	'─'.repeat(COL_FLAG) +
		'─┼─' +
		'─'.repeat(COL_TEST) +
		'─┼─' +
		'─'.repeat(COL_EVAL) +
		'─┼─' +
		'─'.repeat(COL_EVAL) +
		'─┼─' +
		'─'.repeat(COL_MIG) +
		'─┼─' +
		'─'.repeat(COL_ENA),
);

function migrationCol(status: MigrationStatus): string {
	switch (status) {
		case 'created':
			return chalk.green('✓ Created'.padEnd(COL_MIG));
		case 'partial':
			return chalk.yellow('⚠ Partial'.padEnd(COL_MIG));
		case 'failed':
			return chalk.red('✗ Failed'.padEnd(COL_MIG));
		case 'skipped':
			return chalk.gray('— Skipped'.padEnd(COL_MIG));
		default:
			return chalk.gray('—'.padEnd(COL_MIG));
	}
}

function enabledCol(enabled: boolean | null): string {
	if (enabled === null) return chalk.gray('—'.padEnd(COL_ENA));
	return enabled
		? chalk.green('✓ Enabled'.padEnd(COL_ENA))
		: chalk.gray('✗ Disabled'.padEnd(COL_ENA));
}

function chalkForColor(color: RowColor, s: string): string {
	switch (color) {
		case 'match':
		case 'notMigrated':
			return chalk.green(s);
		case 'diff':
		case 'drift':
			return chalk.yellow(s);
		case 'error':
			return chalk.red(s);
		default:
			return chalk.dim(s);
	}
}

function buildResultsTableLines(
	rows: TableRow[],
	providerLabel: string,
): LineItem[] {
	const items: LineItem[] = [];
	const isLD = providerLabel.toLowerCase() !== 'eppo';
	const header =
		chalk.bold(pad('Flag Key', COL_FLAG)) +
		sep +
		chalk.bold(pad('Test Case', COL_TEST)) +
		sep +
		chalk.bold(pad(providerLabel, COL_EVAL)) +
		sep +
		chalk.bold(pad('Datadog', COL_EVAL)) +
		sep +
		chalk.bold(pad('Migration', COL_MIG)) +
		sep +
		chalk.bold('Enabled');

	items.push({ id: 'blank-start', text: ' ' });
	items.push({ id: 'header', text: header });
	items.push({ id: 'divider-start', text: divider });

	rows.forEach((row, rowIndex) => {
		const classifiedResults: ClassifiedRow[] = [];
		row.testResults.forEach((tr, resultIndex) => {
			const isFirst = resultIndex === 0;
			const flagKeyStr = isFirst
				? pad(row.key, COL_FLAG)
				: ' '.repeat(COL_FLAG);
			const testLabelStr = pad(tr.testCase.label, COL_TEST);

			const classified = classifyRow({
				flagKey: row.key,
				inMigrationFile: row.inMigrationFile,
				ddStatus: tr.ddStatus,
				providerStatus: tr.providerStatus,
				providerError: tr.error,
				match: tr.match,
				ddMigrationMetadata: row.ddMigrationMetadata,
				provider: isLD ? 'launchdarkly' : 'eppo',
			});
			classifiedResults.push(classified);

			const providerDisplay = chalkForColor(
				classified.color,
				pad(tr.providerResult || '—', COL_EVAL),
			);
			const ddDisplay = chalkForColor(
				classified.color,
				pad(tr.ddResult || '—', COL_EVAL),
			);

			const migDisplay = isFirst
				? row.inMigrationFile
					? migrationCol(row.migrationStatus)
					: chalk.dim('—'.padEnd(COL_MIG))
				: ' '.repeat(COL_MIG);
			const enaDisplay = isFirst
				? enabledCol(row.ddEnabled)
				: ' '.repeat(COL_ENA);

			items.push({
				id: `row-${rowIndex}-${resultIndex}`,
				text:
					flagKeyStr +
					sep +
					testLabelStr +
					sep +
					providerDisplay +
					sep +
					ddDisplay +
					sep +
					migDisplay +
					sep +
					enaDisplay,
			});
		});

		if (row.partialDetails.length > 0) {
			items.push({
				id: `partial-${rowIndex}`,
				text:
					' '.repeat(COL_FLAG + 3) +
					chalk.yellow(`⚠ ${row.partialDetails.join(' | ')}`),
			});
		}

		const notes = [
			...new Set(
				classifiedResults
					.map((classified) => classified.notes)
					.filter((notes): notes is string => notes.length > 0),
			),
		];
		if (notes.length > 0) {
			items.push({
				id: `notes-${rowIndex}`,
				text: ' '.repeat(COL_FLAG + 3) + chalk.dim(`ℹ ${notes.join(' | ')}`),
			});
		}

		items.push({ id: `divider-${rowIndex}`, text: divider });
	});

	items.push({ id: 'blank-legend', text: ' ' });
	items.push({ id: 'legend-title', text: chalk.gray('  Migration:') });
	items.push({
		id: 'legend-created',
		text:
			'  • ' +
			chalk.green('✓ Created') +
			chalk.gray(' — flag was successfully created during migration'),
	});
	items.push({
		id: 'legend-partial',
		text:
			'  • ' +
			chalk.yellow('⚠ Partial') +
			chalk.gray(
				' — flag was created but could not be enabled in some environments',
			),
	});
	items.push({
		id: 'legend-failed',
		text:
			'  • ' +
			chalk.red('✗ Failed') +
			chalk.gray(' — flag creation itself failed'),
	});
	items.push({
		id: 'legend-skipped',
		text:
			'  • ' +
			chalk.gray('— Skipped') +
			chalk.gray(' — flag type is not supported (BANDIT, LAYER)'),
	});
	items.push({ id: 'blank-end', text: ' ' });

	return items;
}

export function ResultsTable({
	rows,
	providerLabel,
}: ResultsTableProps): JSX.Element {
	const { exit } = useApp();
	useEffect(() => {
		exit();
	}, [exit]);

	return (
		<Box flexDirection="column">
			{buildResultsTableLines(rows, providerLabel).map((item) => (
				<Box key={item.id}>
					<Text wrap="truncate">{item.text}</Text>
				</Box>
			))}
		</Box>
	);
}
