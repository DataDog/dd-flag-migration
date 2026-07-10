import chalk from 'chalk';
import { Box, Text } from 'ink';

export type MigrationSummaryCounts = {
	created: number;
	synced: number;
	skipped: number;
	errored: number;
	enabled: number;
};

export type MigrationSummaryFailure = {
	key: string;
	error: string;
};

export type MigrationSummaryEnableFailure = {
	key: string;
	env: string;
	error: string;
};

export type MigrationSummaryDetailSection = {
	id: string;
	title: string;
	items: readonly MigrationSummaryDetailItem[];
};

export type MigrationSummaryDetailItem = {
	id: string;
	text: string;
};

export type MigrationSummaryProps = {
	dryRun: boolean;
	counts: MigrationSummaryCounts;
	failures?: readonly MigrationSummaryFailure[];
	enableFailures?: readonly MigrationSummaryEnableFailure[];
	detailSections?: readonly MigrationSummaryDetailSection[];
};

type LineItem = { id: string; text: string };

function buildCountsLine(
	dryRun: boolean,
	counts: MigrationSummaryCounts,
): string {
	const syncedSummary =
		counts.synced > 0
			? `  ${chalk.hex('#632CA6')(String(counts.synced))} ${dryRun ? 'would be synced' : 'synced'}`
			: '';
	const enabledSummary =
		!dryRun && counts.enabled > 0
			? `  ${chalk.hex('#632CA6')(String(counts.enabled))} enabled`
			: '';
	return (
		`  ${chalk.green(String(counts.created))} ${dryRun ? 'would be created' : 'created'}` +
		`${syncedSummary}  ${chalk.yellow(String(counts.skipped))} skipped  ` +
		`${chalk.red(String(counts.errored))} failed${enabledSummary}`
	);
}

function buildMigrationSummaryLines({
	dryRun,
	counts,
	failures = [],
	enableFailures = [],
	detailSections = [],
}: MigrationSummaryProps): LineItem[] {
	const lines: LineItem[] = [
		{ id: 'blank-start', text: ' ' },
		{
			id: 'title',
			text: chalk.bold(dryRun ? 'Dry run complete!' : 'Migration complete!'),
		},
		{ id: 'counts', text: buildCountsLine(dryRun, counts) },
	];

	if (failures.length > 0) {
		lines.push({ id: 'blank-failures', text: ' ' });
		failures.forEach((failure, index) => {
			lines.push({
				id: `failure-${failure.key}-${index}`,
				text: `  ${chalk.red('✗')} ${failure.key}: ${failure.error}`,
			});
		});
	}

	if (enableFailures.length > 0) {
		lines.push({ id: 'blank-enable-failures', text: ' ' });
		lines.push({
			id: 'enable-failures-title',
			text: chalk.yellow(
				'  Flags created but could not be enabled in some environments:',
			),
		});
		enableFailures.forEach((failure, index) => {
			lines.push({
				id: `enable-failure-${failure.key}-${failure.env}-${index}`,
				text: `  ${chalk.yellow('⚠')} ${failure.key} / ${failure.env}: ${failure.error}`,
			});
		});
	}

	detailSections.forEach((section) => {
		if (section.items.length === 0) return;
		lines.push({ id: `blank-${section.id}`, text: ' ' });
		lines.push({
			id: `${section.id}-title`,
			text: chalk.yellow(section.title),
		});
		section.items.forEach((item) => {
			lines.push({
				id: `${section.id}-${item.id}`,
				text: `  ${chalk.yellow('⚠')} ${item.text}`,
			});
		});
	});

	return lines;
}

export function MigrationSummary(props: MigrationSummaryProps): JSX.Element {
	return (
		<Box flexDirection="column">
			{buildMigrationSummaryLines(props).map((item) => (
				<Box key={item.id}>
					<Text>{item.text}</Text>
				</Box>
			))}
		</Box>
	);
}
