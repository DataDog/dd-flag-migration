import { describe, expect, it } from '@jest/globals';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { MigrationSummary } from '../src/components/MigrationSummary.js';
import {
	formatVariantLabel,
	VariantCounts,
} from '../src/components/VariantCounts.js';
import { EppoMigrationSummary } from '../src/eppo/components/EppoMigrationSummary.js';
import { LDMigrationSummary } from '../src/launchdarkly/components/LDMigrationSummary.js';

describe('migration summary views', () => {
	it('renders the shared migration summary sections', () => {
		const { lastFrame } = render(
			<MigrationSummary
				dryRun={false}
				counts={{
					created: 2,
					synced: 1,
					skipped: 3,
					errored: 1,
					enabled: 4,
				}}
				failures={[{ key: 'broken-flag', error: 'request failed' }]}
				enableFailures={[
					{ key: 'partial-flag', env: 'Production', error: 'forbidden' },
				]}
				detailSections={[
					{
						id: 'extra',
						title: '  Extra warning section',
						items: [{ id: 'extra-1', text: 'extra-flag: needs attention' }],
					},
				]}
			/>,
		);

		expect(stripAnsi(lastFrame() ?? '')).toMatchInlineSnapshot(`
"
Migration complete!
  2 created  1 synced  3 skipped  1 failed  4 enabled

  ✗ broken-flag: request failed

  Flags created but could not be enabled in some environments:
  ⚠ partial-flag / Production: forbidden

  Extra warning section
  ⚠ extra-flag: needs attention"
`);
	});

	it('renders the Eppo migration summary wrapper', () => {
		const { lastFrame } = render(
			<EppoMigrationSummary
				dryRun={true}
				counts={{
					created: 0,
					synced: 2,
					skipped: 1,
					errored: 0,
					enabled: 0,
				}}
				failures={[]}
				enableFailures={[]}
			/>,
		);

		expect(stripAnsi(lastFrame() ?? '')).toMatchInlineSnapshot(`
"
Dry run complete!
  0 would be created  2 would be synced  1 skipped  0 failed"
`);
	});

	it('renders the LaunchDarkly restriction policy summary section', () => {
		const { lastFrame } = render(
			<LDMigrationSummary
				dryRun={false}
				counts={{
					created: 1,
					synced: 0,
					skipped: 0,
					errored: 0,
					enabled: 0,
				}}
				failures={[]}
				enableFailures={[]}
				restrictionPolicyFailures={[
					{ key: 'locked-flag', error: 'policy rejected' },
				]}
			/>,
		);

		const output = stripAnsi(lastFrame() ?? '');
		expect(output).toContain('Migration complete!');
		expect(output).toContain('  1 created  0 skipped  0 failed');
		expect(output.replace(/\s+/g, ' ')).toContain(
			'1 flag(s) migrated but did not have editor team restrictions applied. Reapply manually or rerun the migration.',
		);
		expect(output).toContain('  ⚠ locked-flag: policy rejected');
	});

	it('renders and formats variant counts', () => {
		const { lastFrame } = render(
			<VariantCounts counts={{ added: 1, updated: 2, deleted: 3 }} />,
		);

		expect(stripAnsi(lastFrame() ?? '')).toBe(
			', 1 variant(s) added, 2 variant(s) updated, 3 variant(s) deleted',
		);
		expect(formatVariantLabel({ added: 0, updated: 0, deleted: 0 })).toBe('');
	});
});
