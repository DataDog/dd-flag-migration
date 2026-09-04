#!/usr/bin/env node
import chalk from 'chalk';
import { parseSpaceDelimitedTags, processAddTags } from './add-tags/process.js';
import { exportAddTagsToXlsx } from './add-tags/xlsx.js';
import { confirm } from './components/Confirm.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { input } from './components/Input.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { spinner } from './components/Spinner.js';
import { fetchFlagTags, updateFlagTags } from './datadog/api.js';
import type { DatadogFlagEntry } from './datadog/types.js';
import {
	loadMigratedFlagsWithTags,
	selectMigratedFlags,
} from './helpers/bulk-flags.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { checkRequiredPermissions } from './helpers/permissions.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';

const REQUIRED_PERMISSIONS = ['feature_flag_config_read'] as const;

async function main(): Promise<void> {
	const env = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY']);
	const apiKey = env.DD_API_KEY;
	const appKey = env.DD_APP_KEY;

	process.stdout.write('\x1Bc');
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.addTags} />);
	const site = await promptForDatadogSite();
	await checkRequiredPermissions(apiKey, appKey, site, REQUIRED_PERMISSIONS);

	const loading = spinner('Fetching migrated flags…').start();
	let flags: DatadogFlagEntry[];
	try {
		flags = await loadMigratedFlagsWithTags(apiKey, appKey, site);
		loading.succeed(`Found ${flags.length} migrated flag(s)`);
	} catch (error) {
		loading.fail('Could not load migrated flags');
		throw error;
	}

	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo migrated Datadog flags were found.'));
		return;
	}

	const selectedFlags = await selectMigratedFlags(flags);
	if (selectedFlags === null) throw new PromptCancelledError();
	if (selectedFlags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to update.'));
		return;
	}

	const tags = parseSpaceDelimitedTags(
		await input({
			message: 'Enter tags to add:',
			hint: 'Separate multiple tags with spaces.',
			validate: (value) =>
				parseSpaceDelimitedTags(value).length > 0 || 'Enter at least one tag.',
		}),
	);
	const generateReport = await confirm({
		message: 'Generate an XLSX report?',
		default: true,
	});

	const shouldContinue = await confirm({
		message: `Add ${tags.length} tag(s) to ${selectedFlags.length} flag(s)?`,
		default: true,
	});
	if (!shouldContinue) {
		console.log(chalk.yellow('\nTag update cancelled.'));
		return;
	}

	const progress = spinner().start();
	const results = await processAddTags(selectedFlags, tags, {
		fetchTags: (flag) => fetchFlagTags(apiKey, appKey, flag.id, site),
		updateTags: (flag, resultingTags) =>
			updateFlagTags(apiKey, appKey, flag.id, resultingTags, site),
		onProgress: (flag, index, total) => {
			progress.text = `Adding tags to ${flag.key} (${index}/${total})…`;
		},
	});

	const updatedCount = results.filter(
		(result) => result.status === 'Updated',
	).length;
	const unchangedCount = results.filter(
		(result) => result.status === 'Already tagged',
	).length;
	const failed = results.filter((result) => result.status === 'Failed');

	if (failed.length > 0) {
		progress.warn(
			`Tag update finished: ${updatedCount} updated, ${unchangedCount} already tagged, ${failed.length} failed`,
		);
		for (const result of failed) {
			console.log(
				chalk.red(`  ${result.flagKey}: ${result.error ?? 'Unknown error'}`),
			);
		}
		process.exitCode = 1;
	} else {
		progress.succeed(
			`Tag update complete: ${updatedCount} updated, ${unchangedCount} already tagged`,
		);
	}

	if (generateReport) {
		await exportAddTagsToXlsx(results, tags);
	}
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
