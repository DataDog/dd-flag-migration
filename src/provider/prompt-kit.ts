import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
	filterableCheckbox,
	filterableSelect,
} from '../filterable-checkbox.js';
import { MigrationProgressBar } from '../progress-bar.js';
import { createSpinner } from '../spinner.js';
import type { PromptKit, PromptKitTheme } from './types.js';

const purple = chalk.bold.hex('#632CA6');

function printHeader(): void {
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
}

function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

const defaultTheme: PromptKitTheme = {
	brand: (s) => purple(s),
	muted: (s) => chalk.gray(s),
	success: (s) => chalk.green(s),
	warn: (s) => chalk.yellow(s),
	error: (s) => chalk.red(s),
	cyan: (s) => chalk.cyan(s),
	bold: (s) => chalk.bold(s),
};

export function createPromptKit(): PromptKit {
	return {
		printHeader,
		clearScreen,
		spinner: (text) => createSpinner(text),
		progressBar: (total, subheader) =>
			new MigrationProgressBar(total, subheader),
		select: (opts) => select(opts),
		confirm: (opts) => confirm(opts),
		input: (opts) => input(opts),
		filterableCheckbox: (opts) => filterableCheckbox(opts),
		filterableSelect: (opts) => filterableSelect(opts),
		theme: defaultTheme,
	};
}
