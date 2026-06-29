import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
	filterableCheckbox,
	filterableSelect,
} from '../filterable-checkbox.js';
import type { DatadogEnvironment, DatadogFlagEntry } from '../types.js';
import type { LDProject } from './api.js';
import { type ConflictResolution, classifyConflict } from './conflicts.js';
import type { LDEnvironment, LDFlag } from './types.js';

// ─── Screen helpers ──────────────────────────────────────────────────────────

export function clearScreen(): void {
	process.stdout.write('\x1Bc');
}

export function printHeader(): void {
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
			chalk.hex('#632CA6')('          LaunchDarkly → Datadog          ') +
			purple('║'),
	);
	console.log(purple('╚══════════════════════════════════════════╝'));
	console.log();
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export function ddEnvLabel(env: DatadogEnvironment): string {
	const prodBadge = env.is_production
		? `  ${chalk.bgHex('#632CA6').white(' Prod ')}`
		: '';
	return `${env.name}${prodBadge}`;
}

export function flagLabel(
	flag: LDFlag,
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	conflictResolution?: ConflictResolution,
): string {
	const classification = classifyConflict(datadogFlags, projectKey, flag.key);
	const name = flag.name;
	const key = chalk.gray(`(${flag.key})`);
	const kind = flag.kind === 'boolean' ? '' : chalk.dim(` [${flag.kind}]`);

	let indicator: string;
	let badge: string;

	switch (classification.type) {
		case 'same_project':
		case 'manual':
			indicator = chalk.green('✓');
			badge = `  ${chalk.bgGreen.black(' In Datadog — will sync targeting ')}`;
			break;
		case 'cross_project':
			if (conflictResolution?.action === 'prefix') {
				indicator = chalk.hex('#632CA6')('⊕');
				badge = `  ${chalk.bgHex('#632CA6').white(` Will prefix with ${conflictResolution.prefix}- `)}`;
			} else {
				indicator = chalk.red('✗');
				badge = `  ${chalk.bgRed.white(' Key conflict — will skip ')}`;
			}
			break;
		default:
			indicator = ' ';
			badge = '';
	}

	return `${indicator}  ${name}  ${key}${kind}${badge}`;
}

// ─── Prompt steps ────────────────────────────────────────────────────────────

export async function selectProject(
	projects: LDProject[],
): Promise<LDProject | null> {
	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(projects.length))} LaunchDarkly project(s)`,
		),
	);
	console.log();

	const pageSize = Math.max(
		3,
		Math.min(projects.length, (process.stdout.rows ?? 24) - 9),
	);

	const choices = projects.map((p) => ({
		name: `${p.name}  ${chalk.gray(`(${p.key})`)}`,
		value: p,
		short: p.name,
	}));

	return filterableSelect<LDProject>({
		message: 'Select a LaunchDarkly project to migrate:',
		choices,
		pageSize,
	});
}

export async function selectLDEnvironments(
	ldEnvs: LDEnvironment[],
	previouslySelected: string[] = [],
): Promise<LDEnvironment[] | null> {
	const activeEnvs = ldEnvs.filter((env) => !env.archived);
	const archivedCount = ldEnvs.length - activeEnvs.length;

	const previousSet = new Set(previouslySelected);

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(activeEnvs.length))} environment(s) in the project`,
		) +
			(archivedCount > 0
				? chalk.gray(` (${archivedCount} archived environment(s) hidden)`)
				: ''),
	);
	console.log();

	const pageSize = Math.max(
		3,
		Math.min(activeEnvs.length, (process.stdout.rows ?? 24) - 9),
	);

	return filterableCheckbox<LDEnvironment>({
		message: 'Select LaunchDarkly environments to migrate:',
		choices: activeEnvs.map((env) => {
			const label =
				env.name !== env.key
					? `${env.name} ${chalk.gray(`(${env.key})`)}`
					: env.key;
			return {
				name: label,
				value: env,
				checked: previousSet.has(env.key),
			};
		}),
		pageSize,
	});
}

export async function linkEnvironments(
	ldEnvs: LDEnvironment[],
	ddEnvs: DatadogEnvironment[],
	previousMapping: Map<string, DatadogEnvironment>,
): Promise<Map<string, DatadogEnvironment> | null> {
	const mapping = new Map<string, DatadogEnvironment>(previousMapping);
	let i = 0;

	while (i < ldEnvs.length) {
		const ldEnv = ldEnvs[i];
		const prevChoice = mapping.get(ldEnv.key);

		clearScreen();
		printHeader();
		console.log(
			chalk.bold('Linking environment ') +
				chalk.green(`${i + 1}`) +
				chalk.bold(' of ') +
				chalk.green(`${ldEnvs.length}`) +
				chalk.bold(':') +
				`  ${chalk.cyan(ldEnv.name)}` +
				(ldEnv.name !== ldEnv.key ? chalk.gray(` (${ldEnv.key})`) : ''),
		);
		console.log();

		type LinkChoice = DatadogEnvironment | null;

		const result = await select<LinkChoice>({
			message: 'Select the matching Datadog environment:',
			choices: [
				{ name: chalk.dim('← Back'), value: null, short: 'Back' },
				...ddEnvs.map((env) => ({
					name: ddEnvLabel(env),
					value: env as LinkChoice,
					short: env.name,
				})),
			],
			default: prevChoice,
		});

		if (result === null) {
			if (i === 0) return null;
			i--;
		} else {
			mapping.set(ldEnv.key, result);
			i++;
		}
	}

	return mapping;
}

