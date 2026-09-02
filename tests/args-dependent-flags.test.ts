import { describe, expect, it } from '@jest/globals';
import { ArgParseError, parseDependentFlagsArgs } from '../src/args.js';

describe('parseDependentFlagsArgs', () => {
	it('defaults to interactive mode with no preselected projects', () => {
		expect(parseDependentFlagsArgs([])).toEqual({
			datadogSite: undefined,
			interactive: true,
			projectKeys: [],
		});
	});

	it('parses repeatable projects and removes duplicates', () => {
		expect(
			parseDependentFlagsArgs([
				'--interactive=false',
				'--datadog-site',
				'us5.datadoghq.com',
				'--project=mobile',
				'--project',
				'web',
				'--project=mobile',
			]),
		).toEqual({
			datadogSite: 'us5.datadoghq.com',
			interactive: false,
			projectKeys: ['mobile', 'web'],
		});
	});

	it('requires a project in non-interactive mode', () => {
		expect(() => parseDependentFlagsArgs(['--interactive=false'])).toThrow(
			/at least one --project/,
		);
	});

	it('rejects unknown and empty options', () => {
		expect(() => parseDependentFlagsArgs(['--unknown=value'])).toThrow(
			ArgParseError,
		);
		expect(() => parseDependentFlagsArgs(['--project='])).toThrow(
			/value must not be empty/,
		);
	});
});
