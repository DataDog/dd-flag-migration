export type ProviderValue = 'eppo' | 'launchdarkly';

export interface NonInteractiveArgs {
	provider: ProviderValue;
	projectKey?: string;
	envMap: Array<[string, string]>;
	flagKeys: string[];
}

export interface MigrateArgs {
	dryRun: boolean;
	datadogSite: string | undefined;
	interactive: boolean;
	noExport: boolean;
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
	takesValue: boolean;
}

const FLAGS: FlagDef[] = [
	{ name: '--dry-run', takesValue: false },
	{ name: '--no-export', takesValue: false },
	{ name: '--datadog-site', takesValue: true },
	{ name: '--interactive', takesValue: true },
	{ name: '--provider', takesValue: true },
	{ name: '--project', takesValue: true },
	{ name: '--env-map', takesValue: true },
	{ name: '--feature-flag', takesValue: true },
];

/**
 * Parse migrate-command CLI args. Pure function — no env/exit side effects.
 * Throws ArgParseError on malformed input.
 */
export function parseMigrateArgs(argv: string[]): MigrateArgs {
	let dryRun = false;
	let noExport = false;
	let datadogSite: string | undefined;
	let interactive: boolean | undefined;
	let provider: ProviderValue | undefined;
	let projectKey: string | undefined;
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
		if (def.takesValue) {
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
		} else if (valueFromEquals !== undefined) {
			throw new ArgParseError(`${name} does not take a value`);
		}

		switch (name) {
			case '--dry-run':
				dryRun = true;
				break;
			case '--no-export':
				noExport = true;
				break;
			case '--datadog-site':
				datadogSite = (value as string).trim();
				break;
			case '--interactive':
				interactive = parseBool(value as string, name);
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
		return {
			dryRun,
			datadogSite,
			interactive: false,
			noExport,
			nonInteractive: {
				provider,
				projectKey,
				envMap,
				flagKeys,
			},
		};
	}

	return {
		dryRun,
		datadogSite,
		interactive: true,
		noExport,
	};
}
