import { input, select } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';
import { fetchDatadogEnvironments, fetchDatadogFlags } from '../datadog.js';
import type { MigrationPlan, ProviderContext } from '../provider/types.js';
import type { DatadogEnvironment, DatadogFlagEntry } from '../types.js';
import {
	fetchFlags,
	fetchFlagsByKey,
	fetchProjectEnvironments,
	fetchProjects,
	type LDProject,
} from './api.js';
import {
	type ConflictResolution,
	classifyConflict,
	type LDFlagMigrationSpec,
	parseLDFlagMigrationSpecs,
} from './conflicts.js';
import { resolveLDEnvMap } from './non-interactive.js';
import {
	clearScreen,
	confirmFlagSelection,
	linkEnvironments,
	printHeader,
	selectFlags,
	selectLDEnvironments,
	selectProject,
} from './prompts.js';
import type { LDEnvironment, LDFlag } from './types.js';

// Provider-specific data carried through Phase B execution. LD has more
// per-migration state than Eppo because of project scoping, cross-project key
// conflicts, and the --feature-flag <src>,<dst> rename syntax.
export interface LDExtras {
	ldApiKey: string;
	projectKey: string;
	projectName: string;
	datadogFlags: DatadogFlagEntry[];
	conflictResolution?: ConflictResolution;
	// Only populated in non-interactive mode (when --feature-flag includes a
	// Datadog rename). Maps LD source key → desired DD key.
	targetKeyBySource?: Map<string, string>;
}

function formatLoadError(err: unknown): string {
	if (axios.isAxiosError(err)) {
		const url = err.config?.url ?? 'unknown URL';
		const status = err.response?.status ?? 'no status';
		const msg =
			(err.response?.data as { message?: string } | undefined)?.message ??
			err.message;
		return `${err.config?.method?.toUpperCase() ?? 'GET'} ${url} → ${status}: ${msg}`;
	}
	return err instanceof Error ? err.message : String(err);
}

