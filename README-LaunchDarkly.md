# LaunchDarkly → Datadog migration

This guide covers migrating feature flags from LaunchDarkly to Datadog Feature Flags. For installation, shared commands, and options that apply to every migration, see the [main README](README.md).

---

## Credentials you'll need

Credentials are read from environment variables. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running the tool. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1. Credentials are never read from or written to the tool's config file.

`DD_SITE` is optional for interactive commands and pre-fills the Datadog site prompt when set. For non-interactive runs, use either `DD_SITE` or `--datadog-site`; the explicit CLI option takes precedence. See [Non-US Datadog sites](README.md#non-us-datadog-sites) for site values.

### Required for `migrate` and `migration-status`

| Variable | Where to find it |
|---|---|
| `DD_API_KEY` | Datadog → Organization Settings → API Keys |
| `DD_APP_KEY` | Datadog → Organization Settings → Application Keys |
| `LAUNCHDARKLY_API_KEY` | LaunchDarkly → Account settings → Authorization → Access tokens |

Your LaunchDarkly access token needs **Reader** role permissions (or a custom role with `viewProject` access) to read projects, environments, and flag configurations.

`LAUNCHDARKLY_*` variables are checked only when you select LaunchDarkly as the source provider.

### Required for `evaluate`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_CLIENT_TOKEN` | always | Datadog → Organization Settings → Client Tokens |
| `LAUNCHDARKLY_API_KEY` | *(preferred)* the SDK key is fetched automatically | LaunchDarkly → Account settings → Authorization → Access tokens |
| `LAUNCHDARKLY_SDK_KEY` | you don't have the API key available | LaunchDarkly server-side SDK key, scoped to one environment |

### Required for `sync-tags`

`sync-tags` needs `DD_API_KEY`, `DD_APP_KEY`, and `LAUNCHDARKLY_API_KEY`.

### Datadog Application Key permissions

Enable these scopes on the key in `DD_APP_KEY`:

| Scope | Required by | Description |
|---|---|---|
| `feature_flag_config_read` | `migrate`, `migration-status`, `sync-tags` | View Feature Flag Configurations |
| `feature_flag_config_write` | `migrate`, `sync-tags` | Edit Feature Flag Configurations |
| `feature_flag_environment_config_read` | `migrate`, `migration-status`, `sync-tags` | View Feature Flag Environment settings |
| `teams_read` | `migrate`, `sync-tags` | View Teams for team-based access controls |

To set these permissions, go to **Organization Settings → Application Keys**, select your key, and enable the scopes. The feature flag scopes are under **Feature Flags** and `teams_read` is under **Teams**. For the scopes used by `bulk-permissions` and `bulk-enable`, see [Bulk Permission Management](README-Post-Migration.md#bulk-permission-management) and [Bulk Environment Enablement](README-Post-Migration.md#bulk-environment-enablement).

### Examples

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

## Migrate flags

```bash
npx @datadog/dd-flag-migration migrate   # choose "LaunchDarkly → Datadog"
```

When migrating from LaunchDarkly, the [general migration workflow](README.md#step-1--migrate-flags) adds these steps:

1. **Select a LaunchDarkly project** — flags in LaunchDarkly are scoped to a project, so you pick one project at a time
2. **Select LaunchDarkly environments** — choose which environments within that project to migrate
3. **Link environments** — map each selected LaunchDarkly environment to one or more Datadog environments
4. **Select flags** — existing Datadog flags are marked with a checkmark. Selected flags are updated from LaunchDarkly, including their targeting in mapped environments where the source flag is enabled
5. **Choose a distribution channel** — automatically use Client for flags with semver targeting, or explicitly use Client, Server, or All for every selected flag

The tool translates LaunchDarkly targeting rules, individual user targets, percentage rollouts, and fallthrough variations into equivalent Datadog targeting filters. Before migrating flags, the tool runs a segment migration phase that converts referenced LaunchDarkly segments into Datadog saved filters and substitutes them into targeting rules. Flags that use unsupported operators (`before`, `after`) are automatically skipped with an explanation. Flags with prerequisites are migrated with a warning, since Datadog does not enforce prerequisites.

In **Auto** distribution-channel mode, flags with semantic-version targeting
are set to Client. Existing non-semver flags keep their current channel, and
new non-semver flags use Datadog's default. Explicit Client, Server, and All
modes set the corresponding channel on every selected flag.

### Advanced filtering

During flag selection, press **Tab** to open a multi-select filter screen. Categories start unchecked, which means no category filter is applied and all flags remain visible. Check one or more categories to narrow the flag list, then press **Enter** to apply the filter selection and return to flag selection, or **Escape** to cancel filter changes. Checking every category is equivalent to applying no category filter. Any selected flags that no longer match the applied filters are automatically unselected on return.

The available categories are:

- **new** — any environment — LaunchDarkly reports new for at least one non-archived environment
- **active** — any environment — LaunchDarkly reports active for at least one non-archived environment
- **inactive** — all environments — LaunchDarkly reports inactive for every non-archived environment whose status could be loaded
- **launched** — any environment — LaunchDarkly reports launched for at least one non-archived environment
- **previously-migrated** — flag — a matching flag already exists in Datadog; its targeting rules may still differ
- **not-yet-migrated** — flag — no matching flag exists in Datadog yet

The four lifecycle categories (**new**, **active**, **inactive**, and **launched**) are derived from [LaunchDarkly flag statuses](https://launchdarkly.com/docs/api/feature-flags/get-feature-flag-status-across-environments), which are tracked per environment. Environment selection still controls what gets migrated; lifecycle filters look across all non-archived LaunchDarkly environments in the project so they can answer whether a flag appears to be used anywhere. If a status fetch fails, the tool does not treat that missing data as inactive.

### Re-syncing existing flags

In both interactive and non-interactive modes, the tool syncs selected
LaunchDarkly flags with existing Datadog flags, including those created manually.
If a Datadog flag is linked to a different source flag or project, the tool
reports a conflict instead of overwriting it.

Interactive mode uses migration metadata to identify previously migrated flags.
Non-interactive mode uses the specified Datadog key; pass
`--feature-flag source-key,datadog-key` when the source and target keys differ.

See [Re-syncing existing flags](README.md#re-syncing-existing-flags) for general behavior.

The tool preserves numbered suffixes added to resolve duplicate display names,
such as `Flag (1)`, while applying source name changes. If an updated name is
already taken, the tool tries another numbered suffix without changing the
flag's key or ID. Dry runs cannot check whether a new name is already taken.

### Non-interactive mode

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. Set `DD_SITE` in the job environment or pass `--datadog-site`; you do not need to provide both.

Non-interactive migrations use `--tag-mode merge` by default, preserving tags that exist only in Datadog. Use `--tag-mode replace` to replace existing tags with the source-derived tags, including the `project:<key>` tag. In interactive mode, specifying `--tag-mode` skips the tag-mode prompt.

LaunchDarkly exposes no flag schema, so re-migrating a JSON flag clears any schema in Datadog. Environments awaiting enable approval are reported separately and do not count as enabled.

Non-interactive migrations write a JSON result document to stdout. Status messages, progress output, and export messages are written to stderr so stdout can be piped into tools such as `jq`.

**Required flags**

| Flag | Description |
|---|---|
| `--provider LaunchDarkly` | Source provider (case-insensitive) |
| `--project <key>` | LaunchDarkly project key |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`); optional when `DD_SITE` is set |
| `--env-map <source,target>` | Map a source environment to a Datadog environment. Repeat the option—including the same source—to map one source environment to multiple Datadog environments |
| `--feature-flag <key>` | Flag key to migrate. Repeat for each flag. Use `<source-key>,<datadog-key>` to rename the Datadog flag |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without writing to Datadog |
| `--export=<bool>` | Export results to an `.xlsx` file in the current directory (default: `false`). Dry-run reports label planned changes as “Would create” or “Would sync”. |
| `--distribution-channel <auto\|client\|server\|all>` | Distribution-channel behavior (default: `auto`); applies to new and existing flags |
| `--tag-mode <merge\|replace>` | Tag sync behavior (non-interactive default: `merge`) |

**Examples**

Map one LaunchDarkly environment to two Datadog environments:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider LaunchDarkly \
  --project my-ld-project \
  --datadog-site datadoghq.com \
  --env-map Production,Production \
  --env-map Production,QA \
  --feature-flag flag-one
```

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

---

## Migration status

```bash
npx @datadog/dd-flag-migration migration-status   # choose "LaunchDarkly → Datadog"
```

The interactive workflow uses the same environment selection and one-to-many mapping experience as migration:

1. Select a LaunchDarkly project.
2. Select the LaunchDarkly environments to analyze.
3. Map each selected LaunchDarkly environment to one or more Datadog environments.
4. Select the flags to check. This is the same flag picker as migration, including the **Tab** advanced filters (see [Advanced filtering](#advanced-filtering)); press **Ctrl+A** to check every visible flag.
5. Confirm the analysis scope.

The command reports the selected flags as **Not yet migrated**, **Partially migrated**, **Out of sync**, **In sync**, or **Needs review**. Environment sync is calculated only for the selected mappings; unselected Datadog environments do not affect the result. A `migration-status-launchdarkly-<project>-<timestamp>.xlsx` workbook is written automatically to the current directory with a global summary and one status tab per selected Datadog environment. Each environment tab includes scoped status counts at the top.

The report compares current configuration and does not identify which platform changed after migration. Tags, permissions, restriction policies, and saved-filter contents are not assessed.

---

## Tag sync

See [Tag Sync](README-Post-Migration.md#tag-sync) for the workflow and sync strategies.

For LaunchDarkly flags, the source tag set is the flag's own LD tags plus the `project:<key>` migration-link tag (so the Datadog→LaunchDarkly link is preserved on Full Replace). Team tags derived from the LaunchDarkly RBAC editor-team walk are not re-synced here — they belong to the restriction-policy flow.

### Non-interactive tag sync

Pass `--interactive=false` to run the tag sync entirely from CLI arguments. Non-interactive runs write a JSON result document to stdout, including the report's `exportPath`; status messages and spreadsheet confirmation go to stderr.

**Required flags**

| Flag | Description |
|---|---|
| `--provider LaunchDarkly` | Source provider (case-insensitive) |
| `--project <key>` | LaunchDarkly project key |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`) |
| `--feature-flag <key>` | Flag key to sync tags for. Repeat for each flag |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview tag changes without writing to Datadog |
| `--tag-mode <additive\|replace>` | Tag sync strategy (default: `additive`). Also accepts `merge` and `full` as aliases |

**Examples**

Sync tags for two LaunchDarkly flags using Full Replace:

```bash
npx @datadog/dd-flag-migration sync-tags --interactive=false \
  --provider LaunchDarkly \
  --project my-ld-project \
  --datadog-site datadoghq.com \
  --tag-mode replace \
  --feature-flag flag-one \
  --feature-flag flag-two
```

---

## Evaluate the migration

See [Step 2 — Evaluate the migration](README.md#step-2--evaluate-the-migration) for the general workflow and options. Results show the LaunchDarkly value next to the Datadog value.

### Mobile context kinds

Flags that target `ld_application` or `ld_device` context kinds (auto-populated by LaunchDarkly's mobile client SDKs) cannot be evaluated via the Node.js server-side SDK used by this tool. Test cases for those rules are shown as **not evaluated** (dimmed) with an explanatory note. The migration itself is correct — the targeting rules are translated into Datadog using the same prefixed attribute format (e.g. `ld_application.versionName`).

---

## Unsupported features

Some LaunchDarkly features have no direct equivalent in Datadog. The tool handles each case automatically — either by skipping the affected flag entirely or by applying the closest supported equivalent and recording the adjustment in the migration results.

### Flags that are skipped

| Feature | Reason |
|---|---|
| Date targeting (`before` / `after` operators) | Date-based targeting conditions have no equivalent in Datadog targeting filters. Flags that use these operators are skipped. |
| Archived flags | Archived flags are excluded from the migration entirely. |

### Flags that are migrated with adjustments

| Feature | How it's handled |
|---|---|
| Dependent flags (prerequisites) | Datadog does not enforce flag prerequisites. Flags that depend on another flag being in a specific state are migrated with a warning, since the prerequisite relationship is not preserved. |
| SEMVER targeting on server-side flags | SEMVER comparisons are a client-SDK feature in Datadog. In **Auto** distribution-channel mode, flags that use SEMVER targeting are migrated with the **CLIENT** channel and a warning is recorded. An explicit Client, Server, or All selection is honored instead. |
| JSON variants that are top-level arrays | Datadog requires JSON variant values to be objects. Array-valued variants are automatically wrapped: `[...]` becomes `{ "value": [...] }`. A warning is recorded in the migration results. |
| JSON flag schemas | LaunchDarkly exposes no flag schema, so re-migrating a JSON flag clears any schema in Datadog. |

### Features with limited evaluation support

| Feature | Behavior |
|---|---|
| Mobile context kinds (`ld_application`, `ld_device`) | These context kinds are auto-populated by LaunchDarkly's mobile client SDKs and cannot be evaluated by the server-side Node.js SDK used by this tool. Targeting rules that use them are shown as **not evaluated** during the evaluation step. The migration itself is correct — targeting rules are translated using the same prefixed attribute format (e.g. `ld_application.versionName`). |

---

## How it works

Before processing individual flags, the tool runs a **segment migration phase**:

- Scans all selected flags for `segmentMatch` clauses and collects the referenced segment keys per environment
- Fetches those segments from the LaunchDarkly API
- Checks existing Datadog saved filters for already-migrated segments (idempotency via `migration_metadata`)
- Creates a Datadog saved filter for each segment — using `LIST` type for pure key-inclusion segments and `RULES` type for all others
- Builds a negated variant for any segment referenced with `negate: true`, using De Morgan's law to derive the inverse rules
- Handles cross-project name conflicts interactively (skip or add a prefix)
- Returns a lookup map used by the flag targeting step to substitute saved filter references in place of `segmentMatch` clauses

For each selected flag, the tool:

- Reads the flag's variations, targeting rules, individual targets, and rollout configuration from LaunchDarkly
- Maps the flag type (`boolean` or `multivariate`) to the corresponding Datadog value type (`BOOLEAN`, `STRING`, `NUMERIC`, or `JSON`)
- Converts individual user targets into targeting filters with `ONE_OF` conditions on the `key` attribute
- Translates each targeting rule's clauses into Datadog targeting rule conditions, mapping operators like `in`, `contains`, `startsWith`, `endsWith`, `matches`, and semver comparisons to their Datadog equivalents; replaces `segmentMatch` clauses with the saved filter IDs created in the segment phase
- Converts percentage rollouts from LaunchDarkly's 100,000-weight scale to Datadog's 0-100 scale
- Maps a single-variation fallthrough to the environment's Datadog default
  variant; retains split or progressive fallthroughs as catch-all targeting
  filters
- Updates existing Datadog flags with the LaunchDarkly display name and replaces
  their targeting in mapped environments where the source flag is enabled
- Enables the flag in Datadog environments where it was enabled (`on: true`) in LaunchDarkly

Archived flags and flags using unsupported operators (`before`, `after`) are skipped automatically. Individual segment rules that use unsupported features (multi-context membership, nested `segmentMatch`, or negation explosions) are skipped with a warning; the flags that reference them are still migrated with their other targeting rules intact.
