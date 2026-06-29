import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { filterableCheckbox } from '../filterable-checkbox.js';
import type { DatadogEnvironment } from '../types.js';
import type { EppoFlag, EppoFlagEnvironment } from './types.js';

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
			chalk.hex('#632CA6')('              Eppo → Datadog              ') +
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

export function envLabel(env: EppoFlagEnvironment, flagCount: number): string {
	const prodBadge = env.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : '';
	return `${env.name}${prodBadge}  ${chalk.gray(`(${flagCount} flags)`)}`;
}

export function flagLabel(flag: EppoFlag, inDatadog: boolean): string {
	const indicator = inDatadog ? chalk.green('✓') : ' ';
	const name = flag.name;
	const key = chalk.gray(`(${flag.key})`);
	const badge = inDatadog
		? `  ${chalk.bgGreen.black(' In Datadog — will sync targeting ')}`
		: '';
	return `${indicator}  ${name}  ${key}${badge}`;
}

// ─── Prompt steps ────────────────────────────────────────────────────────────

export async function linkEnvironments(
	eppoEnvs: EppoFlagEnvironment[],
	ddEnvs: DatadogEnvironment[],
	previousMapping: Map<number, DatadogEnvironment>,
): Promise<Map<number, DatadogEnvironment> | null> {
	const mapping = new Map<number, DatadogEnvironment>(previousMapping);
	let i = 0;

	while (i < eppoEnvs.length) {
		const eppoEnv = eppoEnvs[i];
		const prevChoice = mapping.get(eppoEnv.id);

		clearScreen();
		printHeader();
		console.log(
			chalk.bold('Linking environment ') +
				chalk.green(`${i + 1}`) +
				chalk.bold(' of ') +
				chalk.green(`${eppoEnvs.length}`) +
				chalk.bold(':') +
				`  ${chalk.cyan(eppoEnv.name)}` +
				(eppoEnv.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : ''),
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
			if (i === 0) return null; // back to Eppo env selection
			i--;
		} else {
			mapping.set(eppoEnv.id, result);
			i++;
		}
	}

	return mapping;
}

export async function selectEnvironments(
	flags: EppoFlag[],
	environments: EppoFlagEnvironment[],
	previouslySelected: EppoFlagEnvironment[] = [],
): Promise<EppoFlagEnvironment[] | null> {
	const flagCount = new Map<number, number>();
	for (const flag of flags) {
		for (const env of flag.environments ?? []) {
			flagCount.set(env.id, (flagCount.get(env.id) ?? 0) + 1);
		}
	}

	const previousIds = new Set(previouslySelected.map((e) => e.id));

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(environments.length))} environments in Eppo`,
		),
	);
	console.log();

	const pageSize = Math.max(
		3,
		Math.min(environments.length, (process.stdout.rows ?? 24) - 9),
	);

	return filterableCheckbox<EppoFlagEnvironment>({
		message: 'Select environments to migrate from:',
		choices: environments.map((env) => ({
			name: envLabel(env, flagCount.get(env.id) ?? 0),
			value: env,
			checked: previousIds.has(env.id),
		})),
		pageSize,
	});
}

export async function selectFlags(
	flags: EppoFlag[],
	datadogKeys: Map<string, string>,
	selectedEnvs: EppoFlagEnvironment[],
	previouslySelected: EppoFlag[] = [],
): Promise<EppoFlag[] | null> {
	const selectedEnvIds = new Set(selectedEnvs.map((e) => e.id));
	const visibleFlags =
		selectedEnvIds.size > 0
			? flags.filter((f) =>
					f.environments?.some((e) => selectedEnvIds.has(e.id)),
				)
			: flags;

	const inDatadogCount = visibleFlags.filter((f) =>
		datadogKeys.has(f.key),
	).length;
	const previousKeys = new Set(previouslySelected.map((f) => f.key));

	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(visibleFlags.length))} feature flags in Eppo`,
		),
	);
	if (inDatadogCount > 0) {
		console.log(
			chalk.gray(
				`  ${inDatadogCount} flag(s) already exist in Datadog (will sync targeting for new environments) `,
			) + chalk.green('✓'),
		);
	}
	console.log();

	const sortedFlags = visibleFlags.slice().sort((a, b) => {
		// Flags already in Datadog float to the top
		const aDD = datadogKeys.has(a.key) ? 0 : 1;
		const bDD = datadogKeys.has(b.key) ? 0 : 1;
		if (aDD !== bDD) return aDD - bDD;
		return a.name.localeCompare(b.name);
	});

	const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 9);

	return filterableCheckbox<EppoFlag>({
		message: 'Select flags to migrate to Datadog:',
		choices: sortedFlags.map((flag) => ({
			name: flagLabel(flag, datadogKeys.has(flag.key)),
			value: flag,
			checked: previousKeys.has(flag.key),
			migrated: datadogKeys.has(flag.key),
		})),
		pageSize,
	});
}
