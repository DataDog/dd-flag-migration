import {
	MigrationSummary,
	type MigrationSummaryProps,
} from '../../components/MigrationSummary.js';

type RestrictionPolicyFailure = {
	key: string;
	error: string;
};

export type LDMigrationSummaryProps = Omit<
	MigrationSummaryProps,
	'detailSections'
> & {
	restrictionPolicyFailures?: readonly RestrictionPolicyFailure[];
};

export function LDMigrationSummary({
	restrictionPolicyFailures = [],
	...props
}: LDMigrationSummaryProps): JSX.Element {
	return (
		<MigrationSummary
			{...props}
			detailSections={[
				{
					id: 'restriction-policy-failures',
					title: `  ${restrictionPolicyFailures.length} flag(s) migrated but did not have editor team restrictions applied. Reapply manually or rerun the migration.`,
					items: restrictionPolicyFailures.map((failure) => ({
						id: failure.key,
						text: `${failure.key}: ${failure.error}`,
					})),
				},
			]}
		/>
	);
}
