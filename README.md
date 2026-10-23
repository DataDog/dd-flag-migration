# Datadog Feature Flag Migration Tool

A CLI tool for migrating feature flags from your current provider into [Datadog Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/), with side-by-side evaluation to verify the migration before you switch over.

**Supported providers:** Eppo, LaunchDarkly, and another Datadog org

---

## Migration guides

This README covers installation, shared commands, and options that apply to every migration. Each guide covers the credentials, workflow, supported features, and implementation details for one migration path:

| Migration | Guide |
|---|---|
| Eppo → Datadog | [README-Eppo.md](README-Eppo.md) |
| LaunchDarkly → Datadog | [README-LaunchDarkly.md](README-LaunchDarkly.md) |
| Datadog → Datadog | [README-Datadog.md](README-Datadog.md) |

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

# compare flag configuration between two Datadog orgs
npx @datadog/dd-flag-migration org-diff

# evaluate migrated flags
npx @datadog/dd-flag-migration evaluate

# manage team permissions after migration
npx @datadog/dd-flag-migration bulk-permissions

# enable migrated flags in one or more environments
npx @datadog/dd-flag-migration bulk-enable

# sync tags from your source provider onto migrated flags
npx @datadog/dd-flag-migration sync-tags
```

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

API keys are read from environment variables (see the credentials section of your [migration guide](#migration-guides)).
Set `DD_SITE` to pre-fill the Datadog site prompt, or pass `--datadog-site=<site>` to provide an explicit site without a prompt. Datadog → Datadog migrations don't prompt for a site; they read `SOURCE_DD_SITE` and `TARGET_DD_SITE`. For fully scripted runs, see [Non-interactive mode](#non-interactive-mode) below.

When the migration completes, a record is saved to `~/.dd-flag-migration/migration-<timestamp>.json`. In interactive mode you'll be prompted to export results to an `.xlsx` file; in non-interactive mode pass `--export=true` to generate one.

### Large migrations

For large flag sets, the tool supports splitting work across multiple runs:

- **Progress bar** — a sticky progress bar shows how many flags have been migrated so far, updating in real time
- **Tab to filter** — during flag selection, press **Tab** to open the advanced-filter screen and narrow the list by category, such as `not-yet-migrated`. Combined with **Ctrl+A**, this makes it easy to select only the remaining flags for the next run
- **Ctrl+C to save progress** — pressing **Ctrl+C** during migration saves a partial migration file (`~/.dd-flag-migration/migration-<timestamp>.json`) with all flags that completed successfully before the interruption. You can resume later by filtering to `not-yet-migrated` with **Tab**

### Re-syncing existing flags

Selecting a flag that already exists in Datadog syncs it from the source instead of creating it again. The source stays the source of truth, so you can keep editing flags there and re-run `migrate` until you switch over.

**Re-syncing can overwrite changes made directly in Datadog.** To preserve those
changes, exclude the flag from your selection. Use `--dry-run` to preview updates.

What is synced, and how existing flags are matched, depends on your migration. See your [migration guide](#migration-guides).

### Non-interactive mode

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. Set `DD_SITE` in the job environment or pass `--datadog-site`; you do not need to provide both.

Non-interactive migrations use `--tag-mode merge` by default, preserving tags that exist only in Datadog. Use `--tag-mode replace` to replace existing tags with the source-derived tags, including LaunchDarkly's `project:<key>` tag. In interactive mode, specifying `--tag-mode` skips the tag-mode prompt.

JSON flag schemas follow the source on re-migration. LaunchDarkly and Eppo expose no flag schema, so re-migrating their JSON flags clears any schema in Datadog. Environments awaiting enable approval are reported separately and do not count as enabled.

Non-interactive migrations write a JSON result document to stdout. Status messages, progress output, and export messages are written to stderr so stdout can be piped into tools such as `jq`.

**Required flags**

| Flag | Description |
|---|---|
| `--provider <Eppo\|LaunchDarkly\|Datadog>` | Source provider (case-insensitive). `Datadog` copies flags between the `SOURCE_DD_*` and `TARGET_DD_*` orgs |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`); optional when `DD_SITE` is set. Not used for `Datadog` |
| `--env-map <source,target>` | Map a source environment to a Datadog environment. Repeat the option—including the same source—to map one source environment to multiple Datadog environments |
| `--feature-flag <key>` | Flag key to migrate. Repeat for each flag. For LaunchDarkly, use `<source-key>,<datadog-key>` to rename the Datadog flag |
| `--project <key>` | LaunchDarkly project key *(LaunchDarkly only)* |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without writing to Datadog |
| `--export=<bool>` | Export results to an `.xlsx` file in the current directory (default: `false`). LaunchDarkly dry-run reports label planned changes as “Would create” or “Would sync”. |
| `--distribution-channel <auto\|client\|server\|all>` | LaunchDarkly distribution-channel behavior (default: `auto`); applies to new and existing flags in non-interactive mode |
| `--tag-mode <merge\|replace>` | Tag sync behavior for both providers (non-interactive default: `merge`) |

Examples for each provider are in the migration guides:

