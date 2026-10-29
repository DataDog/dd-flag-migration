import { ArgParseError, parseBooleanFlag } from '../helpers/boolean-args.js';

export type EvaluationTarget = 'migration' | 'flag';

export type EvaluateArgs = {
	target: EvaluationTarget | undefined;
	testSubjectId: string | undefined;
	useLatestMigration: boolean | undefined;
	flagEnvironment: string | undefined;
	datadogSite: string | undefined;
	csvPath: string | undefined;
	forceShowTable: boolean | undefined;
	provider: string | undefined;
	flagKey: string | undefined;
	subjectCount: number | undefined;
	exportXlsx: boolean | undefined;
};

/** Keep display defaults separate from parsing and leave export tri-state. */
export function resolveEvaluateDefaults(args: EvaluateArgs): EvaluateArgs & {
	useLatestMigration: boolean;
	forceShowTable: boolean;
} {
	return {
		...args,
		useLatestMigration: args.useLatestMigration ?? false,
		forceShowTable: args.forceShowTable ?? false,
	};
}

/** Parse evaluation options without starting SDKs, prompts, or API requests. */
export function parseEvaluateArgs(args: string[]): EvaluateArgs {
	const useLatestMigration = parseBooleanFlag(args, '--use-latest-migration');
	const forceShowTable = parseBooleanFlag(args, '--show-table');
	const subjectArg = args.find((a) => a.startsWith('--test-subject-id='));
	const testSubjectId = subjectArg
		? subjectArg.slice('--test-subject-id='.length)
		: undefined;
	const envArg = args.find((a) => a.startsWith('--flag-environment='));
	const flagEnvironment = envArg
		? envArg.slice('--flag-environment='.length)
		: undefined;
	const siteArg = args.find((a) => a.startsWith('--datadog-site='));
	const datadogSite = siteArg
		? siteArg.slice('--datadog-site='.length).trim()
		: undefined;
	if (datadogSite !== undefined && datadogSite.length === 0) {
		throw new ArgParseError('--datadog-site must not be empty.');
	}
	const csvArg = args.find((a) => a.startsWith('--csv='));
	const csvPath = csvArg ? csvArg.slice('--csv='.length) : undefined;

	const argValue = (name: string): string | undefined => {
		const arg = args.find((a) => a.startsWith(`--${name}=`));
		return arg === undefined ? undefined : arg.slice(name.length + 3).trim();
	};
	const provider = argValue('provider')?.toLowerCase();
	const flagKey = argValue('flag');
	if (flagKey !== undefined && flagKey.length === 0) {
		throw new ArgParseError('--flag must not be empty.');
	}
	const subjectsArg = argValue('subjects');
	let subjectCount: number | undefined;
	if (subjectsArg !== undefined) {
		subjectCount = Number(subjectsArg);
		if (!/^\d+$/.test(subjectsArg) || subjectCount <= 0) {
			throw new ArgParseError('--subjects must be a positive integer.');
		}
	}

	// Only enabled boolean options participate in target inference.
	const targetArg = argValue('target');
	if (
		targetArg !== undefined &&
		targetArg !== 'migration' &&
		targetArg !== 'flag'
	) {
		throw new ArgParseError('--target must be "migration" or "flag".');
	}
	const exportXlsx = parseBooleanFlag(args, '--export');
	const usesFlagArgs =
		provider !== undefined ||
		flagKey !== undefined ||
		subjectCount !== undefined ||
		exportXlsx;
	const usesMigrationArgs =
		useLatestMigration ||
		testSubjectId !== undefined ||
		csvPath !== undefined ||
		forceShowTable;
	if (usesFlagArgs && usesMigrationArgs) {
		throw new ArgParseError(
			'--provider, --flag, --subjects, and --export evaluate a single flag; ' +
				'--use-latest-migration, --test-subject-id, --csv, and --show-table evaluate a migration. ' +
				'Use options for one target.',
		);
	}
	let target = targetArg as EvaluationTarget | undefined;
	if (target === undefined && usesFlagArgs) target = 'flag';
	if (target === undefined && usesMigrationArgs) target = 'migration';
	if (target === 'flag' && usesMigrationArgs) {
		throw new ArgParseError(
			'--use-latest-migration, --test-subject-id, --csv, and --show-table apply to --target=migration.',
		);
	}
	if (target === 'migration' && usesFlagArgs) {
		throw new ArgParseError(
			'--provider, --flag, --subjects, and --export apply to --target=flag.',
		);
	}

	return {
		target,
		testSubjectId,
		useLatestMigration,
		flagEnvironment,
		datadogSite,
		csvPath,
		forceShowTable,
		provider,
		flagKey,
		subjectCount,
		exportXlsx,
	};
}
