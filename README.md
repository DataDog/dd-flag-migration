# Datadog Feature Flag Migration Tool

A CLI tool for migrating feature flags from your current provider into [Datadog Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/), with side-by-side evaluation to verify the migration before you switch over.

**Supported providers:** Eppo, LaunchDarkly

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Yarn](https://yarnpkg.com/) (`npm install -g yarn`)

---

## Installation

Run without installing using `npx`:

```bash
# migrate flags
npx @datadog/dd-flag-migration migrate

# evaluate migrated flags
npx @datadog/dd-flag-migration evaluate
```

### Contributing / running from source

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Credentials you'll need

Credentials are read from environment variables. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running `migrate` or `evaluate`. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1.

### Required for `migrate`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_API_KEY` | always | Datadog → Organization Settings → API Keys |
| `DD_APP_KEY` | always | Datadog → Organization Settings → Application Keys |
| `EPPO_API_KEY` | provider = Eppo | Eppo → Configuration → API Keys |
| `LAUNCHDARKLY_API_KEY` | provider = LaunchDarkly | LaunchDarkly → Account settings → Authorization → Access tokens |

Your LaunchDarkly access token needs **Reader** role permissions (or a custom role with `viewProject` access) to read projects, environments, and flag configurations.

`EPPO_*` variables are checked only when you select Eppo as the source provider. `LAUNCHDARKLY_*` variables are checked only when you select LaunchDarkly. You don't need to set both.

### Required for `evaluate`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_CLIENT_TOKEN` | always | Datadog → Organization Settings → Client Tokens |
| `EPPO_SDK_KEY` | migration was from Eppo | Eppo → SDK Keys (server SDK key, one per environment) |
| `LAUNCHDARKLY_API_KEY` | migration was from LaunchDarkly *(preferred)* | LaunchDarkly → Account settings → Authorization → Access tokens |

### Datadog Application Key permissions

Your Datadog Application Key must have the following scopes enabled:

| Scope | Description |
|---|---|
| `feature_flag_config_read` | View Feature Flag Configurations |
| `feature_flag_config_write` | Edit Feature Flag Configurations |
| `feature_flag_environment_config_read` | Ability to view Feature Flag Environment settings |
| `feature_flag_environment_config_write` | Ability to modify Feature Flag Environment settings |
| `restriction_policies_read` | Read restriction policies *(required for team-based access controls)* |
| `restriction_policies_write` | Write restriction policies *(required for team-based access controls)* |
| `teams_read` | View Teams *(required for team-based access controls)* |

To set these permissions, go to **Organization Settings → Application Keys**, select your key, and enable the scopes listed above. The feature flag scopes are under the **Feature Flags** section; `restriction_policies_read` and `restriction_policies_write` are under **Access Management**; `teams_read` is under **Teams**.

### Examples

**Migrate from Eppo**

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export EPPO_API_KEY=...

npx @datadog/dd-flag-migration migrate
```

**Evaluate an Eppo migration**

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export DD_CLIENT_TOKEN=...
export EPPO_SDK_KEY=...

npx @datadog/dd-flag-migration evaluate
```

**Migrate from LaunchDarkly**

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export LAUNCHDARKLY_API_KEY=...

npx @datadog/dd-flag-migration migrate
```

**Evaluate a LaunchDarkly migration**

If `LAUNCHDARKLY_API_KEY` is already set (from running `migrate`), the SDK key is fetched automatically:

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export DD_CLIENT_TOKEN=...
export LAUNCHDARKLY_API_KEY=...   # SDK key fetched automatically

npx @datadog/dd-flag-migration evaluate
```

Or set the SDK key directly if you don't have the API key available:

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export DD_CLIENT_TOKEN=...
export LAUNCHDARKLY_SDK_KEY=...   # server-side key, scoped to one environment

npx @datadog/dd-flag-migration evaluate
```

---

## Step 1 — Migrate flags

```bash
npx @datadog/dd-flag-migration migrate
```

The tool will walk you through:

1. **Select your provider** — Eppo or LaunchDarkly
2. **Map environments** — link each source environment (e.g. `production`) to the corresponding Datadog environment
3. **Select flags** — choose which flags to migrate; flags already in Datadog are marked. Press **Tab** to toggle visibility of already-migrated flags, then **Ctrl+A** to select all remaining flags
4. **Confirm and migrate** — flags are created in Datadog and enabled in the mapped environments. A progress bar tracks migration status in real time

API keys are read from environment variables (see [Credentials](#credentials-youll-need)).
Pass `--datadog-site=<site>` to set the Datadog site without a prompt. For fully scripted runs, see [Non-interactive mode](#non-interactive-mode) below.

When the migration completes, a record is saved to `~/.dd-flag-migration/migration-<timestamp>.json`. In interactive mode you'll be prompted to export results to an `.xlsx` file; in non-interactive mode pass `--export=true` to generate one.

### Large migrations

For large flag sets, the tool supports splitting work across multiple runs:

- **Progress bar** — a sticky progress bar shows how many flags have been migrated so far, updating in real time
- **Tab to filter** — during flag selection, press **Tab** to hide flags that have already been migrated. Combined with **Ctrl+A**, this makes it easy to select only the remaining flags for the next run
- **Ctrl+C to save progress** — pressing **Ctrl+C** during migration saves a partial migration file (`~/.dd-flag-migration/migration-<timestamp>.json`) with all flags that completed successfully before the interruption. You can resume later by filtering out already-migrated flags with **Tab**

### LaunchDarkly-specific workflow

When migrating from LaunchDarkly, the tool adds these steps:

1. **Select a LaunchDarkly project** — flags in LaunchDarkly are scoped to a project, so you pick one project at a time
2. **Select LaunchDarkly environments** — choose which environments within that project to migrate
3. **Link environments** — map each selected LaunchDarkly environment to a Datadog environment
4. **Select flags** — flags already in Datadog are shown with a checkmark and will have their targeting synced for new environments rather than being re-created

The tool translates LaunchDarkly targeting rules, individual user targets, percentage rollouts, and fallthrough variations into equivalent Datadog targeting filters. Flags that use unsupported operators (`segmentMatch`, `before`, `after`) are automatically skipped with an explanation. Flags with prerequisites are migrated with a warning, since Datadog does not enforce prerequisites.

### Non-interactive mode

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments.

Non-interactive migrations write a JSON result document to stdout. Status messages, progress output, and export messages are written to stderr so stdout can be piped into tools such as `jq`.

**Required flags**

| Flag | Description |
|---|---|
| `--provider <Eppo\|LaunchDarkly>` | Source provider (case-insensitive) |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`) |
| `--env-map <source,target>` | Map a source environment to a Datadog environment. Repeat for each environment |
| `--feature-flag <key>` | Flag key to migrate. Repeat for each flag. For LaunchDarkly, use `<source-key>,<datadog-key>` to rename the Datadog flag |
| `--project <key>` | LaunchDarkly project key *(LaunchDarkly only)* |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without writing to Datadog |
| `--export=<bool>` | Export results to an `.xlsx` file after migration (default: `false`) |

