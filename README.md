# Datadog Feature Flag Migration Tool

A CLI tool for migrating feature flags from your current provider into [Datadog Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/), with side-by-side evaluation to verify the migration before you switch over.

**Supported providers:** Eppo, LaunchDarkly, and another Datadog org

---

## Guides

| Guide | Description |
|---|---|
| [Eppo → Datadog](README-Eppo.md) | Migrate flags from Eppo |
| [LaunchDarkly → Datadog](README-LaunchDarkly.md) | Migrate flags from LaunchDarkly |
| [Datadog → Datadog](README-Datadog.md) | Copy flags between Datadog orgs, and compare two orgs with `org-diff` |
| [Handling large migrations](README-Large-Migrations.md) | Split a large flag set across multiple runs and track progress with `migration-status` |
| [Post-migration actions](README-Post-Migration.md) | Bulk management of migrated flags: team permissions, environment enablement, and tag sync |
| [Evaluate flags without APM or Infrastructure Monitoring](README-Without-APM.md) | Configure the Datadog Agent and your services to evaluate flags with APM tracing and Infrastructure Monitoring turned off |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

---

## Installation

Run without installing using `npx`:

```bash
# migrate flags
npx @datadog/dd-flag-migration migrate

# check migration coverage and sync status
npx @datadog/dd-flag-migration migration-status

# evaluate migrated flags
npx @datadog/dd-flag-migration evaluate
```

### Contributing / running from source

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Step 1 — Migrate flags

```bash
npx @datadog/dd-flag-migration migrate
```

The tool will walk you through:

1. **Select your migration** — Eppo → Datadog, LaunchDarkly → Datadog, or Datadog → Datadog
2. **Map environments** — link each source environment (e.g. `production`) to one or more corresponding Datadog environments
3. **Select flags** — choose which flags to migrate; flags already in Datadog are marked
4. **Confirm and migrate** — new flags are created in Datadog, existing flags are synced, and both are enabled in the mapped environments. A progress bar tracks migration status in real time

Each migration guide describes the additional steps for its source:

