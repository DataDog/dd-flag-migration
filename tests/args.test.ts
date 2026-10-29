import { describe, expect, it } from '@jest/globals';
import { ArgParseError, parseMigrateArgs } from '../src/args.js';

describe('parseMigrateArgs', () => {
	it('preserves omitted booleans without selecting non-interactive mode', () => {
		const args = parseMigrateArgs([]);
		expect(args.interactive).toBeUndefined();
		expect(args.dryRun).toBeUndefined();
		expect(args.doExport).toBeUndefined();
		expect(args.distributionChannelMode).toBeUndefined();
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

	it.each([
		'auto',
		'client',
		'server',
		'all',
	] as const)('accepts --distribution-channel=%s for LaunchDarkly', (distributionChannelMode) => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=launchdarkly',
			'--project=my-ld',
			'--env-map=prod,prod',
			'--feature-flag=foo',
			`--distribution-channel=${distributionChannelMode}`,
		]);
		expect(args.distributionChannelMode).toBe(distributionChannelMode);
	});

	it.each([
		['merge', 'additive'],
		['additive', 'additive'],
		['replace', 'replace'],
		['full', 'replace'],
	] as const)('accepts tag mode %s for both providers', (input, expected) => {
		for (const provider of ['launchdarkly', 'eppo']) {
			const args = parseMigrateArgs([
				'--interactive=false',
				'--provider',
				provider,
				...(provider === 'launchdarkly' ? ['--project=health-app'] : []),
				'--env-map=Production,production',
				'--feature-flag=flag',
				'--tag-mode',
				input,
			]);
			expect(args.tagMode).toBe(expected);
		}
	});

	it('allows an explicit tag mode in interactive mode', () => {
		expect(parseMigrateArgs(['--tag-mode=replace']).tagMode).toBe('replace');
		expect(parseMigrateArgs([]).tagMode).toBeUndefined();
	});

	it('rejects unknown or missing tag modes', () => {
		expect(() => parseMigrateArgs(['--tag-mode=unknown'])).toThrow(
			/--tag-mode must be/,
		);
		expect(() => parseMigrateArgs(['--tag-mode'])).toThrow(ArgParseError);
	});

	it('rejects an unknown distribution channel', () => {
		expect(() => parseMigrateArgs(['--distribution-channel=mobile'])).toThrow(
			/--distribution-channel must be one of/,
		);
	});

	it('rejects --distribution-channel for Eppo', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=eppo',
				'--env-map=prod,prod',
				'--feature-flag=foo',
				'--distribution-channel=client',
			]),
		).toThrow(/only supported for LaunchDarkly/);
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

	it('allows DD_SITE to provide the site in non-interactive mode', () => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=eppo',
			'--env-map=p,p',
			'--feature-flag=x',
		]);
		expect(args.datadogSite).toBeUndefined();
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

	it.each([
		[['--export'], true],
		[['--export=true'], true],
		[['--export', 'true'], true],
		[['--export=false'], false],
		[['--export', 'false'], false],
	] as const)('parses export arguments %j as %s in non-interactive mode', (exportArgs, expected) => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
			...exportArgs,
		]);
		expect(args.interactive).toBe(false);
		expect(args.doExport).toBe(expected);
	});

	it('preserves omitted --export in non-interactive mode', () => {
		const args = parseMigrateArgs([
			'--interactive=false',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--env-map=p,p',
			'--feature-flag=x',
		]);
		expect(args.doExport).toBeUndefined();
	});

	it('accepts --export without a value', () => {
		expect(parseMigrateArgs(['--export']).doExport).toBe(true);
	});

	it('rejects --export=maybe', () => {
		expect(() => parseMigrateArgs(['--export=maybe'])).toThrow(
			/expects a boolean/,
		);
	});

	it('accepts --interactive without a value', () => {
		expect(parseMigrateArgs(['--interactive']).interactive).toBe(true);
	});

	it('rejects --interactive=maybe', () => {
		expect(() => parseMigrateArgs(['--interactive=maybe'])).toThrow(
			/expects a boolean/,
		);
	});
});

describe.each([
	['--dry-run', 'dryRun'],
	['--export', 'doExport'],
	['--interactive', 'interactive'],
] as const)('parseMigrateArgs boolean option %s', (flag, field) => {
	const base = ['--provider=eppo', '--env-map=p,p', '--feature-flag=x'];

	it('preserves omission as undefined', () => {
		expect(parseMigrateArgs(base)[field]).toBeUndefined();
	});

	it.each([
		['', [], true],
		['=true', [], true],
		['', ['true'], true],
		['=false', [], false],
		['', ['false'], false],
	] as const)('parses %s with trailing values %j as %s', (suffix, values, expected) => {
		expect(
			parseMigrateArgs([`${flag}${suffix}`, ...values, ...base])[field],
		).toBe(expected);
	});

	it('does not consume the following option', () => {
		const args = parseMigrateArgs([flag, ...base]);
		expect(args[field]).toBe(true);
		expect(args.dryRun).toBe(flag === '--dry-run' ? true : undefined);
	});

	it('uses the last value when repeated', () => {
		expect(parseMigrateArgs([flag, `${flag}=false`, ...base])[field]).toBe(
			false,
		);
		expect(parseMigrateArgs([`${flag}=false`, flag, ...base])[field]).toBe(
			true,
		);
	});

	it.each(['', 'maybe'])('rejects an invalid equals value %j', (value) => {
		expect(() => parseMigrateArgs([`${flag}=${value}`, ...base])).toThrow(
			/ expects a boolean/,
		);
	});

	it('rejects an invalid space-separated value', () => {
		expect(() => parseMigrateArgs([flag, 'maybe', ...base])).toThrow(
			/ expects a boolean/,
		);
	});
});

describe('parseMigrateArgs with the Datadog provider', () => {
	const base = [
		'--interactive=false',
		'--provider=Datadog',
		'--env-map=Production,Production',
		'--feature-flag=example-flag',
	];

	it('parses a non-interactive Datadog-to-Datadog invocation', () => {
		const args = parseMigrateArgs([...base, '--tag-mode=replace']);
		expect(args.nonInteractive).toEqual({
			provider: 'datadog',
			projectKey: undefined,
			envMap: [['Production', 'Production']],
			flagKeys: ['example-flag'],
		});
		expect(args.datadogSite).toBeUndefined();
		expect(args.tagMode).toBe('replace');
	});

	it.each([
		['--datadog-site=datadoghq.com', /SOURCE_DD_SITE and TARGET_DD_SITE/],
		['--project=example', /--project is only supported for LaunchDarkly/],
		[
			'--distribution-channel=client',
			/--distribution-channel is only supported for LaunchDarkly/,
		],
	])('rejects %s', (option, message) => {
		expect(() => parseMigrateArgs([...base, option])).toThrow(message);
	});

	it('lists Datadog among the supported providers', () => {
		expect(() =>
			parseMigrateArgs([
				'--interactive=false',
				'--provider=Other',
				'--env-map=p,p',
				'--feature-flag=x',
			]),
		).toThrow(/"Eppo", "LaunchDarkly", or "Datadog"/);
	});
});
