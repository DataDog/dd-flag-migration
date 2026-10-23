# Datadog → Datadog migration

This guide covers copying feature flags from one Datadog org (the source) to another (the target), and comparing two orgs that should stay in sync. For installation and the workflow shared by every migration, see the [main README](README.md). For bulk management of migrated flags, see [Post-migration actions](README-Post-Migration.md).

Credentials are read from environment variables, and each section below lists the ones it needs. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running the tool. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1. Credentials are never read from or written to the tool's config file.

---

## Contents

- [Migrate flags](#migrate-flags)
  - [Migration credentials](#migration-credentials)
  - [Filtering by tag](#filtering-by-tag)
  - [Advanced filtering](#advanced-filtering)
  - [Saved filters](#saved-filters)
  - [What is synced](#what-is-synced)
- [Non-interactive migrations](#non-interactive-migrations)
- [Migration status](#migration-status)
- [Org diff](#org-diff)
- [Unsupported features](#unsupported-features)
  - [Flags that are skipped](#flags-that-are-skipped)
  - [Not copied](#not-copied)

---

## Migrate flags

```bash
npx @datadog/dd-flag-migration migrate   # choose "Datadog → Datadog"
```

The [general migration workflow](README.md#step-1--migrate-flags) runs these steps:

1. **Select source org environments** — choose which environments in the source org to copy from
2. **Link environments** — map each source environment to one or more target org environments. Target environments with the same name are pre-selected
3. **Select flags** — flags whose key already exists in the target org are marked and are synced instead of created. Each flag's tags are shown next to its key, and you can [filter by tag](#filtering-by-tag)

### Migration credentials

| Variable | Where to find it |
|---|---|
| `SOURCE_DD_API_KEY`, `SOURCE_DD_APP_KEY`, `SOURCE_DD_SITE` | API key, application key, and site of the org you copy flags **from** |
| `TARGET_DD_API_KEY`, `TARGET_DD_APP_KEY`, `TARGET_DD_SITE` | API key, application key, and site of the org you copy flags **to** |

Datadog → Datadog migrations read all six `SOURCE_DD_*` and `TARGET_DD_*` variables and ignore `DD_API_KEY`, `DD_APP_KEY`, and `DD_SITE`, so they don't prompt for a site. `DD_BASE_URL` and `DD_HTTP_HEADERS` can't be used with two orgs, because they would apply to both.

Enable these scopes on the keys in `SOURCE_DD_APP_KEY` and `TARGET_DD_APP_KEY`:

| Scope | Required on | Description |
|---|---|---|
| `feature_flag_config_read` | both keys | View Feature Flag Configurations |
| `feature_flag_environment_config_read` | both keys | View Feature Flag Environment settings |
| `feature_flag_config_write` | target key | Edit Feature Flag Configurations |

To set these permissions, go to **Organization Settings → Application Keys** in each org, select your key, and enable the scopes under **Feature Flags**.

```bash
export SOURCE_DD_API_KEY=...
export SOURCE_DD_APP_KEY=...
export SOURCE_DD_SITE=datadoghq.com
export TARGET_DD_API_KEY=...
export TARGET_DD_APP_KEY=...
export TARGET_DD_SITE=datadoghq.eu

npx @datadog/dd-flag-migration migrate   # choose "Datadog → Datadog"
```

### Filtering by tag

The flag picker lists each source org flag's tags in brackets after its key, for example `[team:checkout, env:prod]`. Type in the filter to narrow the list: the text is matched against each flag's name, key, and source org tags, so typing a tag such as `team:checkout` shows only the flags with that tag.

- Matching is case-insensitive and matches part of a value, so `team:` shows every flag with a `team` tag.
- Separate several terms with spaces to show flags that match any of them. For example, `team:checkout team:payments` shows flags owned by either team.
- Press **Ctrl+A** to select every visible flag, such as all flags with a given tag.
- The tag filter can be combined with the [advanced filters](#advanced-filtering), for example to select only the `team:checkout` flags that are **not-yet-migrated**.

Tag filtering is only available in interactive mode. Non-interactive runs select flags with `--feature-flag`.

### Advanced filtering

During flag selection, press **Tab** to open a multi-select filter screen. Categories start unchecked, which means no category filter is applied and all flags remain visible. Check one or more categories to narrow the flag list, then press **Enter** to apply the filter selection and return to flag selection, or **Escape** to cancel filter changes. Checking every category is equivalent to applying no category filter. Any selected flags that no longer match the applied filters are automatically unselected on return.

The available categories are:

- **previously-migrated** — a flag with the same key already exists in the target org; its targeting rules may still differ
- **not-yet-migrated** — no flag with this key exists in the target org yet

### Saved filters

Before copying flags, the tool copies the saved filters they reference. A saved filter copied on an earlier run is updated in place, so edits in the source org carry over. A new saved filter is created with migration metadata that points back to its source filter. Saved filters are never deleted from the target org.

If the target org already has a saved filter with the same name that this tool didn't copy, you choose how to handle the conflicts:

- **Skip** the conflicting filters.
- **Add a prefix** to the copied filters' names, so they're created alongside the existing ones.
- **Adopt** the existing filters. Their targeting is replaced with the source targeting and migration metadata is added, so later runs keep them in sync.

Adopting a filter changes how every target org flag that uses it evaluates, now or after later edits in the source org. Before adopting, the tool checks every target org flag for references to the filter:

- A filter that no flag uses is safe to adopt.
- If a flag uses the filter, or the check couldn't finish for every flag, you choose whether to adopt it anyway, or skip or prefix it instead. Flags you selected for this migration count as users too, because their targeting is rewritten in a later step that may be skipped or fail.

Filters managed by another migration, or whose name matches more than one target filter, can't be adopted. Non-interactive runs skip all conflicts.

### What is synced

Flags are matched by key. Variant keys are copied as-is. Name, description, JSON schema (including removal), distribution channel, and tags sync on every run; tags follow `--tag-mode` or the tag prompt. Targeting and default variants sync in each mapped environment where the source flag is enabled, and each mapped target environment is enabled or disabled to match its source environment.

See [Re-syncing existing flags](README.md#re-syncing-existing-flags) for general behavior.

---

## Non-interactive migrations

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. It uses the same [credentials](#migration-credentials) as an interactive migration, including the sites in `SOURCE_DD_SITE` and `TARGET_DD_SITE`, so `--datadog-site` isn't supported and `--project` isn't used.

Non-interactive migrations use `--tag-mode merge` by default, preserving tags that exist only in the target org. Use `--tag-mode replace` to replace them with the source org's tags. Saved-filter name conflicts are skipped. Environments awaiting enable approval are reported separately and do not count as enabled.

Non-interactive migrations write a JSON result document to stdout. Status messages, progress output, and export messages are written to stderr so stdout can be piped into tools such as `jq`.

**Required flags**

| Flag | Description |
|---|---|
| `--provider Datadog` | Copies flags from the `SOURCE_DD_*` org to the `TARGET_DD_*` org (case-insensitive) |
| `--env-map <source,target>` | Map a source org environment to a target org environment. Repeat the option—including the same source—to map one source environment to multiple target environments |
| `--feature-flag <key>` | Flag key to migrate. Repeat for each flag |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without writing to Datadog |
| `--export=<bool>` | Export results to an `.xlsx` file in the current directory (default: `false`) |
| `--tag-mode <merge\|replace>` | Tag sync behavior (non-interactive default: `merge`) |

**Examples**

Copy flags from the `SOURCE_DD_*` org to the `TARGET_DD_*` org. Environment names in `--env-map` are `source-org-environment,target-org-environment`:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Datadog \
  --env-map Production,Production \
  --env-map Staging,Staging \
  --feature-flag flag-one
```

---

## Migration status

```bash
npx @datadog/dd-flag-migration migration-status   # choose "Datadog → Datadog"
```

**Datadog → Datadog** compares the `SOURCE_DD_*` and `TARGET_DD_*` orgs and produces the same report as [Org diff](#org-diff). It uses the same `SOURCE_DD_*` and `TARGET_DD_*` variables as a [migration](#migration-credentials); both application keys need the `feature_flag_config_read` and `feature_flag_environment_config_read` scopes.

---

## Org diff

Compare feature flag configuration between two Datadog orgs that should stay in sync with:

```bash
npx @datadog/dd-flag-migration org-diff

# When running from this repository:
yarn org-diff
```

Credentials come from the same `SOURCE_DD_*` and `TARGET_DD_*` variables as a [migration](#migration-credentials), with `SOURCE_*` for the first org and `TARGET_*` for the second. Both application keys need the `feature_flag_config_read` and `feature_flag_environment_config_read` scopes. The comparison is read-only and symmetric: neither org is treated as the source of truth. The source/target names only identify the two credential sets.

1. Select the source org environments to compare.
2. Link each one to one or more target org environments. Environments with the same name are pre-selected.
3. Select the flags to compare. The list includes flags from both orgs, labeled by which org has them. Type a tag (such as `team:checkout`) to filter by tag, press **Tab** to filter to flags in both orgs or in only one, and press **Ctrl+A** to check every visible flag.
4. Confirm the environment pairs.

The selected flags are paired by key across both orgs and reported as **Only in source org**, **Only in target org**, **Differs**, **In sync**, or **Needs review**. Each pair compares the flag's name, description, value type, distribution channel, tags, and variants. For each environment pair, it also compares enablement, the default variant, any environment override, and targeting. Targeting is compared by behavior: filter order, rules, and rollout weights. Filter keys and names are ignored. Saved-filter references are matched across orgs by migration metadata or by a name that is unique in both orgs; their contents are not compared. Environments that are disabled in both orgs don't have their targeting compared. Progressive rollouts, scheduled rollouts, and experiments are reported as **Needs review**.

An `org-diff-<source-site>-<target-site>-<timestamp>.xlsx` workbook is written to the current directory, with a summary tab and one tab per environment pair. To fix differences, decide which org is correct and run `migrate` with **Datadog → Datadog**, using that org as the source.

---

## Unsupported features

### Flags that are skipped

| Feature | Reason |
|---|---|
| Progressive rollouts, scheduled rollouts, experiments, and environment overrides | That state can't be copied between orgs. Flags whose targeting uses any of them are skipped with an explanation. |

### Not copied

| Feature | How to handle it |
|---|---|
| Restriction policies and team permissions | Not copied between orgs. To grant team permissions in the target org, use [`bulk-permissions`](README-Post-Migration.md#bulk-permission-management). |
