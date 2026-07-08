import { describe, expect, it } from '@jest/globals';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { EvaluationSummary } from '../src/components/EvaluationSummary.js';
import { HelpScreen } from '../src/components/HelpScreen.js';
import { PermissionsError } from '../src/components/PermissionsError.js';
import { ResultsTable, type TableRow } from '../src/components/ResultsTable.js';

const rows: TableRow[] = [
	{
		key: 'checkout-flag',
		testResults: [
			{
				testCase: { label: 'default', attributes: {} },
				providerResult: 'on',
				ddResult: 'on',
				ddStatus: 'assigned',
				match: true,
				providerStatus: 'found',
			},
			{
				testCase: { label: 'vip-user', attributes: { plan: 'vip' } },
				providerResult: 'off',
				ddResult: 'on',
				ddStatus: 'assigned',
				match: false,
				providerStatus: 'found',
			},
		],
		migrationStatus: 'partial',
		ddEnabled: true,
		partialDetails: ['Could not enable (1 env(s))'],
		inMigrationFile: true,
		ddMigrationMetadata: {
			provider: 'launchdarkly',
			flag_key: 'checkout-flag',
		},
	},
	{
		key: 'manual-flag',
		testResults: [
			{
				testCase: { label: 'qa-user', attributes: { role: 'qa' } },
				providerResult: 'control',
				ddResult: 'treatment',
				ddStatus: 'assigned',
				match: false,
				providerStatus: 'found',
			},
		],
		migrationStatus: 'not-in-migration-file',
		ddEnabled: null,
		partialDetails: [],
		inMigrationFile: false,
	},
];

describe('structured static views', () => {
	it('renders the help screen', () => {
		const { lastFrame } = render(<HelpScreen />);
		expect(stripAnsi(lastFrame() ?? '')).toMatchInlineSnapshot(`
"
╔══════════════════════════════════════════╗
║   🚩  Feature Flag Migration Tool  🚩    ║
║            Migrate to Datadog            ║
╚══════════════════════════════════════════╝

Usage: dd-flag-migration <command> [options]

Global options:
  -V, --version               Print version and exit
  -h, --help                  Show this help message

Commands:
  migrate    Migrate feature flags from Eppo or LaunchDarkly into Datadog
  evaluate   Compare flag evaluations side-by-side after migrating

Options for migrate:
  --dry-run                    Preview changes without creating flags
  --datadog-site=<site>        Set the Datadog site non-interactively
  --interactive=<bool>         Set to false to run without prompts (default: true)
  --export=<bool>              Non-interactive only: export results to xlsx (default: false)

Required when --interactive=false:
  Output is a JSON result document on stdout; status logs go to stderr.
  --provider <Eppo|LaunchDarkly>   Source feature flag provider (case-insensitive)
  --env-map <source,target>        Map a source env to a Datadog env (repeatable; ≥1)
  --feature-flag <key>[,<dd-key>]  Flag key to migrate; LaunchDarkly may include a Datadog rename
(repeatable; ≥1)
  --project <key>                  LaunchDarkly project key (LaunchDarkly only)

Options for evaluate:
  --use-latest-migration       Skip migration file selector; use most recent
  --test-subject-id=<id>       Set the subject ID non-interactively
  --flag-environment=<name>    Set the Datadog environment non-interactively
  --datadog-site=<site>        Set the Datadog site non-interactively
  --csv=<path>                 Path to a CSV file for advanced evaluation
  --show-table                 Force table output even for large result sets

Examples:
  $ dd-flag-migration migrate
  $ dd-flag-migration migrate --dry-run
  $ dd-flag-migration migrate --interactive=false \\
      --provider LaunchDarkly --project my-ld-project \\
      --datadog-site datadoghq.com \\
      --env-map Production,Production --env-map Staging,QA \\
      --feature-flag flag-one --feature-flag flag-two
  $ dd-flag-migration evaluate
  $ dd-flag-migration evaluate --use-latest-migration --datadog-site=datadoghq.com
"
`);
	});

	it('renders missing permissions', () => {
		const { lastFrame } = render(
			<PermissionsError missing={['feature_flag_config_read', 'teams_read']} />,
		);
		expect(stripAnsi(lastFrame() ?? '')).toMatchInlineSnapshot(`
"Missing required Datadog permissions:
  • feature_flag_config_read
  • teams_read

Ensure your Datadog application key has the required permissions and try again.
"
`);
	});

	it('renders evaluation results table', () => {
		const { lastFrame } = render(
			<ResultsTable rows={rows} providerLabel="LaunchDarkly" />,
		);
		expect(stripAnsi(lastFrame() ?? '')).toMatchInlineSnapshot(`
"
Flag Key                         │ Test Case                  │ LaunchDarkly   │ Datadog        │
Migration    │ Enabled
─────────────────────────────────┼────────────────────────────┼────────────────┼────────────────┼───
───────────┼───────────
checkout-flag                    │ default                    │ on             │ on             │ ⚠
 Partial    │ ✓ Enabled
                                 │ vip-user                   │ off            │ on             │
           │
                                   ⚠ Could not enable (1 env(s))
─────────────────────────────────┼────────────────────────────┼────────────────┼────────────────┼───
───────────┼───────────
manual-flag                      │ qa-user                    │ control        │ treatment      │ —
           │ —
                                   ℹ Flag not in selected migration file — possible targeting rule
drift — Manually created in Datadog
─────────────────────────────────┼────────────────────────────┼────────────────┼────────────────┼───
───────────┼───────────

  Migration:
  • ✓ Created — flag was successfully created during migration
  • ⚠ Partial — flag was created but could not be enabled in some environments
  • ✗ Failed — flag creation itself failed
  • — Skipped — flag type is not supported (BANDIT, LAYER)
"
`);
	});

	it('renders evaluation summary', () => {
		const { lastFrame } = render(<EvaluationSummary rows={rows} />);
		expect(stripAnsi(lastFrame() ?? '')).toMatchInlineSnapshot(`
"Summary:
  1 match  2 differ  0 error
  Across 2 flag(s), 3 evaluation(s) total

  2 flag(s) returned different values in at least one test case.
  This may be expected if flag configurations differ between providers.
"
`);
	});
});
