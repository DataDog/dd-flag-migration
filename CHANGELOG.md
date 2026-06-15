# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] — 2026-06-15

### Migration — LaunchDarkly

- Fix: fold empty segments during migration instead of creating synthetic saved filters (#80)
  - Empty segments (no rules, no included targets) match no contexts; non-negated references make the containing rule unreachable and are omitted, negated references are always true and the clause is dropped
  - Multi-segment OR clauses drop false empty-segment constants and continue using real saved filters
  - Records segment migration stats in migration output so Phase 1 outcomes are visible without re-running

### Export

- Fix: include skip reason in the `Error` column of the `.xlsx` migration export for both Eppo and LaunchDarkly (#81)
  - Also fixes a bug in the Eppo migration where the "no variants" skip case was not tracked in `skippedFlags`, causing the reason to be absent from the JSON export

## [1.0.0] — 2026-06-15

### CLI — Non-interactive / scripted mode

- Add `--interactive=false` flag that bypasses all prompts for CI and scripted usage (#77)
  - Accepts `--provider`, `--env-map`, `--feature-flag`, `--project`, `--datadog-site`, `--dry-run`, and `--export` as pure CLI arguments
  - Exits with code 1 when any per-flag migration fails, so CI callers get a non-zero status on partial failure
  - Rejects archived LaunchDarkly environments passed via `--env-map`; the error message lists only non-archived environments
  - Validates that each requested Eppo flag exists in a mapped source environment before starting
  - Omits terminal escape sequences (clear-screen) so scrollback is preserved in CI logs
  - Emits JSON output for migration results in non-interactive runs
  - Handles LaunchDarkly cross-project key conflicts non-interactively
- Replace `--no-export` with `--export=<bool>` (default: `false`) so scripted runs only write an `.xlsx` when explicitly opted in (#77)

### CLI — Credential handling

- Replace interactive API/SDK key prompts with environment variables (#76)
  - Required for migration: `DD_API_KEY`, `DD_APP_KEY`, and `EPPO_API_KEY` or `LAUNCHDARKLY_API_KEY`
  - Required for evaluation: `DD_API_KEY`, `DD_APP_KEY`, `DD_CLIENT_TOKEN`, and `EPPO_SDK_KEY` or `LAUNCHDARKLY_SDK_KEY`
  - Missing variables are reported to stderr with the full list of missing names and exit code 1
  - `datadogSite` preference continues to be saved and loaded from `~/.dd-flag-migration/config.json`
  - Removes the `--use-saved-keys` flag from the evaluate command
  - Adds `--datadog-site` as a CLI option for the evaluate command
  - Prints a reminder after evaluation when any test case differs, noting that SDK keys are scoped to a single environment

## [0.3.0] — 2026-06-08

### UX — Large migrations

- Show a real-time progress bar during migrations (#70)
  - ETA is calculated from a 20-flag sliding window and displayed as whole minutes or "< 1 min"
- Save a partial migration file when the user interrupts a migration with Ctrl+C (#70)
  - The file is written before exit if at least one flag was already processed; `success` is set to `false` to distinguish interrupted files from complete ones
- Add a tab toggle in the flag selection screen to hide flags already migrated to Datadog (#70)
  - The filter line shows how many flags are hidden; the toggle only appears when previously-migrated flags are present

### Migration — Eppo

- Fix: skip allocations with `percent_exposure: 0` (passthrough allocations) (#73)
  - Zero-exposure allocations are never served to users in Eppo; the migration now omits them instead of emitting a "Targeting all traffic" targeting rule with the raw variant weights
- Fix: correctly set `default_variant_key` per environment on sync (#74)
  - `default_variant_key` is now resolved independently per Datadog environment and written via the allocations-sync endpoint; environments with split or unresolvable defaults retain their targeting rule
  - Removes the spurious "Default / Targeting all traffic" targeting rule that appeared in the Datadog flag UI after re-migration
- Fix: use slugified variant name as the Datadog variant key for Eppo JSON flags (#71)
  - Eppo JSON flags can store the full JSON payload as `variant_key`, which exceeds Datadog's 200-byte limit; the migration now uses a lowercase slugified form of the variation name as the key
- Fix: wrap JSON array variant values in `{"value": [...]}` before submission (#72)
  - Datadog requires JSON variant values to be objects; array-typed JSON variants from Eppo are now wrapped automatically

### Migration — LaunchDarkly

- Fix: wrap JSON array variant values in `{"value": [...]}` before submission (#72)

## [0.2.1] — 2026-05-28

### Migration — Eppo

- Fix default variant mapping for Eppo flags whose only allocation is a pure default (`is_default: true` with no targeting rules) (#67)
  - These allocations are now translated to `default_variant_key` on the Datadog flag instead of a "Targeting all traffic" targeting rule, matching Eppo's intended evaluation semantics
  - Re-migration (sync) also sets `default_variant_key` and forces a PUT to clear any stale catch-all targeting rules left by previous migrations
  - Flags with conflicting default variants across environments fall back to the previous targeting-rule behavior
  - Extraction aborts and falls back when any environment's default cannot be unambiguously resolved (split weights or unknown variation ID)

### CLI

- Add `--version` / `-V` flag that prints the installed tool version and exits
- Document global options (`-V`/`--version`, `-h`/`--help`) in help output

## [0.2.0] — 2026-05-27

### Migration — Eppo

- Migrate Eppo audiences as Datadog saved filters using condition fingerprinting (#64)
  - Audiences are discovered by hashing allocation targeting rules into stable fingerprints (the Eppo flags API inlines audience conditions without exposing audience IDs)
  - Matching rules are replaced with `saved_filter_id` references; duplicates within one allocation are deduplicated
  - Audience migration runs as Phase 1, before flag migration
- Translate Eppo semver targeting conditions to `SEMVER_*` Datadog operators (#61)
  - `LT`/`LTE`/`GT`/`GTE` conditions on valid semver values now emit `SEMVER_LT`/`SEMVER_LTE`/`SEMVER_GT`/`SEMVER_GTE` instead of numeric operators
  - Flags with semver targeting automatically set `distribution_channel: CLIENT` as required by the Datadog API
- Sync Eppo `tag_names` to Datadog flag tags on create and re-migration (#62)
  - Tags are now synced on re-migration even when no targeting changes are detected
  - Tag sync replaces rather than merges, so removed tags propagate correctly

### Reliability

- Rate-limit handling for Eppo and Datadog APIs (#63)
  - Eppo flag fetch now paginates via `offset`/`limit` with progress surfaced in the loading spinner
  - Eppo client retries `429` responses with exponential backoff
  - Datadog client reads `x-ratelimit-remaining` and `x-ratelimit-reset` headers; proactively pauses requests when remaining drops to 5 or below, and retries `429` responses using the reset header delay

## [0.1.1] — 2026-05-19

### CLI

- Prompt for Application key before API key to match the order of the help text shown above the prompts
- Auto-select the first available DD_ENV query during evaluation instead of prompting the user to choose

### Requirements

- Require Node.js >=18

## [0.1.0] — 2026-05-11

First public release.

### Migration — Eppo

- Migrate Eppo flags to Datadog via interactive CLI
- Map variation types (`BOOLEAN`, `INTEGER`, `NUMERIC`, `JSON`, `STRING`)
- Translate targeting filters and targeting rules from Eppo allocations
- Enable flags in the Datadog environments that correspond to active Eppo environments
- Skip flags of unsupported types (`BANDIT`, `LAYER`)

### Migration — LaunchDarkly

- Migrate LaunchDarkly flags to Datadog via interactive CLI
- Map flag types (`boolean`, multivariate) to Datadog value types (`BOOLEAN`, `STRING`, `NUMERIC`, `JSON`)
- Convert individual user targets into `ONE_OF` targeting conditions on the `key` attribute
- Translate targeting rule clauses: `in`, `contains`, `startsWith`, `endsWith`, `matches`, numeric comparisons (`lt`, `lte`, `gt`, `gte`), and semver comparisons (`semVerEqual`, `semVerLessThan`, `semVerGreaterThan`, `semVerLessThanOrEqual`, `semVerGreaterThanOrEqual`)
- Support negated operators (De Morgan's law inversion for comparison operators; `NOT_ONE_OF`, `NOT_MATCHES`)
- Convert percentage rollouts from LaunchDarkly's 100,000-weight scale to Datadog's 0–100 scale
- Create a fallthrough (default) targeting filter per environment
- Enable flags in Datadog environments where the flag was enabled (`on: true`) in LaunchDarkly
- Set `distribution_channel: CLIENT` for flags with semver targeting conditions
- Sync targeting for flags that already exist in Datadog when new environments are added
- Detect and skip archived flags
- Detect progressive rollouts via the releases API and skip flags with rollouts still in progress
- Warn on flags with prerequisites (migrated but prerequisites are not enforced in Datadog)
- Skip flags that use unsupported date-based operators (`before`, `after`)

#### Segment migration (Phase 1)

- Discover all LD segments referenced by selected flags and migrate them as Datadog saved filters
- Non-negated `segmentMatch` clauses → OR fan-out targeting rules (one rule per segment)
- Negated `segmentMatch` clauses → AND-combined saved filter conditions (all segments required)
- Cap fan-out at 100 combinations; skip the flag if exceeded

#### Cross-project conflict resolution

- Detect flag key conflicts between LaunchDarkly projects migrating into the same Datadog organization
- Offer skip or prefix options for conflicting flags; prefix is applied to the Datadog flag key

#### Team-based access control (RBAC)

- Walk LaunchDarkly custom roles and team assignments to identify teams with edit access to the project
- Translate those teams to Datadog restriction policies on migrated flags
- Interactively resolve team key mismatches between LaunchDarkly and Datadog
- Migrate LaunchDarkly flag tags to Datadog

### Evaluation

- Compare flag evaluations side-by-side between Eppo and Datadog using source SDK and Datadog CDN
- Auto-generate test cases from each flag's targeting rules
- Import custom test cases from a CSV file
- Display results in a table with match/mismatch highlighting

### CLI

- Interactive provider selection (Eppo, LaunchDarkly)
- Credential prompts with server-side validation; credentials saved to `~/.dd-flag-migration/config.json`
- Dry run mode (`--dry-run`) writes all API requests to a timestamped JSON file without creating flags
- Multi-site support (`datadogSite` config key) for EU, US3, US5, AP1 regions
- Export migration results to `.xlsx`
- Supply chain security via `@lavamoat/allow-scripts` (all dependency install scripts blocked by default)
