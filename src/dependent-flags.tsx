#!/usr/bin/env node
import chalk from 'chalk';
import {
	ArgParseError,
	type DependentFlagsArgs,
	parseDependentFlagsArgs,
} from './args.js';
import { filterableCheckbox } from './components/FilterableCheckbox.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { spinner } from './components/Spinner.js';
import { fetchCurrentOrganizationName } from './datadog/api.js';
import { collectDependentFlagRows } from './dependent-flags/collect.js';
import type { DependentFlagReportRow } from './dependent-flags/report.js';
import { exportDependentFlagsToXlsx } from './dependent-flags/xlsx.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { withConsoleLogToStderr, writeJsonOutput } from './helpers/output.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';
import { fetchProjects, type LDProject } from './launchdarkly/api.js';

function parseArgs(): DependentFlagsArgs {
	try {
		return parseDependentFlagsArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof ArgParseError) {
			process.stderr.write(chalk.red(`\n${error.message}\n\n`));
			process.exit(1);
		}
		throw error;
	}
}

function nonInteractiveDatadogSite(argument?: string): string {
	const site = argument ?? process.env.DD_SITE?.trim();
	if (!site) {
		throw new Error(
			'--datadog-site or DD_SITE is required in non-interactive mode',
		);
	}
	return site;
}

function selectProjectsByKey(
	projects: LDProject[],
	projectKeys: string[],
): LDProject[] {
	const projectsByKey = new Map(
		projects.map((project) => [project.key, project]),
	);
	const missing = projectKeys.filter((key) => !projectsByKey.has(key));
	if (missing.length > 0) {
		throw new Error(
			`LaunchDarkly project(s) not found: ${missing.join(', ')}. Available: ${projects
				.map((project) => project.key)
				.join(', ')}`,
		);
	}
	return projectKeys.map((key) => projectsByKey.get(key) as LDProject);
}

async function selectProjects(projects: LDProject[]): Promise<LDProject[]> {
	const selected = await filterableCheckbox<LDProject>({
		message: 'Select LaunchDarkly projects to scan:',
		choices: projects.map((project) => ({
			name: `${project.name} (${project.key})`,
			value: project,
			searchTerms: [project.name, project.key],
		})),
		pageSize: Math.max(5, (process.stdout.rows ?? 24) - 9),
	});
	if (selected === null) throw new PromptCancelledError();
	return selected;
}

interface ReportResult {
	exportPath: string;
	datadogOrg: string;
	projects: LDProject[];
	relationshipCount: number;
	unresolvedCount: number;
}

async function generateReport(
	args: DependentFlagsArgs,
	credentials: {
		ldApiKey: string;
		ddApiKey: string;
		ddAppKey: string;
	},
): Promise<ReportResult | null> {
	const site = args.interactive
		? await promptForDatadogSite(args.datadogSite)
		: nonInteractiveDatadogSite(args.datadogSite);

	const loading = spinner(
		'Fetching LaunchDarkly projects and Datadog organization…',
	).start();
	let projects: LDProject[];
	let datadogOrg: string;
	try {
		[projects, datadogOrg] = await Promise.all([
			fetchProjects(credentials.ldApiKey),
			fetchCurrentOrganizationName(
				credentials.ddApiKey,
				credentials.ddAppKey,
				site,
			),
		]);
		loading.succeed(
			`Found ${projects.length} LaunchDarkly project(s) · Datadog org: ${datadogOrg}`,
		);
	} catch (error) {
		loading.fail(
			'Failed to load LaunchDarkly projects or Datadog organization',
		);
		throw error;
	}

	const selectedProjects = args.interactive
		? await selectProjects(projects)
		: selectProjectsByKey(projects, args.projectKeys);
	if (selectedProjects.length === 0) {
		console.log(chalk.yellow('\nNo projects selected — nothing to report.\n'));
		return null;
	}

	const progress = spinner('Scanning LaunchDarkly flag dependencies…').start();
	let rows: DependentFlagReportRow[];
	try {
		rows = await collectDependentFlagRows(
			credentials.ldApiKey,
			selectedProjects,
			datadogOrg,
			({ project, environment, completed, total }) => {
				progress.text = `Scanning ${project.name} / ${environment.name} (${completed}/${total})…`;
			},
		);
		progress.succeed(
			`Dependency scan complete: ${rows.length} relationship${rows.length === 1 ? '' : 's'} found`,
		);
	} catch (error) {
		progress.fail('Failed while scanning LaunchDarkly dependencies');
		throw error;
	}

	const exportPath = await exportDependentFlagsToXlsx(rows);
	return {
		exportPath,
		datadogOrg,
		projects: selectedProjects,
		relationshipCount: rows.length,
		unresolvedCount: rows.filter((row) => row.unresolved).length,
	};
}

async function main(): Promise<void> {
	const args = parseArgs();
	const env = requireEnvVars([
		'LAUNCHDARKLY_API_KEY',
		'DD_API_KEY',
		'DD_APP_KEY',
	]);
	const credentials = {
		ldApiKey: env.LAUNCHDARKLY_API_KEY,
		ddApiKey: env.DD_API_KEY,
		ddAppKey: env.DD_APP_KEY,
	};

	if (args.interactive) {
		process.stdout.write('\x1Bc');
		await renderStatic(<Header subtitle={HEADER_SUBTITLES.dependentFlags} />);
		await generateReport(args, credentials);
		return;
	}

	const result = await withConsoleLogToStderr(() =>
		generateReport(args, credentials),
	);
	if (result === null) return;
	writeJsonOutput({
		exportPath: result.exportPath,
		datadogOrg: result.datadogOrg,
		projects: result.projects,
		relationshipCount: result.relationshipCount,
		unresolvedCount: result.unresolvedCount,
	});
}

main().catch((error: unknown) => {
	if (error instanceof PromptCancelledError) {
		console.log(chalk.gray('\nBye!'));
		process.exit(0);
	}
	console.error(chalk.red('\nUnexpected error:'), formatAxiosError(error));
	process.exit(1);
});
