import { describe, expect, it } from '@jest/globals';
import { ArgParseError, parseMigrateArgs } from '../src/args.js';

describe('parseMigrateArgs', () => {
	it('defaults to interactive mode', () => {
		const args = parseMigrateArgs([]);
		expect(args.interactive).toBe(true);
		expect(args.dryRun).toBe(false);
		expect(args.doExport).toBe(false);
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
			'--non-interactive',
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
			'--team-restrictions=true',
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
			applyTeamRestrictions: true,
		});
	});

	it('accepts provider names case-insensitively', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=EPPO',
			'--datadog-site=datadoghq.com',
			'--env-map=prod,prod',
			'--feature-flag=foo',
			'--team-restrictions=true',
		]);
		expect(args.nonInteractive?.provider).toBe('eppo');
	});

	it('rejects unknown provider', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
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
				'--non-interactive',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--provider is required/);
	});

	it('requires at least one --env-map', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--feature-flag=x',
			]),
		).toThrow(/--env-map/);
	});

	it('requires at least one --feature-flag', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
			]),
		).toThrow(/--feature-flag/);
	});

	it('requires --project for LaunchDarkly', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
				'--provider=launchdarkly',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--project is required/);
	});

	it('does NOT require --project for Eppo', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--team-restrictions=true',
		]);
		expect(args.nonInteractive?.projectKey).toBeUndefined();
	});

	it('requires --datadog-site in non-interactive mode', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
				'--provider=eppo',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--datadog-site is required/);
	});

	it('rejects malformed --env-map (missing comma)', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
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
				'--non-interactive',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=src,',
				'--feature-flag=x',
			]),
		).toThrow(/--env-map must be/);
	});

	it('accepts --export=true', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--export=true',
			'--team-restrictions=true',
		]);
		expect(args.doExport).toBe(true);
	});

	it('accepts --export=false', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--export=false',
			'--team-restrictions=true',
		]);
		expect(args.doExport).toBe(false);
	});

	it('defaults doExport to false when --export is omitted', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--team-restrictions=true',
		]);
		expect(args.doExport).toBe(false);
	});

	it('bare --export means true', () => {
		const args = parseMigrateArgs(['--export']);
		expect(args.doExport).toBe(true);
	});

	it('rejects --export=maybe', () => {
		expect(() => parseMigrateArgs(['--export=maybe'])).toThrow(
			/expects a boolean/,
		);
	});

	it('bare --non-interactive enables non-interactive mode', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--team-restrictions=true',
		]);
		expect(args.interactive).toBe(false);
	});

	it('rejects --non-interactive=maybe', () => {
		expect(() => parseMigrateArgs(['--non-interactive=maybe'])).toThrow(
			/expects a boolean/,
		);
	});

	it('defaults applyTeamRestrictions to undefined when omitted', () => {
		const args = parseMigrateArgs([]);
		expect(args.applyTeamRestrictions).toBeUndefined();
	});

	it('parses bare --team-restrictions as true', () => {
		const args = parseMigrateArgs(['--team-restrictions']);
		expect(args.applyTeamRestrictions).toBe(true);
	});

	it('parses --team-restrictions=true', () => {
		const args = parseMigrateArgs(['--team-restrictions=true']);
		expect(args.applyTeamRestrictions).toBe(true);
	});

	it('parses --team-restrictions=false', () => {
		const args = parseMigrateArgs(['--team-restrictions=false']);
		expect(args.applyTeamRestrictions).toBe(false);
	});

	it('rejects --team-restrictions=maybe', () => {
		expect(() => parseMigrateArgs(['--team-restrictions=maybe'])).toThrow(
			/expects a boolean/,
		);
	});

	it('does NOT consume a following flag token for bare --team-restrictions', () => {
		// Bare --team-restrictions must not swallow an adjacent flag as its value.
		const args = parseMigrateArgs(['--team-restrictions', '--dry-run']);
		expect(args.applyTeamRestrictions).toBe(true);
		expect(args.dryRun).toBe(true);
	});

	it('parses --team-restrictions with a space-separated value', () => {
		const args = parseMigrateArgs(['--team-restrictions', 'false']);
		expect(args.applyTeamRestrictions).toBe(false);
	});

	it('carries applyTeamRestrictions through in non-interactive mode', () => {
		const args = parseMigrateArgs([
			'--non-interactive',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			'--team-restrictions=false',
		]);
		expect(args.interactive).toBe(false);
		expect(args.applyTeamRestrictions).toBe(false);
		expect(args.nonInteractive?.applyTeamRestrictions).toBe(false);
	});

	it('requires --team-restrictions in non-interactive mode', () => {
		expect(() =>
			parseMigrateArgs([
				'--non-interactive',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/--team-restrictions is required/);
	});

	describe('--interactive backwards compat', () => {
		it('bare --interactive means interactive mode', () => {
			const args = parseMigrateArgs(['--interactive']);
			expect(args.interactive).toBe(true);
		});

		it('--interactive=true means interactive mode', () => {
			const args = parseMigrateArgs(['--interactive=true']);
			expect(args.interactive).toBe(true);
		});

		it('--interactive=false triggers non-interactive mode', () => {
			const args = parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
				'--team-restrictions=true',
			]);
			expect(args.interactive).toBe(false);
		});

		it('--interactive=false and --non-interactive are consistent (both non-interactive)', () => {
			const args = parseMigrateArgs([
				'--interactive=false',
				'--non-interactive',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
				'--env-map=p,p',
				'--feature-flag=x',
				'--team-restrictions=true',
			]);
			expect(args.interactive).toBe(false);
		});

		it('--interactive=true and --non-interactive=false are consistent (both interactive)', () => {
			const args = parseMigrateArgs([
				'--interactive=true',
				'--non-interactive=false',
			]);
			expect(args.interactive).toBe(true);
		});

		it('throws when --interactive=false conflicts with --non-interactive=false', () => {
			expect(() =>
				parseMigrateArgs(['--interactive=false', '--non-interactive=false']),
			).toThrow(/--interactive=false conflicts with --non-interactive=false/);
		});

		it('throws when --interactive=true conflicts with --non-interactive=true', () => {
			expect(() =>
				parseMigrateArgs(['--interactive=true', '--non-interactive=true']),
			).toThrow(/--interactive=true conflicts with --non-interactive=true/);
		});
	});
});