- [Eppo → Datadog workflow](README-Eppo.md#migrate-flags)
- [LaunchDarkly → Datadog workflow](README-LaunchDarkly.md#migrate-flags)
- [Datadog → Datadog workflow](README-Datadog.md#migrate-flags)

Credentials and the Datadog site are read from environment variables; see the credentials section of your [migration guide](#guides). For fully scripted runs, see [Non-interactive mode](#non-interactive-mode) below.

When the migration completes, a record is saved to `~/.dd-flag-migration/migration-<timestamp>.json`. In interactive mode you'll be prompted to export results to an `.xlsx` file unless `--export` explicitly enables or disables export. In non-interactive mode pass `--export` to generate one.

### Large migrations

For large flag sets, you can split work across multiple runs, stop a run with **Ctrl+C** and resume it later, and check progress with `migration-status`. See [Handling large migrations](README-Large-Migrations.md).

### Re-syncing existing flags

Selecting a flag that already exists in Datadog syncs it from the source instead of creating it again. The source stays the source of truth, so you can keep editing flags there and re-run `migrate` until you switch over.

**Re-syncing can overwrite changes made directly in Datadog.** To preserve those changes, exclude the flag from your selection. Use `--dry-run` to preview updates.

When a migration updates existing Datadog flags, interactive runs ask whether to merge the source tags into the existing Datadog tags or replace them. Pass `--tag-mode` to skip the prompt.

What is synced, and how existing flags are matched, depends on your migration. See your [migration guide](#guides).

### Scripted migrations

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. See the options and examples in your migration guide:

- [Eppo → Datadog](README-Eppo.md#non-interactive-migrations)
- [LaunchDarkly → Datadog](README-LaunchDarkly.md#non-interactive-migrations)
- [Datadog → Datadog](README-Datadog.md#non-interactive-migrations)

### Dry run

To preview what would be created without making any changes:

```bash
npx @datadog/dd-flag-migration migrate --dry-run
```

This writes the full list of API requests that would be sent to a `dry-run-<timestamp>.json` file in the current directory.

---

## Step 2 — Evaluate the migration

Once flags have been migrated, evaluate them in your source provider and in Datadog with the same inputs, and compare the results:

```bash
npx @datadog/dd-flag-migration evaluate
```

You can evaluate either of these:

- **A migration** — a quick check that a migration went as expected. Every flag from a previous migration is evaluated for one test subject, using test cases generated from each flag's targeting rules (or your own test cases from a CSV file). Use it after each migration run to catch targeting that didn't translate correctly.
- **A flag** — a thorough check of one flag's percentage splits and rollouts. The flag is evaluated for many random subjects (10,000 by default), and the tool reports how each platform distributes subjects across variants and lists every subject that gets a different value; it exits with status 1 if any do. Use it before switching over a flag that splits traffic, to confirm subjects keep the variant they had. Available for flags migrated from Eppo.

Datadog and provider credentials are read from environment variables. See the evaluation credentials in the [Eppo](README-Eppo.md#evaluation-credentials) or [LaunchDarkly](README-LaunchDarkly.md#evaluation-credentials) guide.

Matching values are shown in green and differences in yellow. You can export the full results to an `.xlsx` file.

### Flags

Use these flags to skip the matching prompts, for example in scripted runs.

| Flag | Applies to | Description |
|---|---|---|
| `--target=<migration\|flag>` | both | Choose what to evaluate. Inferred from the other flags when omitted |
| `--flag-environment=<name>` | both | Datadog environment to evaluate against |
| `--datadog-site=<site>` | both | Datadog site |
| `--use-latest-migration` | migration | Use the most recent migration file |
| `--test-subject-id=<id>` | migration | Subject ID to evaluate |
| `--provider=eppo` | flag | Source provider of the flag. Only `eppo` is supported |
| `--flag=<key>` | flag | Key of the flag to evaluate |
| `--subjects=<n>` | flag | Number of random subjects (default: 10,000) |
| `--export` | flag | Export every evaluation to an `.xlsx` file; omitted prompts on interactive terminals, explicit `false` skips without prompting |

Evaluate the latest migration:

```bash
npx @datadog/dd-flag-migration evaluate \
  --use-latest-migration \
  --test-subject-id=user-123 \
  --flag-environment=production \
  --datadog-site=datadoghq.com
```

Evaluate one flag migrated from Eppo:

```bash
npx @datadog/dd-flag-migration evaluate \
  --target=flag \
  --provider=eppo \
  --flag=my-flag \
  --flag-environment=production \
  --datadog-site=datadoghq.com
```

Provider-specific evaluation details:

- [Evaluate an Eppo migration](README-Eppo.md#evaluate-the-migration)
- [Evaluate a LaunchDarkly migration](README-LaunchDarkly.md#evaluate-the-migration)

### How evaluation works

Both options generate test cases from each flag's targeting rules — inputs that should match each rule and inputs that should not — and evaluate them in both platforms with the same subject and attributes. When evaluating a migration, you can provide your own test cases in a CSV file instead.

- **A migration** evaluates each test case for your test subject with the source provider's SDK and Datadog's precomputed assignments for that subject (using `DD_CLIENT_TOKEN`).
- **A flag** evaluates each test case for every random subject with the Eppo SDK and the flag's Datadog configuration, loaded from the server or client channel to match the flag's distribution channel. It compares the variant each subject gets, so it also checks how subjects are bucketed into splits and rollouts.

This lets you verify that flag targeting logic was translated correctly before you cut over your application.

---

## Migration status

Generate a read-only migration status report with:

```bash
npx @datadog/dd-flag-migration migration-status

# When running from this repository:
yarn migration-status
```

First choose the migration to check: **Eppo → Datadog**, **LaunchDarkly → Datadog**, or **Datadog → Datadog**.

- [Eppo → Datadog migration status](README-Eppo.md#migration-status)
- [LaunchDarkly → Datadog migration status](README-LaunchDarkly.md#migration-status)
- [Datadog → Datadog migration status](README-Datadog.md#migration-status)

To track progress across several migration runs, see [Handling large migrations](README-Large-Migrations.md#check-migration-status).

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

## Unsupported features

Some source features have no direct equivalent in Datadog. The tool handles each case automatically — either by skipping the affected flag, failing it with a reason, or applying the closest supported equivalent and recording the adjustment in the migration results. See the unsupported features section of each guide:

- [Eppo → Datadog unsupported features](README-Eppo.md#unsupported-features)
- [LaunchDarkly → Datadog unsupported features](README-LaunchDarkly.md#unsupported-features)
- [Datadog → Datadog unsupported features](README-Datadog.md#unsupported-features)
