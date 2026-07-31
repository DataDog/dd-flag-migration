export type ProviderValue = 'eppo' | 'launchdarkly';

export interface NonInteractiveArgs {
	provider: ProviderValue;
	projectKey?: string;
	envMap: Array<[string, string]>;
	flagKeys: string[];
	// Required in non-interactive mode — validated in parseMigrateArgs.
	applyTeamRestrictions: boolean;
}

export interface MigrateArgs {
	dryRun: boolean;
	datadogSite: string | undefined;
	interactive: boolean;
	doExport: boolean;
	// Interactive mode only: undefined = flag not supplied, should prompt.
	// In non-interactive mode this is echoed from NonInteractiveArgs.
	applyTeamRestrictions: boolean | undefined;
	nonInteractive?: NonInteractiveArgs;
}

export class ArgParseError extends Error {}

function parseBool(raw: string, flag: string): boolean {
	const v = raw.trim().toLowerCase();
	if (v === 'true' || v === '1' || v === 'yes') return true;
	if (v === 'false' || v === '0' || v === 'no') return false;
	throw new ArgParseError(
		`${flag} expects a boolean (true|false), got: ${raw}`,
	);
}

function normalizeProvider(raw: string): ProviderValue {
	const v = raw.trim().toLowerCase();
	if (v === 'eppo') return 'eppo';
	if (v === 'launchdarkly') return 'launchdarkly';
	throw new ArgParseError(
		`--provider must be one of "Eppo" or "LaunchDarkly" (case-insensitive), got: ${raw}`,
	);
}

interface FlagDef {
	name: string;
	takesValue: 'no' | 'required' | 'optional';
}

const FLAGS: FlagDef[] = [
	// Boolean flags accept a bare form (means true) or `=<bool>`.
	{ name: '--dry-run', takesValue: 'optional' },
	{ name: '--export', takesValue: 'optional' },
	{ name: '--non-interactive', takesValue: 'optional' },
	{ name: '--team-restrictions', takesValue: 'optional' },
	{ name: '--datadog-site', takesValue: 'required' },
	{ name: '--provider', takesValue: 'required' },
	{ name: '--project', takesValue: 'required' },
	{ name: '--env-map', takesValue: 'required' },
	{ name: '--feature-flag', takesValue: 'required' },
];

/**
 * Parse migrate-command CLI args. Pure function — no env/exit side effects.
 * Throws ArgParseError on malformed input.
 */
export function parseMigrateArgs(argv: string[]): MigrateArgs {
	let dryRun = false;
	let doExport = false;
	let datadogSite: string | undefined;
	let interactive: boolean | undefined;
	let provider: ProviderValue | undefined;
	let projectKey: string | undefined;
	let applyTeamRestrictions: boolean | undefined;
	const envMap: Array<[string, string]> = [];
	const flagKeys: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		let name: string;
		let valueFromEquals: string | undefined;
		const eq = arg.indexOf('=');
		if (arg.startsWith('--') && eq !== -1) {
			name = arg.slice(0, eq);
			valueFromEquals = arg.slice(eq + 1);
		} else {
			name = arg;
		}

		const def = FLAGS.find((f) => f.name === name);
		if (!def) {
			throw new ArgParseError(`Unknown option: ${arg}`);
		}

		let value: string | undefined;
		if (def.takesValue === 'required') {
			if (valueFromEquals !== undefined) {
				value = valueFromEquals;
			} else {
				if (i + 1 >= argv.length) {
					throw new ArgParseError(`${name} requires a value`);
				}
				value = argv[i + 1];
				i++;
			}
			if (value.trim().length === 0) {
				throw new ArgParseError(`${name} value must not be empty`);
			}
		} else if (def.takesValue === 'optional') {
			// Accept `=value`, or a space-separated value only if the next
			// argv token doesn't itself look like a flag. A bare flag with
			// no consumable value means "supplied without a value".
			if (valueFromEquals !== undefined) {
				value = valueFromEquals;
				if (value.trim().length === 0) {
					throw new ArgParseError(`${name} value must not be empty`);
				}
			} else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
				value = argv[i + 1];
				i++;
				if (value.trim().length === 0) {
					throw new ArgParseError(`${name} value must not be empty`);
				}
			}
		} else if (valueFromEquals !== undefined) {
			throw new ArgParseError(`${name} does not take a value`);
		}

		switch (name) {
			case '--dry-run':
				// Bare flag means true; explicit `=<bool>` is honored.
				dryRun = value === undefined ? true : parseBool(value, name);
				break;
			case '--export':
				doExport = value === undefined ? true : parseBool(value, name);
				break;
			case '--datadog-site':
				datadogSite = (value as string).trim();
				break;
			case '--non-interactive':
				interactive = value === undefined ? false : !parseBool(value, name);
				break;
			case '--provider':
				provider = normalizeProvider(value as string);
				break;
			case '--project':
				projectKey = (value as string).trim();
				break;
			case '--env-map': {
				const parts = (value as string).split(',');
				if (
					parts.length !== 2 ||
					parts[0].trim().length === 0 ||
					parts[1].trim().length === 0
				) {
					throw new ArgParseError(
						`--env-map must be in the form 'source,target', got: ${value}`,
					);
				}
				envMap.push([parts[0].trim(), parts[1].trim()]);
				break;
			}
			case '--feature-flag':
				flagKeys.push((value as string).trim());
				break;
			case '--team-restrictions':
				// Bare flag (`--team-restrictions`) means true; explicit value
				// (`--team-restrictions=false`) is parsed as a boolean.
				applyTeamRestrictions =
					value === undefined ? true : parseBool(value, name);
				break;
		}
	}

	const isInteractive = interactive ?? true;

	if (!isInteractive) {
		if (!provider) {
			throw new ArgParseError('--provider is required in non-interactive mode');
		}
		if (envMap.length === 0) {
			throw new ArgParseError(
				'at least one --env-map is required in non-interactive mode',
			);
		}
		if (flagKeys.length === 0) {
			throw new ArgParseError(
				'at least one --feature-flag is required in non-interactive mode',
			);
		}
		if (provider === 'launchdarkly' && !projectKey) {
			throw new ArgParseError(
				'--project is required in non-interactive mode for LaunchDarkly',
			);
		}
		if (!datadogSite) {
			throw new ArgParseError(
				'--datadog-site is required in non-interactive mode',
			);
		}
		if (applyTeamRestrictions === undefined) {
			throw new ArgParseError(
				'--team-restrictions is required in non-interactive mode',
			);
		}
		return {
			dryRun,
			datadogSite,
			interactive: false,
			doExport,
			applyTeamRestrictions,
			nonInteractive: {
				provider,
				projectKey,
				envMap,
				flagKeys,
				applyTeamRestrictions,
			},
		};
	}

	return {
		dryRun,
		datadogSite,
		interactive: true,
		doExport,
		applyTeamRestrictions,
	};
}
