# Handling large migrations

This guide covers splitting a large flag set across multiple `migrate` runs and using `migration-status` to track progress between runs. For installation and the workflow shared by every migration, see the [main README](README.md).

---

## Contents

- [Migrate in batches](#migrate-in-batches)
  - [Track progress](#track-progress)
  - [Select the remaining flags](#select-the-remaining-flags)
  - [Stop and resume](#stop-and-resume)
- [Check migration status](#check-migration-status)
  - [Statuses](#statuses)
  - [Status report](#status-report)
  - [Credentials](#credentials)
- [Fix flags that need another run](#fix-flags-that-need-another-run)

---

## Migrate in batches

```bash
npx @datadog/dd-flag-migration migrate
```

You don't have to migrate every flag at once. Each run migrates only the flags you select, so you can work through a large flag set over several runs.

### Track progress

A sticky progress bar shows how many flags have been migrated so far, updating in real time.

### Select the remaining flags

During flag selection, press **Tab** to open the advanced-filter screen and narrow the list by category, such as `not-yet-migrated`. Then press **Ctrl+A** to select every visible flag. This makes it easy to select only the remaining flags for the next run.

The available categories depend on your migration:

- [Eppo → Datadog advanced filtering](README-Eppo.md#advanced-filtering)
- [LaunchDarkly → Datadog advanced filtering](README-LaunchDarkly.md#advanced-filtering)
- [Datadog → Datadog advanced filtering](README-Datadog.md#advanced-filtering)

For Datadog → Datadog migrations, you can also type a tag such as `team:checkout` to batch flags by tag. See [Filtering by tag](README-Datadog.md#filtering-by-tag).

### Stop and resume

Press **Ctrl+C** during migration to stop it. The tool saves a partial migration file (`~/.dd-flag-migration/migration-<timestamp>.json`) with all flags that completed successfully before the interruption.

To resume later, run `migrate` again and filter to `not-yet-migrated` with **Tab** on the flag selection screen.

A flag that was being migrated when you pressed **Ctrl+C** may already exist in Datadog without being fully migrated. Because it exists, it no longer matches `not-yet-migrated`. Run [`migration-status`](#check-migration-status) to find these flags.

---

## Check migration status

Generate a read-only migration status report with:

```bash
npx @datadog/dd-flag-migration migration-status

# When running from this repository:
yarn migration-status
```

The report shows which flags are migrated and whether each migrated flag still matches the source. Run it between batches to see what's left, and again before you switch over.

First choose the migration to check: **Eppo → Datadog**, **LaunchDarkly → Datadog**, or **Datadog → Datadog**.

The workflow depends on your migration:

- [Eppo → Datadog migration status](README-Eppo.md#migration-status): select environments, map each to one or more Datadog environments, and select flags. The flag picker supports the same migration-state filters as migration.
- [LaunchDarkly → Datadog migration status](README-LaunchDarkly.md#migration-status): select a project, environments, environment mappings, and flags, the same way you do for a migration. Press **Tab** in the flag picker to use the advanced filters, and **Ctrl+A** to check every visible flag.
- [Datadog → Datadog migration status](README-Datadog.md#migration-status): compares the source and target orgs and produces the same report as [Org diff](README-Datadog.md#org-diff).

### Statuses

For Eppo → Datadog and LaunchDarkly → Datadog, each selected flag is reported as one of:

| Status | Meaning |
|---|---|
| **Not yet migrated** | No linked Datadog flag was found |
| **Partially migrated** | A linked Datadog flag exists, but at least one mapped environment hasn't been migrated |
| **Out of sync** | The flag is migrated, but its configuration differs from the source |
| **In sync** | The flag is migrated and matches the source in every selected mapping |
| **Needs review** | The tool couldn't verify the flag, for example because flag details couldn't be loaded |

Environment sync is calculated only for the selected mappings. Unselected Datadog environments don't affect the result.

The report compares current configuration. It doesn't identify which platform changed after migration. Tags, permissions, restriction policies, and saved-filter contents aren't assessed.

For Datadog → Datadog statuses, see [Org diff](README-Datadog.md#org-diff).

### Status report

A workbook is written automatically to the current directory: `migration-status-eppo-<timestamp>.xlsx` for Eppo, or `migration-status-launchdarkly-<project>-<timestamp>.xlsx` for LaunchDarkly. It has a global summary and one status tab per selected Datadog environment. Each environment tab includes scoped status counts at the top.

### Credentials

`migration-status` uses the same credentials as a migration:

- [Eppo → Datadog migration status credentials](README-Eppo.md#migration-status-credentials)
- [LaunchDarkly → Datadog migration status credentials](README-LaunchDarkly.md#migration-status-credentials)
- [Datadog → Datadog migration status](README-Datadog.md#migration-status)

---

## Fix flags that need another run

After checking status, run `migrate` again for the flags that need it:

- **Not yet migrated**: filter to `not-yet-migrated` with **Tab** and press **Ctrl+A**.
- **Partially migrated** or **Out of sync**: select the flags again. Flags that already exist in Datadog are re-synced from the source instead of being created again. See [Re-syncing existing flags](README.md#re-syncing-existing-flags).
- **Needs review**: check the details in the report before running `migrate` again.

Re-syncing can overwrite changes made directly in Datadog. Use `--dry-run` to preview updates. See [Dry run](README.md#dry-run).
