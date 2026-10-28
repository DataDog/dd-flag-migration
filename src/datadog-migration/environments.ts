import chalk from 'chalk';
import { filterableCheckbox } from '../components/FilterableCheckbox.js';
import type {
	DatadogEnvironment,
	EnvironmentMapping,
} from '../datadog/types.js';

export function environmentLabel(environment: DatadogEnvironment): string {
	const prodBadge = environment.is_production
		? `  ${chalk.bgHex('#632CA6').white(' Prod ')}`
		: '';
	return `${environment.name}${prodBadge}`;
}

function normalizedName(name: string): string {
	return name.trim().toLowerCase();
}

/** Target environments whose name matches the source environment's name. */
export function suggestTargetEnvironments(
	source: DatadogEnvironment,
	targets: DatadogEnvironment[],
): DatadogEnvironment[] {
	const name = normalizedName(source.name);
	return targets.filter((target) => normalizedName(target.name) === name);
}

export async function selectSourceEnvironments(
	environments: DatadogEnvironment[],
	previouslySelected: DatadogEnvironment[],
	message: string,
): Promise<DatadogEnvironment[] | null> {
	const previousIds = new Set(previouslySelected.map((env) => env.id));
	console.log();
	console.log(
		chalk.bold(
			`Found ${chalk.green(String(environments.length))} environment(s) in the source org`,
		),
	);
	console.log();
	const pageSize = Math.max(
		3,
		Math.min(environments.length, (process.stdout.rows ?? 24) - 9),
	);
	return filterableCheckbox<DatadogEnvironment>({
		message,
		choices: environments.map((env) => ({
			name: environmentLabel(env),
			value: env,
			checked: previousIds.has(env.id),
		})),
		pageSize,
	});
}

/**
 * Link each selected source environment to one or more target environments.
 * On the first visit, target environments with the same name are pre-checked.
 * Returns null when the user backs out of the first environment.
 */
export async function linkDatadogEnvironments(
	sourceEnvironments: DatadogEnvironment[],
	targetEnvironments: DatadogEnvironment[],
	previousMapping: EnvironmentMapping<string>,
	printHeader: () => Promise<void>,
	targetOrgName?: string,
): Promise<EnvironmentMapping<string> | null> {
	const selectedIds = new Set(sourceEnvironments.map((env) => env.id));
	const mapping = new Map(
		[...previousMapping].filter(([id]) => selectedIds.has(id)),
	);
	let i = 0;
	let requiresSelection = false;

	while (i < sourceEnvironments.length) {
		const sourceEnvironment = sourceEnvironments[i];
		const assignedElsewhere = new Set(
			[...mapping]
				.filter(([id]) => id !== sourceEnvironment.id)
				.flatMap(([, environments]) => environments.map((env) => env.id)),
		);
		const available = targetEnvironments.filter(
			(env) => !assignedElsewhere.has(env.id),
		);
		const previous = mapping.get(sourceEnvironment.id);
		const checkedIds = new Set(
			(previous ?? suggestTargetEnvironments(sourceEnvironment, available)).map(
				(env) => env.id,
			),
		);

		process.stdout.write('\x1Bc');
		await printHeader();
		console.log(
			chalk.bold('Linking environment ') +
				chalk.green(`${i + 1}`) +
				chalk.bold(' of ') +
				chalk.green(`${sourceEnvironments.length}`) +
				chalk.bold(':') +
				`  ${chalk.cyan(sourceEnvironment.name)}` +
				(sourceEnvironment.is_production
					? `  ${chalk.bgHex('#632CA6').white(' Prod ')}`
					: ''),
		);
		console.log();
		if (requiresSelection) {
			console.log(
				chalk.yellow(
					'  Please select at least one matching target environment.\n',
				),
			);
		}

		const result = await filterableCheckbox<DatadogEnvironment>({
			message: `Select matching environments in the target org${targetOrgName ? ` [${targetOrgName}]` : ''}:`,
			choices: available.map((env) => ({
				name: environmentLabel(env),
				value: env,
				checked: checkedIds.has(env.id),
			})),
		});

		if (result === null) {
			requiresSelection = false;
			if (i === 0) return null;
			i--;
		} else if (result.length === 0) {
			requiresSelection = true;
		} else {
			requiresSelection = false;
			mapping.set(sourceEnvironment.id, result);
			i++;
		}
	}

	return mapping;
}

/**
 * Resolve `--env-map source,target` pairs by environment name. One source
 * environment may map to several target environments, but a target
 * environment can only receive one source environment.
 */
export function resolveDatadogEnvMap(
	pairs: Array<[string, string]>,
	sourceEnvironments: DatadogEnvironment[],
	targetEnvironments: DatadogEnvironment[],
): {
	envMapping: EnvironmentMapping<string>;
	selectedEnvs: DatadogEnvironment[];
} {
	const envMapping: EnvironmentMapping<string> = new Map();
	const selectedEnvs: DatadogEnvironment[] = [];
	const sourceByTarget = new Map<string, DatadogEnvironment>();
	for (const [sourceName, targetName] of pairs) {
		const source = sourceEnvironments.find((env) => env.name === sourceName);
		if (!source) {
			const available = sourceEnvironments.map((env) => env.name).join(', ');
			throw new Error(
				`Source org environment not found: "${sourceName}". Available: ${available}`,
			);
		}
		const target = targetEnvironments.find((env) => env.name === targetName);
		if (!target) {
			const available = targetEnvironments.map((env) => env.name).join(', ');
			throw new Error(
				`Target org environment not found: "${targetName}". Available: ${available}`,
			);
		}
		const existingSource = sourceByTarget.get(target.id);
		if (existingSource && existingSource.id !== source.id) {
			throw new Error(
				`Target org environment "${target.name}" cannot be mapped from both "${existingSource.name}" and "${source.name}"`,
			);
		}
		sourceByTarget.set(target.id, source);
		const mapped = envMapping.get(source.id) ?? [];
		if (!mapped.some((env) => env.id === target.id)) mapped.push(target);
		envMapping.set(source.id, mapped);
		if (!selectedEnvs.some((env) => env.id === source.id)) {
			selectedEnvs.push(source);
		}
	}
	return { envMapping, selectedEnvs };
}
