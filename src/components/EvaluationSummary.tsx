import chalk from 'chalk';
import { Box, Text, useApp } from 'ink';
import { useEffect } from 'react';
import type { TableRow } from './ResultsTable.js';

type EvaluationSummaryProps = {
	rows: TableRow[];
};

type LineItem = { id: string; text: string };

function buildEvaluationSummaryLines(rows: TableRow[]): LineItem[] {
	const allResults = rows.flatMap((r) => r.testResults);
	const matched = allResults.filter((r) => r.match).length;
	const differed = allResults.filter(
		(r) => !r.match && !r.error && r.ddStatus === 'assigned',
	).length;
	const notAssigned = allResults.filter(
		(r) => r.ddStatus === 'not-assigned',
	).length;
	const notInDD = allResults.filter((r) => r.ddStatus === 'not-in-dd').length;
	const errored = allResults.filter((r) => Boolean(r.error)).length;

	const flagsWithDiff = rows.filter((r) =>
		r.testResults.some(
			(t) => !t.match && !t.error && t.ddStatus === 'assigned',
		),
	).length;

	let summary = `  ${chalk.green(String(matched))} match  ${chalk.yellow(String(differed))} differ  ${chalk.red(String(errored))} error`;
	if (notAssigned > 0)
		summary += `  ${chalk.dim(String(notAssigned))} not assigned`;
	if (notInDD > 0) summary += `  ${chalk.red(String(notInDD))} not in Datadog`;

	const lines: LineItem[] = [
		{ id: 'title', text: chalk.bold('Summary:') },
		{ id: 'counts', text: summary },
		{
			id: 'total',
			text: chalk.gray(
				`  Across ${rows.length} flag(s), ${allResults.length} evaluation(s) total`,
			),
		},
		{ id: 'blank-after-total', text: ' ' },
	];

	if (flagsWithDiff > 0) {
		lines.push({
			id: 'diff-note',
			text: chalk.yellow(
				`  ${flagsWithDiff} flag(s) returned different values in at least one test case.\n` +
					'  This may be expected if flag configurations differ between providers.',
			),
		});
		lines.push({ id: 'blank-after-diff', text: ' ' });
	}

	return lines;
}

export function EvaluationSummary({
	rows,
}: EvaluationSummaryProps): JSX.Element {
	const { exit } = useApp();
	useEffect(() => {
		exit();
	}, [exit]);

	return (
		<Box flexDirection="column">
			{buildEvaluationSummaryLines(rows).map((item) => (
				<Box key={item.id}>
					<Text>{item.text}</Text>
				</Box>
			))}
		</Box>
	);
}
