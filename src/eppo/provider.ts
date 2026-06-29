import axios from 'axios';
import chalk from 'chalk';
import { fetchDatadogEnvironments, fetchDatadogFlagKeys } from '../datadog.js';
import type { MigrationPlan, ProviderContext } from '../provider/types.js';
import type { DatadogEnvironment } from '../types.js';
import { extractEnvironments, fetchEppoFlags } from './api.js';
import { resolveEppoEnvMap, resolveEppoFlags } from './non-interactive.js';
import {
	clearScreen,
	confirmFlagSelection,
	linkEnvironments,
	printHeader,
	selectEnvironments,
	selectFlags,
} from './prompts.js';
import type { EppoFlag, EppoFlagEnvironment } from './types.js';

// Provider-specific data carried through Phase B execution. Datadog flag keys
// are loaded once during Phase A; the Eppo API key was validated upstream and
// is threaded through so Phase B (audience migration) can use it.
export interface EppoExtras {
	eppoApiKey: string;
	datadogKeys: Map<string, string>;
}

export async function selectEppoMigrationPlan(
	ctx: ProviderContext,
): Promise<MigrationPlan<EppoFlag, number, EppoExtras> | null> {
	// EPPO_API_KEY presence was validated in src/index.ts before this runs.
	// biome-ignore lint/style/noNonNullAssertion: validated upstream
	const apiKey = process.env.EPPO_API_KEY!.trim();

	if (ctx.nonInteractive) {
		console.log();
		console.log(chalk.gray('  Running in non-interactive mode'));
		if (ctx.dryRun) {
			console.log(
				chalk.bold.yellow('  Dry run mode — no flags will be created'),
			);
		}
		console.log();
	} else {
		console.log();
	}

	const spinner = ctx.promptKit.spinner('Loading data…').start();
	let flags: EppoFlag[] = [];
	let datadogKeys: Map<string, string> = new Map();
	let datadogEnvs: DatadogEnvironment[] = [];

	try {
		[flags, datadogKeys, datadogEnvs] = await Promise.all([
			fetchEppoFlags(apiKey, {
				onProgress: (fetched) => {
					spinner.text = `Loading data… (${fetched} Eppo flag${fetched === 1 ? '' : 's'} fetched)`;
				},
			}),
			fetchDatadogFlagKeys(
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
		spinner.succeed(
			`Loaded ${flags.length} Eppo flag(s) · ${datadogEnvs.length} Datadog environment(s)`,
		);
	} catch (err) {
		spinner.fail('Failed to load data');
		if (axios.isAxiosError(err)) {
			const msg =
				(err.response?.data as { message?: string } | undefined)?.message ??
				err.message;
			console.error(chalk.red(`  ${msg}`));
		} else if (err instanceof Error) {
			console.error(chalk.red(`  ${err.message}`));
		}
		process.exit(1);
	}

	const eppoEnvironments = extractEnvironments(flags);
	const extras: EppoExtras = { eppoApiKey: apiKey, datadogKeys };

	// ── Non-interactive: resolve from CLI args and return a plan ────────────
	if (ctx.nonInteractive) {
		const ni = ctx.nonInteractive;
		let envMapping: Map<number, DatadogEnvironment>;
		let selectedFlags: EppoFlag[];
		try {
			({ envMapping } = resolveEppoEnvMap(
				ni.envMap,
				eppoEnvironments,
				datadogEnvs,
			));
			selectedFlags = resolveEppoFlags(
				ni.flagKeys,
				flags,
				new Set(envMapping.keys()),
			);
		} catch (err) {
			console.error(
				chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`),
			);
			process.exit(1);
		}
		return { selectedFlags, envMapping, extras };
	}

	// ── Interactive: prompt loop ────────────────────────────────────────────
	let prevSelectedEnvs: EppoFlagEnvironment[] = [];
	let prevEnvMapping = new Map<number, DatadogEnvironment>();
	let prevSelectedFlags: EppoFlag[] = [];

	// eslint-disable-next-line no-constant-condition
	while (true) {
		let selectedEnvs: EppoFlagEnvironment[];

		if (eppoEnvironments.length > 0) {
			clearScreen();
			printHeader();
			const envResult = await selectEnvironments(
				flags,
				eppoEnvironments,
				prevSelectedEnvs,
			);
			if (envResult === null) return null; // escaped → exit
			if (envResult.length === 0) {
				console.log(
					chalk.yellow(
						'\n  Please select at least one environment to migrate from.\n',
					),
				);
				continue;
			}
			prevSelectedEnvs = envResult;
			selectedEnvs = envResult;
			// Reset flag selections if the environment selection changed
			const envIds = new Set(envResult.map((e) => e.id));
			const prevEnvIds = new Set(
				prevSelectedFlags.flatMap(
					(f) => f.environments?.map((e) => e.id) ?? [],
				),
			);
			if ([...envIds].some((id) => !prevEnvIds.has(id))) prevSelectedFlags = [];
		} else {
			selectedEnvs = [];
		}

		while (true) {
			const mapping = await linkEnvironments(
				selectedEnvs,
				datadogEnvs,
				prevEnvMapping,
			);
			if (mapping === null) break; // escaped → back to Eppo env selection

			prevEnvMapping = mapping;

			while (true) {
				clearScreen();
				printHeader();
				const flagResult = await selectFlags(
					flags,
					datadogKeys,
					selectedEnvs,
					prevSelectedFlags,
				);
				if (flagResult === null) break; // escaped → back to linking

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

		if (eppoEnvironments.length === 0) return null; // nothing to go back to
	}
}
