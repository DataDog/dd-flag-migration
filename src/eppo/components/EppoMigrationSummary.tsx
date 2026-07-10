import {
	MigrationSummary,
	type MigrationSummaryProps,
} from '../../components/MigrationSummary.js';

export type EppoMigrationSummaryProps = Omit<
	MigrationSummaryProps,
	'detailSections'
>;

export function EppoMigrationSummary(
	props: EppoMigrationSummaryProps,
): JSX.Element {
	return <MigrationSummary {...props} />;
}
