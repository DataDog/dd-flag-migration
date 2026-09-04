import { describe, expect, it } from '@jest/globals';
import {
	ArgParseError,
	parseMigrateTagsArgs,
	parseSyncDistributionChannelArgs,
} from '../src/args.js';

describe('parseMigrateTagsArgs', () => {
	it('defaults to interactive mode with no tag mode', () => {
		const args = parseMigrateTagsArgs([]);
		expect(args.interactive).toBe(true);
		expect(args.dryRun).toBe(false);
		expect(args.tagMode).toBeUndefined();
		expect(args.nonInteractive).toBeUndefined();
	});

	it('parses --dry-run and --datadog-site (equals form)', () => {
		const args = parseMigrateTagsArgs([
			'--dry-run',
			'--datadog-site=datadoghq.eu',
		]);
		expect(args.dryRun).toBe(true);
		expect(args.datadogSite).toBe('datadoghq.eu');
	});

	it('parses --datadog-site (space form)', () => {
		const args = parseMigrateTagsArgs(['--datadog-site', 'datadoghq.com']);
		expect(args.datadogSite).toBe('datadoghq.com');
	});

	it('rejects empty --datadog-site value', () => {
		expect(() => parseMigrateTagsArgs(['--datadog-site=  '])).toThrow(
			ArgParseError,
		);
	});

	it('errors on unknown option', () => {
		expect(() => parseMigrateTagsArgs(['--bogus'])).toThrow(/Unknown option/);
	});

	it('rejects --env-map (tags are flag-level)', () => {
		expect(() => parseMigrateTagsArgs(['--env-map=prod,prod'])).toThrow(
			/Unknown option/,
		);
	});

	it('parses --tag-mode additive (and aliases merge)', () => {
		expect(parseMigrateTagsArgs(['--tag-mode=additive']).tagMode).toBe(
			'additive',
		);
		expect(parseMigrateTagsArgs(['--tag-mode=merge']).tagMode).toBe('additive');
	});

	it('parses --tag-mode replace (and aliases full)', () => {
		expect(parseMigrateTagsArgs(['--tag-mode=replace']).tagMode).toBe(
			'replace',
		);
		expect(parseMigrateTagsArgs(['--tag-mode=full']).tagMode).toBe('replace');
	});

	it('rejects unknown --tag-mode', () => {
		expect(() => parseMigrateTagsArgs(['--tag-mode=overwrite'])).toThrow(
			/--tag-mode must be/,
		);
	});

	it('parses a full non-interactive LaunchDarkly invocation', () => {
		const args = parseMigrateTagsArgs([
			'--interactive',
			'false',
			'--provider',
			'LaunchDarkly',
			'--project',
			'my-ld',
			'--datadog-site',
			'datadoghq.com',
			'--tag-mode',
			'replace',
			'--feature-flag',
			'flag-a',
			'--feature-flag',
			'flag-b',
		]);
		expect(args.interactive).toBe(false);
		expect(args.nonInteractive).toEqual({
			provider: 'launchdarkly',
			projectKey: 'my-ld',
			flagKeys: ['flag-a', 'flag-b'],
			tagMode: 'replace',
		});
	});

	it('accepts provider names case-insensitively', () => {
		const args = parseMigrateTagsArgs([
			'--interactive=false',
			'--provider=EPPO',
			'--datadog-site=datadoghq.com',
			'--feature-flag=foo',
		]);
		expect(args.nonInteractive?.provider).toBe('eppo');
	});

	it('rejects unknown provider', () => {
		expect(() =>
			parseMigrateTagsArgs([
				'--interactive=false',
				'--provider=Optimizely',
				'--datadog-site=datadoghq.com',
				'--feature-flag=x',
			]),
		).toThrow(/--provider must be/);
	});

	it('requires --provider in non-interactive mode', () => {
		expect(() =>
			parseMigrateTagsArgs([
				'--interactive=false',
				'--datadog-site=datadoghq.com',
				'--feature-flag=x',
			]),
		).toThrow(/--provider is required/);
	});

	it('requires at least one --feature-flag', () => {
		expect(() =>
			parseMigrateTagsArgs([
				'--interactive=false',
				'--provider=eppo',
				'--datadog-site=datadoghq.com',
			]),
		).toThrow(/--feature-flag/);
	});

	it('requires --project for LaunchDarkly', () => {
		expect(() =>
			parseMigrateTagsArgs([
				'--interactive=false',
				'--provider=launchdarkly',
				'--datadog-site=datadoghq.com',
				'--feature-flag=x',
			]),
		).toThrow(/--project is required/);
	});

	it('does NOT require --project for Eppo', () => {
		const args = parseMigrateTagsArgs([
			'--interactive=false',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--feature-flag=x',
		]);
		expect(args.nonInteractive?.projectKey).toBeUndefined();
	});

	it('requires --datadog-site in non-interactive mode', () => {
		expect(() =>
			parseMigrateTagsArgs([
				'--interactive=false',
				'--provider=eppo',
				'--feature-flag=x',
			]),
		).toThrow(/--datadog-site is required/);
	});

	it('defaults tag mode to additive in non-interactive mode when omitted', () => {
		const args = parseMigrateTagsArgs([
			'--interactive=false',
			'--provider=eppo',
			'--datadog-site=datadoghq.com',
			'--feature-flag=x',
		]);
		expect(args.nonInteractive?.tagMode).toBe('additive');
	});

	it('rejects --interactive without a value', () => {
		expect(() => parseMigrateTagsArgs(['--interactive'])).toThrow(
			/requires a value/,
		);
	});

	it('rejects --interactive=maybe', () => {
		expect(() => parseMigrateTagsArgs(['--interactive=maybe'])).toThrow(
			/expects a boolean/,
		);
	});
});

describe('parseSyncDistributionChannelArgs', () => {
	it('defaults to an interactive live run', () => {
		expect(parseSyncDistributionChannelArgs([])).toEqual({
			dryRun: false,
			datadogSite: undefined,
		});
	});

	it('parses dry-run and Datadog site forms', () => {
		expect(
			parseSyncDistributionChannelArgs([
				'--dry-run',
				'--datadog-site=datadoghq.eu',
			]),
		).toEqual({ dryRun: true, datadogSite: 'datadoghq.eu' });
		expect(
			parseSyncDistributionChannelArgs(['--datadog-site', 'us5.datadoghq.com']),
		).toEqual({ dryRun: false, datadogSite: 'us5.datadoghq.com' });
	});

	it('rejects unsupported and malformed options', () => {
		expect(() =>
			parseSyncDistributionChannelArgs(['--interactive=false']),
		).toThrow(/Unknown option/);
		expect(() => parseSyncDistributionChannelArgs(['--datadog-site='])).toThrow(
			/must not be empty/,
		);
		expect(() => parseSyncDistributionChannelArgs(['--dry-run=true'])).toThrow(
			/does not take a value/,
		);
	});
});
