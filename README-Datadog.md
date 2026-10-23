# Datadog → Datadog migration

This guide covers copying feature flags from one Datadog org (the source) to another (the target), and comparing two orgs that should stay in sync. For installation, shared commands, and options that apply to every migration, see the [main README](README.md).

---

## Credentials you'll need

Credentials are read from environment variables. See [Credentials you'll need](README.md#credentials-youll-need) in the main README for general behavior.

### Required for `migrate`, `migration-status`, and `org-diff`

| Variable | Where to find it |
|---|---|
| `SOURCE_DD_API_KEY`, `SOURCE_DD_APP_KEY`, `SOURCE_DD_SITE` | API key, application key, and site of the org you copy flags **from** (for `org-diff`, the first org) |
| `TARGET_DD_API_KEY`, `TARGET_DD_APP_KEY`, `TARGET_DD_SITE` | API key, application key, and site of the org you copy flags **to** (for `org-diff`, the second org) |

Datadog → Datadog migrations read all six `SOURCE_DD_*` and `TARGET_DD_*` variables and ignore `DD_API_KEY`, `DD_APP_KEY`, and `DD_SITE`. `DD_BASE_URL` and `DD_HTTP_HEADERS` can't be used with two orgs, because they would apply to both.

### Datadog Application Key permissions

Both application keys need the read scopes listed in [Datadog Application Key permissions](README.md#datadog-application-key-permissions). A Datadog → Datadog migration also needs `feature_flag_config_write` on the target org's key.

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
3. **Select flags** — flags whose key already exists in the target org are marked and are synced instead of created. Each flag's tags are shown, and typing a tag (such as `team:checkout`) in the filter narrows the list, as in `bulk-enable`

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

### Non-interactive examples

See [Non-interactive mode](README.md#non-interactive-mode) for all options. `--datadog-site` and `--project` are not used for `Datadog`.

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
| Restriction policies and team permissions | Not copied between orgs. To grant team permissions in the target org, use [`bulk-permissions`](README.md#bulk-permission-management). |