export async function selectLDMigrationPlan(
	ctx: ProviderContext,
): Promise<MigrationPlan<LDFlag, string, LDExtras> | null> {
	// LAUNCHDARKLY_API_KEY presence was validated in src/index.ts before this
	// runs.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const ldApiKey = process.env.LAUNCHDARKLY_API_KEY!.trim();

	if (ctx.nonInteractive) {
		return selectMigrationPlanNonInteractive(ldApiKey, ctx);
	}

	// ── Fetch projects ──────────────────────────────────────────────────────
	clearScreen();
	printHeader();
	if (ctx.dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	const projectSpinner = ctx.promptKit
		.spinner('Fetching LaunchDarkly projects…')
		.start();
	let projects: LDProject[];
	try {
		projects = await fetchProjects(ldApiKey);
		projectSpinner.succeed(`Found ${projects.length} LaunchDarkly project(s)`);
	} catch (err) {
		projectSpinner.fail('Failed to fetch LaunchDarkly projects');
		if (axios.isAxiosError(err)) {
			const msg =
				(err.response?.data as { message?: string } | undefined)?.message ??
				err.message;
			console.error(chalk.red(`  ${msg}`));
		}
		return null;
	}

	if (projects.length === 0) {
		console.log(chalk.yellow('\n  No projects found in LaunchDarkly.\n'));
		return null;
	}

	const selectedProject = await selectProject(projects);
	if (!selectedProject) {
		console.log(chalk.yellow('\n  No project selected.\n'));
		return null;
	}

	console.log();
	console.log(
		chalk.bold('Project: ') +
			chalk.green(selectedProject.name) +
			chalk.gray(` (${selectedProject.key})`),
	);

	// ── Fetch flags + project envs + DD data in parallel ────────────────────
	const loadSpinner = ctx.promptKit
		.spinner('Fetching flags and Datadog data…')
		.start();
	let allFlags: LDFlag[];
	let ldEnvironments: LDEnvironment[];
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];
	try {
		[allFlags, ldEnvironments, datadogFlags, datadogEnvs] = await Promise.all([
			fetchFlags(ldApiKey, selectedProject.key),
			fetchProjectEnvironments(ldApiKey, selectedProject.key),
			fetchDatadogFlags(
				ctx.datadog.apiKey,
				ctx.datadog.appKey,
				ctx.datadog.site,
			),
			fetchDatadogEnvironments(
				ctx.datadog.apiKey,
				ctx.datadog.appKey,
				ctx.datadog.site,
			),
		]);
		loadSpinner.succeed(
			`Loaded ${allFlags.length} LD flag(s) · ${ldEnvironments.length} LD environment(s) · ${datadogFlags.length} Datadog flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		loadSpinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatLoadError(err)}`));
		return null;
	}

	if (allFlags.length === 0) {
		console.log(chalk.yellow('\n  No flags found in this project.\n'));
		return null;
	}

	// ── Cross-project conflict resolution ───────────────────────────────────
	const crossProjectConflicts = allFlags.filter(
		(f) =>
			classifyConflict(datadogFlags, selectedProject.key, f.key).type ===
			'cross_project',
	);

	let conflictResolution: ConflictResolution | undefined;
	if (crossProjectConflicts.length > 0) {
		console.log();
		console.log(
			chalk.yellow(
				`  ${crossProjectConflicts.length} flag(s) have key conflicts with flags from other LaunchDarkly projects`,
			),
		);
		console.log();

		const action = await select<'skip' | 'prefix'>({
			message: 'How would you like to handle these conflicts?',
			choices: [
				{ name: 'Skip conflicting flags', value: 'skip' },
				{ name: 'Add a prefix to conflicting flag keys', value: 'prefix' },
			],
		});

		if (action === 'skip') {
			conflictResolution = { action: 'skip' };
		} else {
			const prefix = await input({
				message: 'Enter a prefix for conflicting flag keys:',
				validate: (val) => {
					const trimmed = val.trim();
					if (trimmed.length === 0) return 'Prefix cannot be empty';
					if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed))
						return 'Prefix must contain only lowercase letters, numbers, and hyphens';
					return true;
				},
			});
			conflictResolution = { action: 'prefix', prefix: prefix.trim() };
		}
	}

	const extras: LDExtras = {
		ldApiKey,
		projectKey: selectedProject.key,
		projectName: selectedProject.name,
		datadogFlags,
		conflictResolution,
	};

	// ── Interactive prompt loop ─────────────────────────────────────────────
	let prevSelectedEnvKeys: string[] = [];
	let prevEnvMapping = new Map<string, DatadogEnvironment>();
	let prevSelectedFlags: LDFlag[] = [];

	// eslint-disable-next-line no-constant-condition
	while (true) {
		clearScreen();
		printHeader();
		const envResult = await selectLDEnvironments(
			ldEnvironments,
			prevSelectedEnvKeys,
		);
		if (envResult === null) return null;
		if (envResult.length === 0) {
			console.log(
				chalk.yellow(
					'\n  Please select at least one environment to migrate from.\n',
				),
			);
			continue;
		}
		prevSelectedEnvKeys = envResult.map((e) => e.key);

		while (true) {
			const mapping = await linkEnvironments(
				envResult,
				datadogEnvs,
				prevEnvMapping,
			);
			if (mapping === null) break;

			prevEnvMapping = mapping;

			while (true) {
				clearScreen();
				printHeader();
				const flagResult = await selectFlags(
					allFlags,
					datadogFlags,
					selectedProject.key,
					prevSelectedFlags,
					conflictResolution,
				);
				if (flagResult === null) break;

				prevSelectedFlags = flagResult;
				clearScreen();
				printHeader();
				const action = await confirmFlagSelection(
					prevSelectedFlags,
					ctx.dryRun,
				);
				if (action === 'cancel') return null;
				if (action === 'migrate') {
					return {
						selectedFlags: prevSelectedFlags,
						envMapping: prevEnvMapping,
						extras,
					};
				}
				// action === 'select-more': loop back to selectFlags
			}
		}
	}
}