**Examples**

Migrate two LaunchDarkly flags across two environments:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider LaunchDarkly \
  --project my-ld-project \
  --datadog-site datadoghq.com \
  --env-map Production,Production \
  --env-map Staging,QA \
  --feature-flag flag-one \
  --feature-flag flag-two
```

Rename a LaunchDarkly flag while migrating it:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider LaunchDarkly \
  --project my-ld-project \
  --datadog-site datadoghq.com \
  --env-map Production,Production \
  --feature-flag my-flag-1,my-renamed-flag-1
```

Migrate Eppo flags (no project key required):

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --env-map production,Production \
  --feature-flag my-flag
```

### Dry run

To preview what would be created without making any changes:

```bash
npx @datadog/dd-flag-migration migrate --dry-run
```

This writes the full list of API requests that would be sent to a `dry-run-<timestamp>.json` file in the current directory.

---

## Step 2 — Evaluate the migration

Once flags have been migrated, run the evaluation to compare how flags are evaluated in Eppo vs. Datadog for the same inputs:

```bash
npx @datadog/dd-flag-migration evaluate
```

The tool will:

1. **Select a migration file** — pick from previous migrations (most recent first)
2. **Select a Datadog environment** — choose which environment to evaluate against
3. **Enter a test subject ID** — a user ID (or any string) to use for flag evaluation
4. **Run evaluations** — the tool generates test cases from each flag's targeting rules and compares the provider and Datadog results side by side

Datadog and provider credentials are read from environment variables (see [Credentials](#credentials-youll-need)).

Results are displayed in a table showing the Eppo value, Datadog value, migration status, and whether the flag is enabled. Matching values are shown in green; differences in yellow.

You can optionally export the full results to an `.xlsx` file.

### Flags

| Flag | Description |
|---|---|
| `--use-latest-migration` | Skip the migration file selector and use the most recent |
| `--test-subject-id=<id>` | Set the subject ID non-interactively |
| `--flag-environment=<name>` | Set the Datadog environment name non-interactively |
| `--datadog-site=<site>` | Set the Datadog site non-interactively |

Example for scripted use:

```bash
npx @datadog/dd-flag-migration evaluate \
  --use-latest-migration \
  --test-subject-id=user-123 \
  --flag-environment=production \
  --datadog-site=datadoghq.com
