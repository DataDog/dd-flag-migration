#!/usr/bin/env node
import { createRequire } from 'node:module';
import chalk from 'chalk';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

function printHelp(exitCode = 0): never {
	const purple = chalk.bold.hex('#632CA6');
	console.log();
	console.log(purple('╔══════════════════════════════════════════╗'));
	console.log(
		purple('║') +
			chalk.bold.white('   🚩  Feature Flag Migration Tool  🚩    ') +
			purple('║'),
	);
	console.log(
		purple('║') +
			chalk.hex('#632CA6')('            Migrate to Datadog            ') +
			purple('║'),
	);
	console.log(purple('╚══════════════════════════════════════════╝'));
	console.log();
	console.log(`${chalk.bold('Usage:')}  dd-flag-migration <command> [options]`);
	console.log();
	console.log(chalk.bold('Global options:'));
	console.log(
		`  ${chalk.cyan('-V, --version')}               Print version and exit`,
	);
	console.log(
		`  ${chalk.cyan('-h, --help')}                  Show this help message`,
	);
	console.log();
	console.log(chalk.bold('Commands:'));
	console.log(
		`  ${chalk.cyan('migrate')}    Migrate feature flags from Eppo or LaunchDarkly into Datadog`,
	);
	console.log(
		`  ${chalk.cyan('evaluate')}   Compare flag evaluations side-by-side after migrating`,
	);
	console.log();
	console.log(`${chalk.bold('Options for')} ${chalk.cyan('migrate')}:`);
	console.log(
		'  --dry-run                    Preview changes without creating flags',
	);
	console.log(
		'  --datadog-site=<site>        Set the Datadog site non-interactively',
	);
	console.log();
	console.log(`${chalk.bold('Options for')} ${chalk.cyan('evaluate')}:`);
	console.log(
		'  --use-latest-migration       Skip migration file selector; use most recent',
	);
	console.log(
		'  --test-subject-id=<id>       Set the subject ID non-interactively',
	);
	console.log(
		'  --flag-environment=<name>    Set the Datadog environment non-interactively',
	);
	console.log(
		'  --datadog-site=<site>        Set the Datadog site non-interactively',
	);
	console.log(
		'  --csv=<path>                 Path to a CSV file for advanced evaluation',
	);
	console.log(
		'  --show-table                 Force table output even for large result sets',
	);
	console.log();
	console.log(chalk.bold('Examples:'));
	console.log(`  ${chalk.gray('$')} dd-flag-migration migrate`);
	console.log(`  ${chalk.gray('$')} dd-flag-migration migrate --dry-run`);
	console.log(`  ${chalk.gray('$')} dd-flag-migration evaluate`);
	console.log(
		`  ${chalk.gray('$')} dd-flag-migration evaluate --use-latest-migration --datadog-site=datadoghq.com`,
	);
	console.log();
	process.exit(exitCode);
}

const subcommand = process.argv[2];

if (subcommand === '--version' || subcommand === '-V') {
	console.log(version);
	process.exit(0);
} else if (!subcommand || subcommand === '--help' || subcommand === '-h') {
	printHelp(subcommand ? 0 : 1);
} else if (subcommand === 'migrate') {
	process.argv.splice(2, 1);
	await import('./index.js');
} else if (subcommand === 'evaluate') {
	process.argv.splice(2, 1);
	await import('./evaluate.js');
} else {
	console.error(chalk.red(`\nUnknown command: ${subcommand}`));
	console.error(chalk.gray('Run dd-flag-migration --help for usage.\n'));
	process.exit(1);
}