- [Eppo → Datadog examples](README-Eppo.md#non-interactive-examples)
- [LaunchDarkly → Datadog examples](README-LaunchDarkly.md#non-interactive-examples)
- [Datadog → Datadog examples](README-Datadog.md#non-interactive-examples)

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

## Org Diff

`org-diff` compares feature flag configuration between two Datadog orgs that should stay in sync. See [Org Diff](README-Datadog.md#org-diff) in the Datadog → Datadog guide.

---

## Bulk Permission Management

After flags have been migrated, add or remove explicit Datadog team permissions with:

```bash
npx @datadog/dd-flag-migration bulk-permissions

# When running from this repository:
yarn bulk-permissions
```

This command needs `DD_API_KEY` and `DD_APP_KEY`. The application key needs the `feature_flag_config_read`, `teams_read`, `restriction_policies_read`, and `restriction_policies_write` scopes. The restriction-policy scopes are only used by this command.

The interactive flow lets you:

1. Choose **Add teams to flags** or **Remove teams from flags**.
2. Select migrated flags. Type to filter by flag key or tag (for example, `project:health-100`). Whitespace-separated searches use union semantics, so a flag remains visible when either its key or one of its tags matches.
3. Select one or more Datadog teams.
4. For additions, optionally choose an `editor` or `contributor` permission policy for each selected team. The default is `editor`.
5. Choose whether to sync matching `team:<handle>` tags.

Additions grant each selected team its chosen relation. Datadog feature flags support team principals as `editor` or `contributor`; the `viewer` relation remains organization-wide and does not support team principals. Removals delete the selected teams from every explicit relation while preserving unrelated principals and bindings. When team tag syncing is enabled, additions add matching team tags and removals remove them while preserving unrelated tags. Team tags are metadata for migration visibility and do not control permission access; explicit Datadog permissions remain the source of access control after migration. Repeating either operation is an idempotent no-op when the requested state already exists.

Every confirmed update writes a `bulk-permissions-export-<timestamp>.xlsx` report in the current directory. The report distinguishes changed permissions, idempotent no-ops, and failures for each selected flag/team pair. When team-tag syncing is enabled, a separate **Tag Sync** sheet records its per-flag results and errors without changing the permission outcomes.

---

## Bulk Environment Enablement

Enable migrated flags across one or more Datadog environments with:

```bash
npx @datadog/dd-flag-migration bulk-enable

# When running from this repository:
yarn bulk-enable
```

This command needs `DD_API_KEY` and `DD_APP_KEY`. The application key needs the `feature_flag_config_read`, `feature_flag_config_write`, and `feature_flag_environment_config_read` scopes. The optional `feature_flag_approvals_override` scope bypasses Feature Flag approval requirements; without it, approval-protected changes are submitted as approval requests and reported as such.

First select one or more Datadog environments, then select the migrated flags to enable. The flag picker supports filtering by flag key or tag; press **Tab** for advanced filters scoped to the selected environments. Select **needs-enabling** to hide flags that are already enabled in every selected environment. Flags whose status cannot be confirmed remain visible under **needs-enabling** so they are not silently omitted. Production environments are clearly marked and require an explicit confirmation.

Updates run one at a time and use the shared Datadog rate-limit and retry handling. A failure for one flag/environment pair does not stop the remaining updates. Every confirmed update writes a `bulk-enable-export-<timestamp>.xlsx` report in the current directory. The report distinguishes newly enabled pairs, already-enabled pairs, approval requests, failures, and successful writes whose prior status could not be read.

---

## Tag Sync

After flags have been migrated, sync tags from your source provider (Eppo or LaunchDarkly) onto the corresponding Datadog flags with:

```bash
npx @datadog/dd-flag-migration sync-tags

# When running from this repository:
yarn sync-tags
```

This command needs `DD_API_KEY`, `DD_APP_KEY`, and the source provider's API key. See the credentials section of the [Eppo](README-Eppo.md#credentials-youll-need) or [LaunchDarkly](README-LaunchDarkly.md#credentials-youll-need) guide.

The interactive flow mirrors the `migrate` command's provider and flag selection:

1. **Select a provider** — Eppo or LaunchDarkly.
2. For LaunchDarkly, **select a project** using the same project picker as `migrate`.
3. **Select flags** — the same searchable, filterable flag list used by `migrate`. Only flags that already exist in Datadog can have their tags synced; flags with no Datadog match are skipped.
4. **Choose a sync strategy** — *Additive Merge* or *Full Replace*.

### Sync strategies

- **Additive Merge** (default) — adds the source tags to each Datadog flag while preserving any tags that already exist in Datadog. Source tags are unioned with the existing Datadog tags; nothing is removed. This is the safe default and never deletes tags.
- **Full Replace** — replaces the Datadog flag's tags with exactly the source tags. Tags that exist only in Datadog are removed, so removals in the source platform propagate to Datadog. Use this when the source platform is the source of truth for tags.

The source tag set depends on the provider:

- [Eppo tag sync](README-Eppo.md#tag-sync)
- [LaunchDarkly tag sync](README-LaunchDarkly.md#tag-sync)

Every completed tag-sync run writes a `sync-tags-export-<timestamp>.xlsx` report in the current directory, including dry runs. The **Tag Sync** sheet records the source, existing, target, added, and removed tags for every Datadog operation; when source flags are skipped because no safe Datadog match exists, a **Skipped Flags** sheet records the reason.

### Non-interactive mode

Pass `--interactive=false` to run the tag sync entirely from CLI arguments. Non-interactive runs write a JSON result document to stdout, including the report's `exportPath`; status messages and spreadsheet confirmation go to stderr.

**Required flags**

| Flag | Description |
|---|---|
| `--provider <Eppo\|LaunchDarkly>` | Source provider (case-insensitive) |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`) |
| `--feature-flag <key>` | Flag key to sync tags for. Repeat for each flag |
| `--project <key>` | LaunchDarkly project key *(LaunchDarkly only)* |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview tag changes without writing to Datadog |
| `--tag-mode <additive\|replace>` | Tag sync strategy (default: `additive`). Also accepts `merge` and `full` as aliases |

Examples for each provider are in the [Eppo](README-Eppo.md#tag-sync) and [LaunchDarkly](README-LaunchDarkly.md#tag-sync) guides.

### Dry run

To preview tag changes without writing to Datadog:

```bash
npx @datadog/dd-flag-migration sync-tags --dry-run
```

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
