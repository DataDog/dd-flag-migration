import type { Ora } from 'ora';
import type { MigrationProgressBar } from '../progress-bar.js';
import type { DatadogEnvironment } from '../types.js';

// ─── Non-Interactive Hints ───────────────────────────────────────────────────

// The shared shape parsed by src/args.ts. Providers interpret whichever fields
// they need (e.g. LaunchDarkly reads projectKey; Eppo ignores it).
export interface NonInteractiveHints {
	envMap: Array<[string, string]>;
	flagKeys: string[];
	projectKey?: string;
}

// ─── PromptKit ───────────────────────────────────────────────────────────────

// Shared UI primitives available to providers during Phase A. Wraps inquirer,
// ora, and chalk so providers don't import them directly — keeps look-and-feel
// consistent across providers without forcing identical prompt sequencing.

export interface PromptKitTheme {
	brand: (s: string) => string;
	muted: (s: string) => string;
	success: (s: string) => string;
	warn: (s: string) => string;
	error: (s: string) => string;
	cyan: (s: string) => string;
	bold: (s: string) => string;
}

export interface SelectChoice<T> {
	name: string;
	value: T;
	short?: string;
	description?: string;
}

export interface FilterableChoice<T> {
	name: string;
	value: T;
	checked?: boolean;
	migrated?: boolean;
}

export interface PromptKit {
	// Screen
	printHeader(): void;
	clearScreen(): void;

	// Status indicators
	spinner(text?: string): Ora;
	progressBar(total: number, subheader?: string): MigrationProgressBar;

	// Prompts (return null when the user escapes, where supported)
	select<T>(opts: {
		message: string;
		choices: Array<SelectChoice<T>>;
		default?: T;
	}): Promise<T>;
	confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
	input(opts: {
		message: string;
		default?: string;
		validate?: (v: string) => true | string;
	}): Promise<string>;
	filterableCheckbox<T>(opts: {
		message: string;
		choices: Array<FilterableChoice<T>>;
		pageSize?: number;
	}): Promise<T[] | null>;
	filterableSelect<T>(opts: {
		message: string;
		choices: Array<FilterableChoice<T>>;
		pageSize?: number;
	}): Promise<T | null>;

	// Theming
	theme: PromptKitTheme;
}

// ─── Provider Context ────────────────────────────────────────────────────────

export interface DatadogCredentials {
	apiKey: string;
	appKey: string;
	site: string;
}

export interface ProviderContext {
	promptKit: PromptKit;
	datadog: DatadogCredentials;
	dryRun: boolean;
	// Present when running with --interactive=false.
	nonInteractive?: NonInteractiveHints;
}

// ─── Migration Plan (Phase A output) ─────────────────────────────────────────

// The output of Phase A. The provider has already prompted the user (or
// resolved non-interactive args) and produced the concrete set of flags and
// environments to migrate. Each provider's `runX` entry point consumes this
// and runs provider-specific Phase B execution (see executeEppoMigration /
// executeLDMigration).
//
// Generic parameters:
//   TRawFlag   — the provider's raw flag shape (e.g. EppoFlag, LDFlag)
//   TEnvKey    — the type used to key the source env (Eppo: number, LD: string)
//   TExtras    — provider-specific extras carried into Phase B (e.g.
//                LaunchDarkly's project key + conflict resolution policy +
//                cached datadogFlags; Eppo's eppoApiKey + datadogKeys map)
export interface MigrationPlan<
	TRawFlag,
	TEnvKey extends string | number = string,
	TExtras = unknown,
> {
	selectedFlags: TRawFlag[];
	envMapping: Map<TEnvKey, DatadogEnvironment>;
	extras: TExtras;
}

// Each provider exposes a `selectXMigrationPlan(ctx)` free function (see
// src/eppo/provider.ts, src/launchdarkly/provider.ts) that fetches data,
// runs Phase A prompts (or resolves non-interactive args), and returns a
// MigrationPlan or null on cancel. Phase B execution lives per-provider —
// see executeEppoMigration / executeLDMigration — because the two providers
// diverged enough (LD has restriction policies, segment negation, conflict
// prefixing; Eppo has audience fingerprinting; output JSON schemas differ)
// that a shared orchestrator would mostly be a sequencer for provider-
// specific lambdas — organizational, not abstraction. No FlagProvider
// interface is needed because there's no polymorphic dispatch: the CLI
// directly calls runEppoMigration vs runLaunchDarklyMigration based on
// the --provider flag.