```

---

## Configuration

The only setting persisted to `~/.dd-flag-migration/config.json` is your Datadog site (so you don't have to re-enter it on every run). Credentials are **never** read from or written to this file — set them as environment variables instead.

### Non-US Datadog sites

If your Datadog organization is on a regional site (EU, US3, US5, etc.), pass the site for a single run:

```bash
npx @datadog/dd-flag-migration evaluate --datadog-site=datadoghq.eu
```

To save a default site for interactive runs, add the site to your config:

```json
{
  "datadogSite": "datadoghq.eu"
}
```

| Site | `datadogSite` value |
|---|---|
| US1 (default) | `datadoghq.com` |
| EU | `datadoghq.eu` |
| US3 | `us3.datadoghq.com` |
| US5 | `us5.datadoghq.com` |
| AP1 | `ap1.datadoghq.com` |

---

## How it works

### Migration

#### Eppo

For each selected flag, the tool:

- Reads the flag's variations, targeting filters, and targeting rules from Eppo
- Creates an equivalent flag in Datadog via the Feature Flags API
- Enables the flag in the Datadog environments that correspond to active Eppo environments

Flags of type `BANDIT` or `LAYER` are skipped (not yet supported).

#### LaunchDarkly

For each selected flag, the tool:

- Reads the flag's variations, targeting rules, individual targets, and rollout configuration from LaunchDarkly
- Maps the flag type (`boolean` or `multivariate`) to the corresponding Datadog value type (`BOOLEAN`, `STRING`, `NUMERIC`, or `JSON`)
- Converts individual user targets into targeting filters with `ONE_OF` conditions on the `key` attribute
- Translates each targeting rule's clauses into Datadog targeting rule conditions, mapping operators like `in`, `contains`, `startsWith`, `endsWith`, `matches`, and semver comparisons to their Datadog equivalents
- Converts percentage rollouts from LaunchDarkly's 100,000-weight scale to Datadog's 0-100 scale
- Creates a fallthrough (default) targeting filter for the environment
- For flags that already exist in Datadog, syncs targeting for newly mapped environments instead of re-creating the flag
- Enables the flag in Datadog environments where it was enabled (`on: true`) in LaunchDarkly

Archived flags and flags using unsupported operators (`segmentMatch`, `before`, `after`) are skipped automatically.

### Evaluation

The evaluation tool generates test cases automatically from each flag's targeting rules — producing inputs that should match each rule and inputs that should not. It then calls the source provider's SDK and the Datadog feature flag CDN with the same subject ID and attributes, and compares the results.

This lets you verify that flag targeting logic was translated correctly before you cut over your application.

#### LaunchDarkly — mobile context kinds

Flags that target `ld_application` or `ld_device` context kinds (auto-populated by LaunchDarkly's mobile client SDKs) cannot be evaluated via the Node.js server-side SDK used by this tool. Test cases for those rules are shown as **not evaluated** (dimmed) with an explanatory note. The migration itself is correct — the targeting rules are translated into Datadog using the same prefixed attribute format (e.g. `ld_application.versionName`).
