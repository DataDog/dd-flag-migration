#!/usr/bin/env node
import chalk from 'chalk';
import { type GetAssignmentsArgs, parseGetAssignmentsArgs } from './args.js';
import { filterableSelect } from './components/FilterableSelect.js';
import { HEADER_SUBTITLES, Header } from './components/Header.js';
import { input } from './components/Input.js';
import { PromptCancelledError, renderStatic } from './components/mount.js';
import { select } from './components/Select.js';
import { spinner } from './components/Spinner.js';
import { fetchDatadogEnvironments } from './datadog/api.js';
import {
	DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
	fetchPrecomputedAssignmentsWithStats,
	parsePrecomputedAssignmentsSubject,
} from './datadog/precomputed-assignments.js';
import type {
	DatadogEnvironment,
	PrecomputedAssignmentsSubject,
} from './datadog/types.js';
import {
	formatAssignmentsStats,
	saveAssignmentsResponse,
} from './get-assignments/output.js';
import { requireEnvVars } from './helpers/env.js';
import { formatAxiosError } from './helpers/format-axios-error.js';
import { promptForDatadogSite } from './helpers/prompt-for-datadog-site.js';

const DEFAULT_SUBJECT_JSON = JSON.stringify(
	DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
);
const SDK = { name: 'dd-flag-migration', version: 'dev' };

type InteractiveArgs = Extract<GetAssignmentsArgs, { interactive: true }>;
type StandaloneArgs = Extract<GetAssignmentsArgs, { interactive: false }>;

async function fetchAndSaveAssignments({
	clientToken,
	site,
	ddEnv,
	subject,
}: {
	clientToken: string;
	site: string;
	ddEnv: string;
	subject: PrecomputedAssignmentsSubject;
}): Promise<{ assignmentCount: number; stats: string }> {
	const result = await fetchPrecomputedAssignmentsWithStats({
		clientToken,
		site,
		ddEnv,
		subject,
		sdk: SDK,
	});
	const saved = saveAssignmentsResponse(result.response);
	const assignmentCount = Object.keys(
		result.response.data.attributes.flags,
	).length;

	return {
		assignmentCount,
		stats: formatAssignmentsStats({
			httpStatus: result.httpStatus,
			durationMs: result.durationMs,
			assignmentCount,
			ddEnv,
			subjectKey: subject.targeting_key,
			saved,
		}),
	};
}

async function selectDdEnv(
	environments: DatadogEnvironment[],
): Promise<string> {
	const available = environments.filter(
		(environment) => environment.queries.length > 0,
	);
	if (available.length === 0) {
		throw new Error(
			'No Datadog environments have DD_ENV queries configured. Configure one in Feature Flags → Environments → Edit.',
		);
	}

	const environment = await filterableSelect<DatadogEnvironment>({
		message: 'Select the Datadog environment:',
		choices: available
			.slice()
			.sort((a, b) => {
				if (a.is_production !== b.is_production) {
					return a.is_production ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			})
			.map((candidate) => ({
				name: `${candidate.name}${candidate.is_production ? `  ${chalk.bgRed.white(' Prod ')}` : ''}  ${chalk.gray(`(${candidate.queries.join(', ')})`)}`,
				value: candidate,
			})),
		pageSize: Math.max(5, (process.stdout.rows ?? 24) - 9),
	});
	if (environment === null) throw new PromptCancelledError();

	if (environment.queries.length === 1) return environment.queries[0];

	return select<string>({
		message: `Select the DD_ENV query for ${environment.name}:`,
		choices: environment.queries.map((query) => ({
			name: query,
			value: query,
		})),
	});
}

async function selectSubject(): Promise<PrecomputedAssignmentsSubject> {
	const mode = await select<'default' | 'custom'>({
		message: 'Select the evaluation subject:',
		default: 'default',
		choices: [
			{
				name: `Use default subject — ${DEFAULT_SUBJECT_JSON}`,
				short: 'Default subject',
				value: 'default',
			},
			{
				name: 'Enter a custom subject as JSON',
				short: 'Custom subject',
				value: 'custom',
			},
		],
	});
	if (mode === 'default') return DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT;

	const raw = await input({
		message: 'Enter the subject JSON:',
		hint: 'Required fields: targeting_key and targeting_attributes.',
		validate: (value) => {
			try {
				parsePrecomputedAssignmentsSubject(value);
				return true;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
	return parsePrecomputedAssignmentsSubject(raw);
}

async function runStandalone(args: StandaloneArgs): Promise<void> {
	const clientToken = requireEnvVars(['DD_CLIENT_TOKEN']).DD_CLIENT_TOKEN;
	const site = args.datadogSite ?? requireEnvVars(['DD_SITE']).DD_SITE;
	const result = await fetchAndSaveAssignments({
		clientToken,
		site,
		ddEnv: args.ddEnv,
		subject: args.subject ?? DEFAULT_PRECOMPUTED_ASSIGNMENTS_SUBJECT,
	});
	console.log(result.stats);
}

async function runInteractive(args: InteractiveArgs): Promise<void> {
	const env = requireEnvVars(['DD_API_KEY', 'DD_APP_KEY', 'DD_CLIENT_TOKEN']);

	process.stdout.write('\x1Bc');
	await renderStatic(<Header subtitle={HEADER_SUBTITLES.getAssignments} />);
	const site = await promptForDatadogSite(args.datadogSite);

	const loading = spinner('Fetching Datadog environments…').start();
	let environments: DatadogEnvironment[];
	try {
		environments = await fetchDatadogEnvironments(
			env.DD_API_KEY,
			env.DD_APP_KEY,
			site,
		);
		loading.succeed(`Found ${environments.length} environment(s)`);
	} catch (error) {
		loading.fail('Could not load Datadog environments');
		throw error;
	}

	const ddEnv = args.ddEnv ?? (await selectDdEnv(environments));
	const subject = args.subject ?? (await selectSubject());
	const fetching = spinner('Fetching precomputed assignments…').start();
	try {
		const result = await fetchAndSaveAssignments({
			clientToken: env.DD_CLIENT_TOKEN,
			site,
			ddEnv,
			subject,
		});
		fetching.succeed(`Fetched ${result.assignmentCount} assignment(s)`);
		console.log(`\n${result.stats}`);
	} catch (error) {
		fetching.fail('Could not fetch precomputed assignments');
		throw error;
	}
}

async function main(): Promise<void> {
	const args = parseGetAssignmentsArgs(process.argv.slice(2));
	if (args.interactive) {
		await runInteractive(args);
	} else {
		await runStandalone(args);
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
