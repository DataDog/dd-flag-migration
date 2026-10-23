# Datadog → Datadog migration

This guide covers copying feature flags from one Datadog org (the source) to another (the target), and comparing two orgs that should stay in sync. For installation, shared commands, and options that apply to every migration, see the [main README](README.md).

---

## Credentials you'll need

Credentials are read from environment variables. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running the tool. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1. Credentials are never read from or written to the tool's config file.

### Required for `migrate`, `migration-status`, and `org-diff`

| Variable | Where to find it |
|---|---|
| `SOURCE_DD_API_KEY`, `SOURCE_DD_APP_KEY`, `SOURCE_DD_SITE` | API key, application key, and site of the org you copy flags **from** (for `org-diff`, the first org) |
| `TARGET_DD_API_KEY`, `TARGET_DD_APP_KEY`, `TARGET_DD_SITE` | API key, application key, and site of the org you copy flags **to** (for `org-diff`, the second org) |

Datadog → Datadog migrations read all six `SOURCE_DD_*` and `TARGET_DD_*` variables and ignore `DD_API_KEY`, `DD_APP_KEY`, and `DD_SITE`. `DD_BASE_URL` and `DD_HTTP_HEADERS` can't be used with two orgs, because they would apply to both.

### Datadog Application Key permissions

Enable these scopes on the keys in `SOURCE_DD_APP_KEY` and `TARGET_DD_APP_KEY`:

| Scope | Required on | Required by | Description |
|---|---|---|---|
| `feature_flag_config_read` | both keys | `migrate`, `migration-status`, `org-diff` | View Feature Flag Configurations |
| `feature_flag_environment_config_read` | both keys | `migrate`, `migration-status`, `org-diff` | View Feature Flag Environment settings |
| `feature_flag_config_write` | target key | `migrate` | Edit Feature Flag Configurations |

To set these permissions, go to **Organization Settings → Application Keys** in each org, select your key, and enable the scopes under **Feature Flags**.

### Example

```bash
export SOURCE_DD_API_KEY=...
export SOURCE_DD_APP_KEY=...
export SOURCE_DD_SITE=datadoghq.com
export TARGET_DD_API_KEY=...
export TARGET_DD_APP_KEY=...
export TARGET_DD_SITE=datadoghq.eu

npx @datadog/dd-flag-migration migrate   # choose "Datadog → Datadog"
```

---

## Migrate flags

```bash
npx @datadog/dd-flag-migration migrate   # choose "Datadog → Datadog"
```

Datadog → Datadog migrations don't prompt for a site; they read `SOURCE_DD_SITE` and `TARGET_DD_SITE`. The [general migration workflow](README.md#step-1--migrate-flags) runs these steps:

1. **Select source org environments** — choose which environments in the source org to copy from
2. **Link environments** — map each source environment to one or more target org environments. Target environments with the same name are pre-selected
3. **Select flags** — flags whose key already exists in the target org are marked and are synced instead of created. Each flag's tags are shown next to its key, and you can [filter by tag](#filtering-by-tag)

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

Before copying flags, the tool copies the saved filters that the selected flags reference, following the same rules as LaunchDarkly segments. A saved filter that was copied before is updated in place, so edits in the source org carry over. A new saved filter is created with migration metadata that points back to its source filter.

If a target org filter without that metadata already has the same name, you can skip the conflicting filter, add a prefix to its name, or adopt the existing filter. Adopting replaces the existing filter's targeting with the source targeting and adds migration metadata, so later runs keep it in sync.

Before it adopts anything, the tool checks every target org flag for references to the filter. A filter is safe to adopt only when the usage check succeeds for every target flag and none uses it. Matching targeting avoids an immediate change, but later source edits could affect flags that still reference the adopted filter. References from selected flags still count because their targeting is rewritten later and that step may be skipped or fail. If a filter is in use or usage could not be fully checked, you choose whether to adopt it anyway, skip it, or prefix it.

Filters managed by another migration, or whose name matches more than one target filter, cannot be adopted. Non-interactive runs skip conflicts. Saved filters are never deleted from the target org.

### What is synced

Flags are matched by key. Variant keys are copied as-is. Name, description, JSON schema (including removal), distribution channel, and tags sync on every run; tags follow `--tag-mode` or the tag prompt. Targeting and default variants sync in each mapped environment where the source flag is enabled, and each mapped target environment is enabled or disabled to match its source environment. Restriction policies and team permissions aren't copied.

See [Re-syncing existing flags](README.md#re-syncing-existing-flags) for general behavior.

### Non-interactive mode

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. Credentials and sites come from the `SOURCE_DD_*` and `TARGET_DD_*` variables, so `--datadog-site` isn't supported and `--project` isn't used.

Non-interactive migrations use `--tag-mode merge` by default, preserving tags that exist only in the target org. Use `--tag-mode replace` to replace them with the source org's tags. In interactive mode, specifying `--tag-mode` skips the tag-mode prompt. Saved-filter name conflicts are skipped. Environments awaiting enable approval are reported separately and do not count as enabled.

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

**Datadog → Datadog** compares the `SOURCE_DD_*` and `TARGET_DD_*` orgs and produces the same report as [Org Diff](#org-diff).

---

## Org Diff

Compare feature flag configuration between two Datadog orgs that should stay in sync with:

```bash
npx @datadog/dd-flag-migration org-diff

# When running from this repository:
yarn org-diff
```

Credentials come from `SOURCE_DD_*` and `TARGET_DD_*` (see [Credentials you'll need](#credentials-youll-need)). The comparison is read-only and symmetric: neither org is treated as the source of truth. The source/target names only identify the two credential sets.

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
