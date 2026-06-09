import { describe, expect, it } from '@jest/globals';
import { ArgParseError, parseMigrateArgs } from '../src/args.js';

describe('parseMigrateArgs', () => {
	it('defaults to interactive mode', () => {
		const args = parseMigrateArgs([]);
		expect(args.interactive).toBe(true);
		expect(args.dryRun).toBe(false);
		expect(args.noExport).toBe(false);
		expect(args.nonInteractive).toBeUndefined();
	});

	it('parses --dry-run and --datadog-site (equals form)', () => {
		const args = parseMigrateArgs(['--dry-run', '--datadog-site=datadoghq.eu']);
		expect(args.dryRun).toBe(true);
		expect(args.datadogSite).toBe('datadoghq.eu');
	});

	it('parses --datadog-site (space form)', () => {
		const args = parseMigrateArgs(['--datadog-site', 'datadoghq.com']);
		expect(args.datadogSite).toBe('datadoghq.com');
	});

	it('rejects empty --datadog-site value', () => {
		expect(() => parseMigrateArgs(['--datadog-site=  '])).toThrow(
			ArgParseError,
		);
	});

	it('errors on unknown option', () => {
		expect(() => parseMigrateArgs(['--bogus'])).toThrow(/Unknown option/);
	});

	it('parses a full non-interactive LaunchDarkly invocation', () => {
		const args = parseMigrateArgs([
			'--interactive',
			'false',
			'--provider',
			'LaunchDarkly',
			'--project',
			'my-ld',
			'--datadog-site',
			'datadoghq.com',
			'--env-map',
			'Production,Production',
			'--env-map',
			'Staging,QA',
			'--feature-flag',
			'flag-a',
			'--feature-flag',
			'flag-b',
		]);
		expect(args.interactive).toBe(false);
		expect(args.nonInteractive).toEqual({
			provider: 'launchdarkly',
			projectKey: 'my-ld',
			envMap: [
				['Production', 'Production'],
				['Staging', 'QA'],
			],
			flagKeys: ['flag-a', 'flag-b'],
		});
	});

	it('accepts provider names case-insensitively', () => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=EPPO',
			'--datadog-site=datadoghq.com',
			'--env-map=prod,prod',
			'--feature-flag=foo',
		]);
		expect(args.nonInteractive?.provider).toBe('eppo');
	});

	it('rejects unknown provider', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=Optimizely',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--provider must be/);
	});

	it('requires --provider in non-interactive mode', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--provider is required/);
	});

	it('requires at least one --env-map', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--feature-flag=x',
			]),
		).toThrow(/--env-map/);
	});

	it('requires at least one --feature-flag', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
			]),
		).toThrow(/--feature-flag/);
	});

	it('requires --project for LaunchDarkly', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=launchdarkly',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--project is required/);
	});

	it('does NOT require --project for Eppo', () => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
		]);
		expect(args.nonInteractive?.projectKey).toBeUndefined();
	});

	it('requires --datadog-site in non-interactive mode', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--datadog-site is required/);
	});

	it('rejects malformed --env-map (missing comma)', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=invalid',
				'--feature-flag=x',
			]),
		).toThrow(/--env-map must be/);
	});

	it('rejects malformed --env-map (empty side)', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=src,',
				'--feature-flag=x',
			]),
		).toThrow(/--env-map must be/);
	});

	it('accepts --no-export', () => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--no-export',
		]);
		expect(args.noExport).toBe(true);
	});

	it('rejects --no-export=foo (no value flag)', () => {
		expect(() => parseMigrateArgs(['--no-export=true'])).toThrow(
			/does not take a value/,
		);
	});

	it('rejects --interactive without a value', () => {
		expect(() => parseMigrateArgs(['--interactive'])).toThrow(
			/requires a value/,
		);
	});

	it('rejects --interactive=maybe', () => {
		expect(() => parseMigrateArgs(['--interactive=maybe'])).toThrow(
			/expects a boolean/,
		);
	});
});