async function selectMigrationPlanNonInteractive(
	ldApiKey: string,
	ctx: ProviderContext,
): Promise<MigrationPlan<LDFlag, string, LDExtras> | null> {
	// biome-ignore lint/style/noNonNullAssertion: ctx.nonInteractive is set by the caller
	const ni = ctx.nonInteractive!;
	if (!ni.projectKey) {
		console.error(
			chalk.red(
				'\n  LaunchDarkly migrations require --project <key> in non-interactive mode.\n',
			),
		);
		process.exit(1);
	}

	printHeader();
	console.log(chalk.gray('  Running in non-interactive mode\n'));
	if (ctx.dryRun) {
		console.log(
			chalk.bold.yellow('  Dry run mode — no flags will be created\n'),
		);
	}

	let flagSpecs: LDFlagMigrationSpec[];
	try {
		flagSpecs = parseLDFlagMigrationSpecs(ni.flagKeys);
	} catch (err) {
		console.error(
			chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`),
		);
		process.exit(1);
	}
	const sourceFlagKeys = flagSpecs.map((spec) => spec.sourceKey);
	const targetKeyBySource = new Map(
		flagSpecs.map((spec) => [spec.sourceKey, spec.datadogKey]),
	);

	const projectSpinner = ctx.promptKit
		.spinner('Fetching LaunchDarkly projects…')
		.start();
	let projects: LDProject[];
	try {
		projects = await fetchProjects(ldApiKey);
		projectSpinner.succeed(`Found ${projects.length} LaunchDarkly project(s)`);
	} catch (err) {
		projectSpinner.fail('Failed to fetch LaunchDarkly projects');
		console.error(chalk.red(`  ${formatLoadError(err)}`));
		process.exit(1);
	}

	const selectedProject = projects.find((p) => p.key === ni.projectKey);
	if (!selectedProject) {
		console.error(
			chalk.red(
				`\n  LaunchDarkly project not found: "${ni.projectKey}"\n` +
					`  Available: ${projects.map((p) => p.key).join(', ')}\n`,
			),
		);
		process.exit(1);
	}

	console.log(
		chalk.bold('  Project: ') +
			chalk.green(selectedProject.name) +
			chalk.gray(` (${selectedProject.key})`),
	);

	const loadSpinner = ctx.promptKit
		.spinner(`Fetching ${sourceFlagKeys.length} flag(s) and Datadog data…`)
		.start();
	let selectedFlags: LDFlag[];
	let ldEnvironments: LDEnvironment[];
	let datadogFlags: DatadogFlagEntry[] = [];
	let datadogEnvs: DatadogEnvironment[] = [];
	try {
		[selectedFlags, ldEnvironments, datadogFlags, datadogEnvs] =
			await Promise.all([
				fetchFlagsByKey(ldApiKey, selectedProject.key, sourceFlagKeys),
				fetchProjectEnvironments(ldApiKey, selectedProject.key),
				fetchDatadogFlags(
					ctx.datadog.apiKey,
					ctx.datadog.appKey,
					ctx.datadog.site,
				),
				fetchDatadogEnvironments(
					ctx.datadog.apiKey,
					ctx.datadog.appKey,
					ctx.datadog.site,
				),
			]);
		loadSpinner.succeed(
			`Loaded ${selectedFlags.length} LD flag(s) · ${ldEnvironments.length} LD environment(s) · ${datadogFlags.length} Datadog flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		loadSpinner.fail('Failed to load data');
		console.error(chalk.red(`  ${formatLoadError(err)}`));
		process.exit(1);
	}

	let envMapping: Map<string, DatadogEnvironment>;
	try {
		({ envMapping } = resolveLDEnvMap(ni.envMap, ldEnvironments, datadogEnvs));
	} catch (err) {
		console.error(
			chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`),
		);
		process.exit(1);
	}

	return {
		selectedFlags,
		envMapping,
		extras: {
			ldApiKey,
			projectKey: selectedProject.key,
			projectName: selectedProject.name,
			datadogFlags,
			// Default to skip for cross-project conflicts in non-interactive mode.
			conflictResolution: { action: 'skip' },
			targetKeyBySource,
		},
	};
}