export async function selectFlags(
	flags: LDFlag[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	previouslySelected: LDFlag[] = [],
	conflictResolution?: ConflictResolution,
): Promise<LDFlag[] | null> {
	let inDatadogCount = 0;
	let prefixedCount = 0;
	let skipCount = 0;
	for (const f of flags) {
		const c = classifyConflict(datadogFlags, projectKey, f.key);
		if (c.type === 'same_project' || c.type === 'manual') inDatadogCount++;
		if (c.type === 'cross_project') {
			if (conflictResolution?.action === 'prefix') prefixedCount++;
			else skipCount++;
		}
	}
	const previousKeys = new Set(previouslySelected.map((f) => f.key));

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(flags.length))} feature flags in the project`,
		),
	);
	if (inDatadogCount > 0) {
		console.log(
			chalk.gray(
				`  ${inDatadogCount} flag(s) already exist in Datadog (will sync targeting for new environments) `,
			) + chalk.green('✓'),
		);
	}
	if (prefixedCount > 0) {
		console.log(
			chalk.hex('#632CA6')(
				`  ${prefixedCount} flag(s) will be prefixed with ${(conflictResolution as { action: 'prefix'; prefix: string }).prefix}-`,
			),
		);
	}
	if (skipCount > 0) {
		console.log(
			chalk.red(
				`  ${skipCount} flag(s) have key conflicts and will be skipped`,
			),
		);
	}
	console.log();

	const sortedFlags = flags.slice().sort((a, b) => {
		const aType = classifyConflict(datadogFlags, projectKey, a.key).type;
		const bType = classifyConflict(datadogFlags, projectKey, b.key).type;
		const aDD = aType === 'same_project' || aType === 'manual' ? 0 : 1;
		const bDD = bType === 'same_project' || bType === 'manual' ? 0 : 1;
		if (aDD !== bDD) return aDD - bDD;
		return a.name.localeCompare(b.name);
	});

	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

	return filterableCheckbox<LDFlag>({
		message: 'Select flags to migrate to Datadog:',
		choices: sortedFlags.map((flag) => {
			const conflictType = classifyConflict(
				datadogFlags,
				projectKey,
				flag.key,
			).type;
			return {
				name: flagLabel(flag, datadogFlags, projectKey, conflictResolution),
				value: flag,
				checked: previousKeys.has(flag.key),
				migrated: conflictType === 'same_project' || conflictType === 'manual',
			};
		}),
		pageSize,
	});
}

// ─── Confirmation ────────────────────────────────────────────────────────────

export type ConfirmAction = 'migrate' | 'select-more' | 'cancel';

// Final confirmation prompt at the end of Phase A. Returns the user's choice;
// caller decides whether to build the plan, loop back to flag selection, or
// abort. No execution side-effects.
export async function confirmFlagSelection(
	flags: LDFlag[],
	dryRun: boolean,
): Promise<ConfirmAction> {
	if (flags.length === 0) {
		console.log(chalk.yellow('\nNo flags selected — nothing to migrate.'));
		const action = await select<'select-more' | 'cancel'>({
			message: 'What would you like to do?',
			choices: [
				{ name: 'Select flags', value: 'select-more' },
				{ name: 'Cancel', value: 'cancel' },
			],
		});
		return action;
	}

	console.log();
	console.log(
		chalk.bold(`You selected ${chalk.green(String(flags.length))} flag(s):`),
	);
	for (const f of flags) {
		console.log(chalk.gray(`  •  ${f.name}`) + chalk.dim(`  (${f.key})`));
	}
	console.log();

	const action = await select<ConfirmAction>({
		message: dryRun
			? `Simulate migration of ${flags.length} flag(s)?`
			: `Migrate ${flags.length} flag(s) to Datadog?`,
		choices: [
			{
				name: dryRun
					? `Simulate ${flags.length} flag(s)`
					: `Migrate ${flags.length} flag(s)`,
				value: 'migrate',
			},
			{ name: 'Select more flags', value: 'select-more' },
			{ name: 'Cancel', value: 'cancel' },
		],
	});

	if (action === 'cancel') {
		console.log(chalk.yellow('\nMigration cancelled.'));
	}
	return action;
}
