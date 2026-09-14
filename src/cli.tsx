#!/usr/bin/env node
import { createRequire } from 'node:module';
import chalk from 'chalk';
import { HelpScreen } from './components/HelpScreen.js';
import { renderStatic } from './components/mount.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

async function printHelp(exitCode = 0): Promise<never> {
	await renderStatic(<HelpScreen />, { stream: process.stdout });
	process.exit(exitCode);
}

const subcommand = process.argv[2];

if (subcommand === '--version' || subcommand === '-V') {
	console.log(version);
	process.exit(0);
} else if (
	!subcommand ||
	subcommand === '--help' ||
	subcommand === '-h' ||
	subcommand === 'help'
) {
	await printHelp(subcommand ? 0 : 1);
} else if (subcommand === 'migrate') {
	process.argv.splice(2, 1);
	await import('./migrate.js');
} else if (subcommand === 'sync-tags') {
	process.argv.splice(2, 1);
	await import('./sync-tags.js');
} else if (subcommand === 'evaluate') {
	process.argv.splice(2, 1);
	await import('./evaluate.js');
} else if (subcommand === 'bulk-permissions') {
	process.argv.splice(2, 1);
	await import('./bulk-permissions.js');
} else if (subcommand === 'bulk-enable') {
	process.argv.splice(2, 1);
	await import('./bulk-enable.js');
} else if (subcommand === 'add-tags' || subcommand === 'add-tag') {
	process.argv.splice(2, 1);
	await import('./add-tags.js');
} else {
	console.error(chalk.red(`\nUnknown command: ${subcommand}`));
	console.error(chalk.gray('Run dd-flag-migration --help for usage.\n'));
	process.exit(1);
}
