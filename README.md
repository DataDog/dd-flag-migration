# Datadog Feature Flag Migration Tool

A CLI tool for migrating feature flags from your current provider into [Datadog Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/), with side-by-side evaluation to verify the migration before you switch over.

**Supported providers:** Eppo, LaunchDarkly

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Yarn](https://yarnpkg.com/) (`npm install -g yarn`)

---

## Installation

```bash
git clone https://github.com/DataDog/dd-flag-migration.git
cd dd-flag-migration
yarn setup
```

> **Note:** Use `yarn setup` instead of `yarn install`. This project uses [`@lavamoat/allow-scripts`](https://www.npmjs.com/package/@lavamoat/allow-scripts) to protect against supply-chain attacks by blocking all dependency lifecycle scripts by default. `yarn setup` runs `yarn install` and then selectively executes only the explicitly allowed postinstall scripts.

### Adding new packages

When you add a new dependency that has lifecycle scripts (`preinstall`, `install`, or `postinstall`), you'll see this error the next time you run `yarn allow-scripts`:

```
@lavamoat/allow-scripts has detected dependencies without configuration. explicit configuration required.
run "allow-scripts auto" to automatically populate the configuration.
```

To fix this:

1. Inspect the new dependency's install scripts to verify they are safe.
2. Run `yarn allow-scripts auto` to add the new dependency to the allowlist in `package.json`.
3. Run `yarn setup` to re-install with the newly allowed scripts executing.

---

## Credentials you'll need

### For migration (`yarn migrate`)

#### Eppo

| Credential | Where to find it |
|---|---|
| **Eppo Admin API key** | Eppo → Configuration → API Keys |
| **Datadog API key** | Datadog → Organization Settings → API Keys |
| **Datadog Application key** | Datadog → Organization Settings → Application Keys |

#### LaunchDarkly

| Credential | Where to find it |
|---|---|
| **LaunchDarkly API access token** | LaunchDarkly → Account settings → Authorization → Access tokens |
| **Datadog API key** | Datadog → Organization Settings → API Keys |
| **Datadog Application key** | Datadog → Organization Settings → Application Keys |

Your LaunchDarkly access token needs **Reader** role permissions (or a custom role with `viewProject` access) to read projects, environments, and flag configurations.

#### Datadog Application Key permissions

Your Datadog Application Key must have the following scopes enabled:

| Scope | Description |
|---|---|
| `feature_flag_config_read` | View Feature Flag Configurations |
| `feature_flag_config_write` | Edit Feature Flag Configurations |
| `feature_flag_environment_config_read` | Ability to view Feature Flag Environment settings |
| `feature_flag_environment_config_write` | Ability to modify Feature Flag Environment settings |
| `teams_read` | View Teams *(optional — enables automatic team tagging of migrated flags)* |

To set these permissions, go to **Organization Settings → Application Keys**, select your key, and enable the scopes listed above. The first four are under the **Feature Flags** section; `teams_read` is under **Teams**. If `teams_read` is not granted, migration will still succeed but team key mismatches cannot be detected.

### For evaluation (`yarn evaluate`)

Everything above, plus:

| Credential | Where to find it |
|---|---|
| **Eppo SDK key** | Eppo → SDK Keys (server SDK key, one per environment) |
| **Datadog Client token** | Datadog → Organization Settings → Client Tokens |

All credentials are prompted interactively and saved to `~/.dd-flag-migration/config.json` so you only need to enter them once.

---

## Step 1 — Migrate flags

```bash
yarn migrate
```

The tool will walk you through:

1. **Select your provider** — Eppo or LaunchDarkly
2. **Enter your provider API key** — used to fetch your flags
3. **Enter your Datadog API and Application keys** — used to create flags in Datadog
4. **Map environments** — link each source environment (e.g. `production`) to the corresponding Datadog environment
5. **Select flags** — choose which flags to migrate; flags already in Datadog are marked and skipped automatically
6. **Confirm and migrate** — flags are created in Datadog and enabled in the mapped environments

When the migration completes, a record is saved to `~/.dd-flag-migration/migration-<timestamp>.json`. You can optionally export results to an `.xlsx` file.

### LaunchDarkly-specific workflow

When migrating from LaunchDarkly, the tool adds these steps:

1. **Select a LaunchDarkly project** — flags in LaunchDarkly are scoped to a project, so you pick one project at a time
2. **Select LaunchDarkly environments** — choose which environments within that project to migrate
3. **Link environments** — map each selected LaunchDarkly environment to a Datadog environment
4. **Select flags** — flags already in Datadog are shown with a checkmark and will have their targeting synced for new environments rather than being re-created

The tool translates LaunchDarkly targeting rules, individual user targets, percentage rollouts, and fallthrough variations into equivalent Datadog targeting filters. Flags that use unsupported operators (`segmentMatch`, `before`, `after`) are automatically skipped with an explanation. Flags with prerequisites are migrated with a warning, since Datadog does not enforce prerequisites.

#### SDK key considerations

LaunchDarkly SDK keys are **project-scoped** — each project has its own set of SDK keys per environment. If you are migrating multiple LaunchDarkly projects that share the same flag keys, the flags will collide within a single Datadog organization.

For larger migrations with multiple projects, a good practice is to create **Datadog sub-organizations** so that each project's flags live in an independent org. Sub-organizations have their own API keys, environments, and flag namespaces, which avoids key conflicts entirely.

To create and manage sub-organizations, see [Multi-Organization Accounts](https://docs.datadoghq.com/account_management/multi_organization/). When using sub-organizations, generate separate Datadog API and Application keys for each sub-org and run the migration tool once per org.

### Dry run

To preview what would be created without making any changes:

```bash
yarn migrate --dry-run
```

This writes the full list of API requests that would be sent to a `dry-run-<timestamp>.json` file in the current directory.

---

## Step 2 — Evaluate the migration

Once flags have been migrated, run the evaluation to compare how flags are evaluated in Eppo vs. Datadog for the same inputs:

```bash
yarn evaluate
```

The tool will:

1. **Select a migration file** — pick from previous migrations (most recent first)
2. **Enter Datadog credentials** — API key, Application key, and Client token
3. **Select a Datadog environment** — choose which environment to evaluate against
4. **Enter your Eppo SDK key** — the server SDK key for the matching Eppo environment
5. **Enter a test subject ID** — a user ID (or any string) to use for flag evaluation
6. **Run evaluations** — the tool generates test cases from each flag's targeting rules and compares the Eppo and Datadog results side by side

Results are displayed in a table showing the Eppo value, Datadog value, migration status, and whether the flag is enabled. Matching values are shown in green; differences in yellow.

You can optionally export the full results to an `.xlsx` file.

### Flags

| Flag | Description |
|---|---|
| `--use-saved-keys` | Skip credential prompts and use saved keys |
| `--use-latest-migration` | Skip the migration file selector and use the most recent |
| `--test-subject-id=<id>` | Set the subject ID non-interactively |
| `--flag-environment=<name>` | Set the Datadog environment name non-interactively |

Example for scripted use:

```bash
yarn evaluate \
  --use-saved-keys \
  --use-latest-migration \
  --test-subject-id=user-123 \
  --flag-environment=production
```

---

## Configuration

Credentials and settings are stored in `~/.dd-flag-migration/config.json`. You can edit this file directly if needed.

### Non-US Datadog sites

If your Datadog organization is on a regional site (EU, US3, US5, etc.), add the site to your config before running either command:

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
