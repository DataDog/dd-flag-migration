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
		const output = stripAnsi(lastFrame() ?? '');
		expect(output).toContain('Feature Flag Migration Tool');
		expect(output).toContain('migrate');
		expect(output).toContain('evaluate');
		expect(output).toContain('advanced-permissions');
		expect(output).toContain('--dry-run');
		expect(output).toContain('--provider');
		expect(output).toContain('--env-map');
		expect(output).toContain('--feature-flag');
	});

	it('renders missing permissions', () => {
		const { lastFrame } = render(
			<PermissionsError missing={['feature_flag_config_read', 'teams_read']} />,
		);
		const output = stripAnsi(lastFrame() ?? '');
		expect(output).toContain('Missing required Datadog permissions');
		expect(output).toContain('feature_flag_config_read');
		expect(output).toContain('teams_read');
	});

	it('renders evaluation results table', () => {
		const { lastFrame } = render(
			<ResultsTable rows={rows} providerLabel="LaunchDarkly" />,
		);
		const output = stripAnsi(lastFrame() ?? '');
		expect(output).toContain('checkout-flag');
		expect(output).toContain('manual-flag');
		expect(output).toContain('default');
		expect(output).toContain('vip-user');
		expect(output).toContain('qa-user');
		expect(output).toContain('Could not enable (1 env(s))');
		expect(output).toContain('LaunchDarkly');
	});

	it('renders evaluation summary', () => {
		const { lastFrame } = render(<EvaluationSummary rows={rows} />);
		const output = stripAnsi(lastFrame() ?? '');
		expect(output).toContain('1 match');
		expect(output).toContain('2 differ');
		expect(output).toContain('0 error');
		expect(output).toContain('2 flag(s)');
		expect(output).toContain('3 evaluation(s)');
	});
});
