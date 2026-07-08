import chalk from 'chalk';

export type EnvVarName =
	| 'DD_API_KEY'
	| 'DD_APP_KEY'
	| 'DD_CLIENT_TOKEN'
	| 'EPPO_API_KEY'
	| 'EPPO_SDK_KEY'
	| 'LAUNCHDARKLY_API_KEY'
	| 'LAUNCHDARKLY_SDK_KEY';

function read(name: EnvVarName): string | undefined {
	const v = process.env[name];
	if (v === undefined) return undefined;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function requireEnvVars(
	names: EnvVarName[],
): Record<EnvVarName, string> {
	const missing: EnvVarName[] = [];
	const result: Partial<Record<EnvVarName, string>> = {};
	for (const name of names) {
		const value = read(name);
		if (value === undefined) {
			missing.push(name);
		} else {
			result[name] = value;
		}
	}
	if (missing.length > 0) {
		process.stderr.write(
			chalk.red('\nMissing required environment variable(s):\n'),
		);
		for (const name of missing) {
			process.stderr.write(chalk.red(`  • ${name}\n`));
		}
		process.stderr.write(
			chalk.gray(
				'\nSet these in your shell before running the command. ' +
					'See https://github.com/DataDog/dd-flag-migration for details.\n\n',
			),
		);
		process.exit(1);
	}
	return result as Record<EnvVarName, string>;
}
