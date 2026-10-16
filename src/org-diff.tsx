#!/usr/bin/env node
import chalk from 'chalk';
import { PromptCancelledError } from './components/mount.js';
import { checkDatadogOrgPermissions } from './datadog/org-permissions.js';
import {
	assertDistinctDatadogOrgs,
	requireDatadogOrgPair,
} from './datadog/orgs.js';
import { runOrgDiffWorkflow } from './org-diff/index.js';

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage: dd-flag-migration org-diff

Interactively map environments between two Datadog orgs and generate a
read-only workbook of flag configuration differences. Neither org is treated
as the source of truth.

Requires SOURCE_DD_API_KEY, SOURCE_DD_APP_KEY, SOURCE_DD_SITE,
TARGET_DD_API_KEY, TARGET_DD_APP_KEY, and TARGET_DD_SITE.`);
		return;
	}
	if (args.length > 0) {
		throw new Error(
			`org-diff is interactive and does not accept options: ${args.join(' ')}`,
		);
	}

	const pair = requireDatadogOrgPair();
	await assertDistinctDatadogOrgs(pair);
	if (!(await checkDatadogOrgPermissions(pair))) {
		process.exitCode = 1;
		return;
	}
	await runOrgDiffWorkflow(pair);
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		return;
	}
	console.error(chalk.red('\nUnable to generate org diff:'), error);
	process.exitCode = 1;
});
