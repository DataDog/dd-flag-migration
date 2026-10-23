# Datadog Feature Flag Migration Tool

A CLI tool for migrating feature flags from your current provider into [Datadog Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/), with side-by-side evaluation to verify the migration before you switch over.

**Supported providers:** Eppo, LaunchDarkly, and another Datadog org

---

## Guides

This README covers installation and the primary commands — `migrate`, `migration-status`, and `evaluate` — with options that apply to every migration. Each migration guide covers the credentials, workflow, supported features, and implementation details for one migration path:

| Guide | Description |
|---|---|
| [Eppo → Datadog](README-Eppo.md) | Migrate flags from Eppo |
| [LaunchDarkly → Datadog](README-LaunchDarkly.md) | Migrate flags from LaunchDarkly |
| [Datadog → Datadog](README-Datadog.md) | Copy flags between Datadog orgs, and compare two orgs with `org-diff` |
| [Post-migration actions](README-Post-Migration.md) | Bulk management of migrated flags: team permissions, environment enablement, and tag sync |

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

### Post-migration actions

After migrating, you can manage team permissions (`bulk-permissions`), enable flags across environments (`bulk-enable`), and sync tags from your source provider (`sync-tags`). See [README-Post-Migration.md](README-Post-Migration.md).

### Contributing / running from source

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Step 1 — Migrate flags

```bash
npx @datadog/dd-flag-migration migrate
```

The tool will walk you through:

1. **Select your migration** — Eppo → Datadog, Datadog → Datadog, or LaunchDarkly → Datadog
2. **Map environments** — link each source environment (e.g. `production`) to one or more corresponding Datadog environments
3. **Select flags** — choose which flags to migrate; flags already in Datadog are marked. Press **Tab** to open the advanced-filter screen and narrow the list by category, then **Ctrl+A** to select all remaining flags
4. **Confirm and migrate** — flags are created in Datadog and enabled in the mapped environments. A progress bar tracks migration status in real time

Each migration guide describes the additional steps for its source:

- [Eppo → Datadog workflow](README-Eppo.md#migrate-flags)
- [LaunchDarkly → Datadog workflow](README-LaunchDarkly.md#migrate-flags)
- [Datadog → Datadog workflow](README-Datadog.md#migrate-flags)

API keys are read from environment variables (see the credentials section of your [migration guide](#guides)).
Set `DD_SITE` to pre-fill the Datadog site prompt, or pass `--datadog-site=<site>` to provide an explicit site without a prompt. Datadog → Datadog migrations don't prompt for a site; they read `SOURCE_DD_SITE` and `TARGET_DD_SITE`. For fully scripted runs, see [Non-interactive mode](#non-interactive-mode) below.

When the migration completes, a record is saved to `~/.dd-flag-migration/migration-<timestamp>.json`. In interactive mode you'll be prompted to export results to an `.xlsx` file; in non-interactive mode pass `--export=true` to generate one.

### Large migrations

For large flag sets, the tool supports splitting work across multiple runs:

- **Progress bar** — a sticky progress bar shows how many flags have been migrated so far, updating in real time
- **Tab to filter** — during flag selection, press **Tab** to open the advanced-filter screen and narrow the list by category, such as `not-yet-migrated`. Combined with **Ctrl+A**, this makes it easy to select only the remaining flags for the next run
- **Ctrl+C to save progress** — pressing **Ctrl+C** during migration saves a partial migration file (`~/.dd-flag-migration/migration-<timestamp>.json`) with all flags that completed successfully before the interruption. You can resume later by filtering to `not-yet-migrated` with **Tab** on the flag selection screen.

### Re-syncing existing flags

Selecting a flag that already exists in Datadog syncs it from the source instead of creating it again. The source stays the source of truth, so you can keep editing flags there and re-run `migrate` until you switch over.

**Re-syncing can overwrite changes made directly in Datadog.** To preserve those
changes, exclude the flag from your selection. Use `--dry-run` to preview updates.

What is synced, and how existing flags are matched, depends on your migration. See your [migration guide](#guides).

### Non-interactive mode

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

## Migration Status

Generate a read-only migration status report with:

```bash
npx @datadog/dd-flag-migration migration-status

# When running from this repository:
yarn migration-status
```

First choose the migration to check: **LaunchDarkly → Datadog** or **Datadog → Datadog**. **Eppo → Datadog** is listed as coming soon and can't be selected yet.

- [LaunchDarkly → Datadog migration status](README-LaunchDarkly.md#migration-status)
- [Datadog → Datadog migration status](README-Datadog.md#migration-status)

---

## Step 2 — Evaluate the migration

Once flags have been migrated, run the evaluation to compare how flags are evaluated in your source provider vs. Datadog for the same inputs:

```bash
npx @datadog/dd-flag-migration evaluate
```

The tool will:

1. **Select a migration file** — pick from previous migrations (most recent first)
2. **Select a Datadog environment** — choose which environment to evaluate against
3. **Enter a test subject ID** — a user ID (or any string) to use for flag evaluation
4. **Run evaluations** — the tool generates test cases from each flag's targeting rules and compares the provider and Datadog results side by side

Datadog and provider credentials are read from environment variables. See the credentials section of the [Eppo](README-Eppo.md#credentials-youll-need) or [LaunchDarkly](README-LaunchDarkly.md#credentials-youll-need) guide.

Results are displayed in a table showing the provider value, Datadog value, migration status, and whether the flag is enabled. Matching values are shown in green; differences in yellow.

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

Provider-specific evaluation details:

- [Evaluate an Eppo migration](README-Eppo.md#evaluate-the-migration), including single-flag evaluation
- [Evaluate a LaunchDarkly migration](README-LaunchDarkly.md#evaluate-the-migration)

### How evaluation works

The evaluation tool generates test cases automatically from each flag's targeting rules — producing inputs that should match each rule and inputs that should not. It then calls the source provider's SDK and the Datadog feature flag CDN with the same subject ID and attributes, and compares the results.

This lets you verify that flag targeting logic was translated correctly before you cut over your application.

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
