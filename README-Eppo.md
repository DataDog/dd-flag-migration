# Eppo → Datadog migration

This guide covers migrating feature flags from Eppo to Datadog Feature Flags. For installation, shared commands, and options that apply to every migration, see the [main README](README.md).

---

## Credentials you'll need

Credentials are read from environment variables. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running the tool. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1. Credentials are never read from or written to the tool's config file.

`DD_SITE` is optional for interactive commands and pre-fills the Datadog site prompt when set. For non-interactive runs, use either `DD_SITE` or `--datadog-site`; the explicit CLI option takes precedence. See [Non-US Datadog sites](README.md#non-us-datadog-sites) for site values.

### Required for `migrate`

| Variable | Where to find it |
|---|---|
| `DD_API_KEY` | Datadog → Organization Settings → API Keys |
| `DD_APP_KEY` | Datadog → Organization Settings → Application Keys |
| `EPPO_API_KEY` | Eppo → Configuration → API Keys |

`EPPO_*` variables are checked only when you select Eppo as the source provider.

### Required for `evaluate`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_CLIENT_TOKEN` | evaluating a migration or a client-only flag | Datadog → Organization Settings → Client Tokens |
| `EPPO_SDK_KEY` | evaluating a migration | Eppo → SDK Keys (server SDK key, one per environment) |
| `EPPO_API_KEY` | evaluating a single flag | Eppo → Configuration → API Keys |

### Required for `sync-tags`

`sync-tags` needs `DD_API_KEY`, `DD_APP_KEY`, and `EPPO_API_KEY`.

### Datadog Application Key permissions

Enable these scopes on the key in `DD_APP_KEY`:

| Scope | Required by | Description |
|---|---|---|
| `feature_flag_config_read` | `migrate`, `sync-tags` | View Feature Flag Configurations |
| `feature_flag_config_write` | `migrate`, `sync-tags` | Edit Feature Flag Configurations |
| `feature_flag_environment_config_read` | `migrate`, `sync-tags` | View Feature Flag Environment settings |
| `teams_read` | `migrate`, `sync-tags` | View Teams for team-based access controls |

To set these permissions, go to **Organization Settings → Application Keys**, select your key, and enable the scopes. The feature flag scopes are under **Feature Flags** and `teams_read` is under **Teams**. For the scopes used by `bulk-permissions` and `bulk-enable`, see [Bulk Permission Management](README-Post-Migration.md#bulk-permission-management) and [Bulk Environment Enablement](README-Post-Migration.md#bulk-environment-enablement).

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

---

## Migrate flags

```bash
npx @datadog/dd-flag-migration migrate   # choose "Eppo → Datadog"
```

The tool follows the [general migration workflow](README.md#step-1--migrate-flags): map each Eppo environment to one or more Datadog environments, select flags, then confirm.

### Advanced filtering

During flag selection, press **Tab** to open a multi-select filter screen. Categories start unchecked, which means no category filter is applied and all flags remain visible. Check one or more categories to narrow the flag list, then press **Enter** to apply the filter selection and return to flag selection, or **Escape** to cancel filter changes. Checking every category is equivalent to applying no category filter. Any selected flags that no longer match the applied filters are automatically unselected on return.

The available categories are:

- **previously-migrated** — a matching flag already exists in Datadog; its targeting rules may still differ
- **not-yet-migrated** — no matching flag exists in Datadog yet

Eppo does not expose flag usage-recency data, so lifecycle categories such as LaunchDarkly's **active** and **inactive** aren't available.

### Re-syncing existing flags

Selecting an Eppo flag that already exists in Datadog syncs it from Eppo. See [Re-syncing existing flags](README.md#re-syncing-existing-flags) for general behavior.

The tool preserves numbered suffixes added to resolve duplicate display names,
such as `Flag (1)`, while applying source name changes. If an updated name is
already taken, the tool tries another numbered suffix without changing the
flag's key or ID. Dry runs cannot check whether a new name is already taken.

### Non-interactive mode

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. Set `DD_SITE` in the job environment or pass `--datadog-site`; you do not need to provide both.

Non-interactive migrations use `--tag-mode merge` by default, preserving tags that exist only in Datadog. Use `--tag-mode replace` to replace existing tags with the tags derived from Eppo. In interactive mode, specifying `--tag-mode` skips the tag-mode prompt.

Eppo exposes no flag schema, so re-migrating a JSON flag clears any schema in Datadog. Environments awaiting enable approval are reported separately and do not count as enabled.

Non-interactive migrations write a JSON result document to stdout. Status messages, progress output, and export messages are written to stderr so stdout can be piped into tools such as `jq`.

**Required flags**

| Flag | Description |
|---|---|
| `--provider Eppo` | Source provider (case-insensitive) |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`); optional when `DD_SITE` is set |
| `--env-map <source,target>` | Map a source environment to a Datadog environment. Repeat the option—including the same source—to map one source environment to multiple Datadog environments |
| `--feature-flag <key>` | Flag key to migrate. Repeat for each flag |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without writing to Datadog |
| `--export=<bool>` | Export results to an `.xlsx` file in the current directory (default: `false`) |
| `--tag-mode <merge\|replace>` | Tag sync behavior (non-interactive default: `merge`) |

**Examples**

Eppo migrations don't need a project key.

Migrate an Eppo flag:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --env-map production,Production \
  --feature-flag my-flag
```

---

## Tag sync

See [Tag Sync](README-Post-Migration.md#tag-sync) for the workflow and sync strategies.

For Eppo flags, the source tag set is the flag's `tag_names` as-is.

### Non-interactive tag sync

Pass `--interactive=false` to run the tag sync entirely from CLI arguments. Non-interactive runs write a JSON result document to stdout, including the report's `exportPath`; status messages and spreadsheet confirmation go to stderr.

**Required flags**

| Flag | Description |
|---|---|
| `--provider Eppo` | Source provider (case-insensitive) |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`) |
| `--feature-flag <key>` | Flag key to sync tags for. Repeat for each flag |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview tag changes without writing to Datadog |
| `--tag-mode <additive\|replace>` | Tag sync strategy (default: `additive`). Also accepts `merge` and `full` as aliases |

**Examples**

Preview an additive tag sync for an Eppo flag:

```bash
npx @datadog/dd-flag-migration sync-tags --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --dry-run \
  --feature-flag my-flag
```

---

## Evaluate the migration

See [Step 2 — Evaluate the migration](README.md#step-2--evaluate-the-migration) for the general workflow and options. Results show the Eppo value next to the Datadog value.

### Evaluate a single flag

Choose **A flag** to evaluate one flag migrated from Eppo for many random subjects (10,000 by default; set with `--subjects=<n>`) in both platforms. The command lists mismatches, exits with status 1 if any subject differs, and can export every evaluation to `.xlsx`.

---

## Unsupported features

Some Eppo features have no direct equivalent in Datadog. The tool handles each case automatically — skipping the flag, failing it with a reason, or applying the closest supported equivalent and recording the adjustment in the migration results.

### Flags that are skipped

| Feature | Reason |
|---|---|
| `BANDIT` and `LAYER` flag types | These flag types are not yet supported and are skipped. |

### Flags that fail migration

Eppo flags are migrated with Eppo-compatible bucketing, so every subject keeps the variation and exposure it had in Eppo. A flag fails with a reason, and nothing is written for it, when Datadog can't reproduce how Eppo assigns its subjects:

| Case | How to fix it |
|---|---|
| Eppo's production environment has no default, a targeted default, or a default below 100% exposure, whether or not it's mapped or active | Set a default variation in Eppo. In interactive mode, the tool instead asks you to choose the variant that matches the fallback value in your code (or skip the flag); that variant also becomes the default of every other environment without one. Existing flags migrated with Eppo-compatible bucketing keep the defaults chosen when they were created and aren't asked again. |
| Another active environment has no default, a targeted default, or a default below 100% exposure | Set a default variation in Eppo. Unmatched subjects would otherwise receive the SDK fallback value, which Datadog can't represent. Disabled environments don't need a default; they get the production default. |
| A split's active variations all have zero weight | Give one variation a weight in Eppo. |
| Eppo returns no variation weight IDs for a split | Use an Eppo API version that returns them; they set the split order. |
| Two targeting filters would get the same key | Rename one of the Eppo allocations. Datadog requires targeting filter keys to be unique per org. |
| A Datadog flag with the same key exists but wasn't migrated from Eppo | Rename or delete the Datadog flag. The tool never overwrites it. |
| The Eppo flag is linked to a Datadog flag with a different key | The key is part of every Eppo bucketing salt, so the keys must match. |

### Flags that are migrated with adjustments

| Feature | How it's handled |
|---|---|
| JSON variants that are top-level arrays | Datadog requires JSON variant values to be objects. Array-valued variants are automatically wrapped: `[...]` becomes `{ "value": [...] }`. A warning is recorded in the migration results. |
| JSON flag schemas | Eppo exposes no flag schema, so re-migrating a JSON flag clears any schema in Datadog. |

---

## How it works

For each selected flag, the tool:

- Reads the flag's variations, targeting filters, and targeting rules from Eppo, skipping disabled targeting filters and deactivated variations
- Creates an equivalent flag in Datadog via the Feature Flags API with Eppo-compatible bucketing: Eppo's raw weights, allocation and variation weight IDs, and a default variant are sent so Datadog assigns subjects exactly as Eppo does. Partial exposure becomes a rollout that starts immediately
- Sets each environment's default variant before enabling any environment
- Synchronizes the Eppo display name when re-migrating an existing Datadog flag, and the targeting of every mapped environment, including disabled ones
- Enables the flag in the Datadog environments that correspond to active Eppo environments

Flags migrated before Eppo-compatible bucketing follow the same rules when re-migrated, including the failures above, but keep Datadog bucketing: no Eppo IDs are sent and their targeting filter keys never change. A warning is recorded, because subjects in splits and partial rollouts are not assigned as in Eppo.

Flags of type `BANDIT` or `LAYER` are skipped (not yet supported).
