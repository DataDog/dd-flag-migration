import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

const select = jest.fn<(...args: unknown[]) => Promise<string>>();
const eppoWorkflow = jest.fn<(...args: unknown[]) => Promise<null>>();
const ldWorkflow = jest.fn<(...args: unknown[]) => Promise<null>>();
const permissions = jest.fn<(...args: unknown[]) => Promise<string[]>>();
const site = jest.fn<() => Promise<string>>();
jest.unstable_mockModule('../src/components/Select.js', () => ({ select }));
jest.unstable_mockModule('../src/components/mount.js', () => ({
	renderStatic: async () => {},
	PromptCancelledError: class extends Error {},
}));
jest.unstable_mockModule('../src/datadog/api.js', () => ({
	fetchCurrentUserPermissions: permissions,
}));
jest.unstable_mockModule('../src/datadog/orgs.js', () => ({
	requireDatadogOrgPair: jest.fn(),
	assertDistinctDatadogOrgs: jest.fn(),
}));
jest.unstable_mockModule('../src/datadog/org-permissions.js', () => ({
	checkDatadogOrgPermissions: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/prompt-for-datadog-site.js', () => ({
	promptForDatadogSite: site,
}));
jest.unstable_mockModule('../src/migration-status/eppo.js', () => ({
	runEppoMigrationStatusWorkflow: eppoWorkflow,
}));
jest.unstable_mockModule('../src/migration-status/index.js', () => ({
	runMigrationStatusWorkflow: ldWorkflow,
}));
jest.unstable_mockModule('../src/org-diff/index.js', () => ({
	runOrgDiffWorkflow: jest.fn(),
}));

async function run() {
	await import('../src/migration-status.js');
	await new Promise<void>((resolve) => setImmediate(resolve));
}
const originalEnv = { ...process.env };
const originalArgs = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
	jest.resetModules();
	jest.clearAllMocks();
	process.argv = ['node', 'migration-status'];
	process.exitCode = undefined;
	process.env = { ...originalEnv, DD_API_KEY: 'api', DD_APP_KEY: 'app' };
	delete process.env.EPPO_API_KEY;
	delete process.env.LAUNCHDARKLY_API_KEY;
	jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
	jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
	jest.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('Missing credentials');
	});
	jest.spyOn(console, 'log').mockImplementation(() => {});
	jest.spyOn(console, 'error').mockImplementation(() => {});
	select.mockResolvedValue('eppo');
	site.mockResolvedValue('datadoghq.com');
	permissions.mockResolvedValue([
		'feature_flag_config_read',
		'feature_flag_environment_config_read',
	]);
	eppoWorkflow.mockResolvedValue(null);
	ldWorkflow.mockResolvedValue(null);
});
afterEach(() => {
	process.env = { ...originalEnv };
	process.argv = originalArgs;
	process.exitCode = originalExitCode;
	jest.restoreAllMocks();
});

describe('migration-status command', () => {
	it('enables Eppo and requires no LaunchDarkly key', async () => {
		process.env.EPPO_API_KEY = 'eppo-key';
		await run();
		expect(select).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: expect.arrayContaining([
					expect.objectContaining({ name: 'Eppo → Datadog', value: 'eppo' }),
				]),
			}),
		);
		expect(eppoWorkflow).toHaveBeenCalledWith(
			'eppo-key',
			'api',
			'app',
			'datadoghq.com',
		);
		expect(ldWorkflow).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});
	it('requires the Eppo API key after provider selection', async () => {
		await run();
		expect(select).toHaveBeenCalled();
		expect(eppoWorkflow).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(process.stderr.write).toHaveBeenCalledWith(
			expect.stringContaining('EPPO_API_KEY'),
		);
	});
	it('retains LaunchDarkly routing without requiring Eppo credentials', async () => {
		select.mockResolvedValue('launchdarkly');
		process.env.LAUNCHDARKLY_API_KEY = 'ld-key';
		await run();
		expect(ldWorkflow).toHaveBeenCalledWith(
			'ld-key',
			'api',
			'app',
			'datadoghq.com',
		);
		expect(eppoWorkflow).not.toHaveBeenCalled();
	});
	it('requires only read permissions, and refuses missing permissions', async () => {
		process.env.EPPO_API_KEY = 'eppo-key';
		permissions.mockResolvedValue(['feature_flag_config_read']);
		await run();
		expect(eppoWorkflow).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
	it('documents Eppo in help without requiring credentials', async () => {
		process.argv.push('--help');
		await run();
		expect(select).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining('Select Eppo environments and flags'),
		);
	});
});
