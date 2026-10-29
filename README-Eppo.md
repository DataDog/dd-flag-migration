# Eppo → Datadog migration

This guide covers migrating feature flags from Eppo to Datadog Feature Flags. For installation and the workflow shared by every migration, see the [main README](README.md). For bulk management of migrated flags, see [Post-migration actions](README-Post-Migration.md).

Credentials are read from environment variables, and each section below lists the ones it needs. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running the tool. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1. Credentials are never read from or written to the tool's config file.

---

## Contents

- [Migrate flags](#migrate-flags)
  - [Migration credentials](#migration-credentials)
  - [Advanced filtering](#advanced-filtering)
  - [Re-syncing existing flags](#re-syncing-existing-flags)
- [Non-interactive migrations](#non-interactive-migrations)
- [Migration status](#migration-status)
  - [Migration status credentials](#migration-status-credentials)
- [Evaluate the migration](#evaluate-the-migration)
  - [Evaluation credentials](#evaluation-credentials)
  - [Evaluate a single flag](#evaluate-a-single-flag)
- [Unsupported features](#unsupported-features)
  - [Flags that are skipped](#flags-that-are-skipped)
  - [Flags that fail migration](#flags-that-fail-migration)
  - [Flags that are migrated with adjustments](#flags-that-are-migrated-with-adjustments)
- [How it works](#how-it-works)

---

## Migrate flags

```bash
npx @datadog/dd-flag-migration migrate   # choose "Eppo → Datadog"
```

The tool follows the [general migration workflow](README.md#step-1--migrate-flags): map each Eppo environment to one or more Datadog environments, select flags, then confirm.

### Migration credentials

| Variable | Where to find it |
|---|---|
| `DD_API_KEY` | Datadog → Organization Settings → API Keys |
| `DD_APP_KEY` | Datadog → Organization Settings → Application Keys |
| `EPPO_API_KEY` | Eppo → Configuration → API Keys |

`DD_SITE` is optional for interactive runs and pre-fills the Datadog site prompt when set. For non-interactive runs, use either `DD_SITE` or `--datadog-site`; the explicit CLI option takes precedence. See [Non-US Datadog sites](README.md#non-us-datadog-sites) for site values.

Enable these scopes on the key in `DD_APP_KEY`:

| Scope | Description |
|---|---|
| `feature_flag_config_read` | View Feature Flag Configurations |
| `feature_flag_config_write` | Edit Feature Flag Configurations |
| `feature_flag_environment_config_read` | View Feature Flag Environment settings |
| `teams_read` | View Teams to add `team:<handle>` tags for the Eppo teams that own each flag |

To set these permissions, go to **Organization Settings → Application Keys**, select your key, and enable the scopes. The feature flag scopes are under **Feature Flags** and `teams_read` is under **Teams**.

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export EPPO_API_KEY=...

npx @datadog/dd-flag-migration migrate
```

### Team tags

Each migrated flag gets a `team:<handle>` tag for every Eppo team that owns it, as long as the Eppo team matches a Datadog team. A team matches when its Eppo name equals a Datadog team handle, the name's slug equals a handle (`Team A` matches `team-a`), or the name equals a Datadog team name, ignoring case. Interactive migrations offer to map unmatched teams by hand; non-interactive migrations skip them. Archived Eppo teams are ignored.

Team tags follow the selected tag mode. They don't change who can edit the flag in Datadog: Eppo exposes no permissions to migrate. If Eppo or Datadog teams can't be fetched, flags are migrated without team tags.

### Advanced filtering

During flag selection, press **Tab** to open a multi-select filter screen. Categories start unchecked, which means no category filter is applied and all flags remain visible. Check one or more categories to narrow the flag list, then press **Enter** to apply the filter selection and return to flag selection, or **Escape** to cancel filter changes. Checking every category is equivalent to applying no category filter. Any selected flags that no longer match the applied filters are automatically unselected on return.

The available categories are:

- **previously-migrated** — a matching flag already exists in Datadog; its targeting rules may still differ
- **not-yet-migrated** — no matching flag exists in Datadog yet

Eppo does not expose flag usage-recency data, so lifecycle categories such as LaunchDarkly's **active** and **inactive** aren't available.

### Re-syncing existing flags

Selecting an Eppo flag that already exists in Datadog syncs it from Eppo. See [Re-syncing existing flags](README.md#re-syncing-existing-flags) for general behavior.

If the matching Datadog flag is archived, the tool automatically restores it before syncing, without an additional prompt or option. This applies only to Eppo migrations and requires the archived flag's migration metadata to identify the same Eppo source flag ID. An active match takes precedence. Restoration preserves the existing flag and variant IDs and reuses its targeting-filter keys instead of creating a replacement.

If multiple archived flags match the same Eppo source ID, the tool fails that flag rather than choosing one. Restore the intended flag in Datadog and re-run the migration. A failed or approval-required restoration also stops that flag's sync; no replacement is created. If restoration succeeds but a later sync fails, the flag remains restored. Migration reports list successful restorations in `restoredKeys`, including when a later step fails. Dry runs list planned restorations there and record the unarchive request without changing Datadog.

The tool preserves numbered suffixes added to resolve duplicate display names, such as `Flag (1)`, while applying source name changes. If an updated name is already taken, the tool tries another numbered suffix without changing the flag's key or ID. Dry runs cannot check whether a new name is already taken.

---

## Non-interactive migrations

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. It uses the same [credentials](#migration-credentials) as an interactive migration. Set `DD_SITE` in the job environment or pass `--datadog-site`; you do not need to provide both.

Non-interactive migrations use `--tag-mode merge` by default, preserving tags that exist only in Datadog. Use `--tag-mode replace` to replace existing tags with the tags derived from Eppo.

Environments awaiting enable approval are reported separately and do not count as enabled.

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
| `--export[=<bool>]` | Export results to an `.xlsx` file in the current directory (bare option enables export; default: `false`) |
| `--tag-mode <merge\|replace>` | Tag sync behavior (non-interactive default: `merge`) |

**Examples**

Migrate an Eppo flag:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --env-map production,Production \
  --feature-flag my-flag
```

---

## Migration status

```bash
npx @datadog/dd-flag-migration migration-status   # choose "Eppo → Datadog"

# When running from this repository:
yarn migration-status
```

This is an interactive, read-only comparison. Select Eppo environments, map each to one or more Datadog environments, and select the flags to check. The flag picker supports the same **Tab** migration-state filters as migration. No flags, audiences, or environment settings are changed.

The report labels flags **Not yet migrated**, **Partially migrated**, **Out of sync**, **In sync**, or **Needs review**. Only the selected environment mappings affect environment status. It compares flag names, variants, environment enablement, defaults, targeting filters, weights, partial exposure, and Eppo bucketing IDs. Disabled environments' targeting is compared too, matching the Eppo re-migration behavior.

A `migration-status-eppo-<timestamp>.xlsx` workbook is written automatically to the current directory, with a summary and one status tab per selected Datadog environment.

Flags are linked by Eppo migration metadata and source flag ID. Same-key flags without matching metadata, duplicate matches, differing source/target flag keys, and configurations that cannot be verified require review rather than being treated as successfully migrated.

**Limitations:** Tags, permissions, restriction policies, JSON schemas, and saved-filter contents are not assessed. Audience references are compared, including legacy inline audience references. Missing audience data or unsupported negation requires review. Legacy flags retain Datadog bucketing, so matching configuration does not guarantee matching subject assignments in splits or partial rollouts; use [evaluation](#evaluate-the-migration) to check assignments. If Eppo removes a default, the report shows the retained Datadog default as a difference, but Datadog cannot clear it during re-migration.

### Migration status credentials

Set `DD_API_KEY`, `DD_APP_KEY`, and `EPPO_API_KEY`. `DD_SITE` optionally pre-fills the site prompt. The Datadog application key needs only `feature_flag_config_read` and `feature_flag_environment_config_read`; write permissions, `teams_read`, SDK keys, and LaunchDarkly credentials are not required.

---

## Evaluate the migration

See [Step 2 — Evaluate the migration](README.md#step-2--evaluate-the-migration) for the general workflow and options. Results show the Eppo value next to the Datadog value.

### Evaluation credentials

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_API_KEY`, `DD_APP_KEY` | always | Datadog → Organization Settings → API Keys and Application Keys |
| `DD_CLIENT_TOKEN` | evaluating a migration or a client-only flag | Datadog → Organization Settings → Client Tokens |
| `EPPO_SDK_KEY` | always | Eppo → SDK Keys (server SDK key, one per environment) |
| `EPPO_API_KEY` | evaluating a single flag | Eppo → Configuration → API Keys |

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export DD_CLIENT_TOKEN=...
export EPPO_SDK_KEY=...

npx @datadog/dd-flag-migration evaluate
```

### Evaluate a single flag

Choose **A flag** to evaluate one flag migrated from Eppo for many random subjects (10,000 by default; set with `--subjects=<n>`) in both platforms. The command lists mismatches, exits with status 1 if any subject differs, and can export every evaluation to `.xlsx`.

It compares the Eppo environment of `EPPO_SDK_KEY` with the Datadog environment you choose. Flags migrated before Eppo-compatible bucketing use Datadog bucketing, so subjects in their splits are expected to differ from Eppo.

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
| A flag migrated before Eppo-compatible bucketing has no default, a targeted default, or a default below 100% exposure in Eppo's production environment (mapped or not, active or not) or in another active environment | Set a default variation in Eppo. These flags keep Datadog bucketing, which requires a default variant. |
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
| Environments without a default | When an Eppo environment has no default, a targeted default, or a default below 100% exposure, the Datadog environment has no default either, so unmatched subjects receive the fallback value from your code, as in Eppo. Datadog can't clear a default once it's set, so if you remove an Eppo default after migrating, re-migrating keeps the Datadog default. |

---

## How it works

For each selected flag, the tool:

- Reads the flag's variations, targeting filters, and targeting rules from Eppo, skipping disabled targeting filters and deactivated variations
- Creates an equivalent flag in Datadog via the Feature Flags API with Eppo-compatible bucketing: Eppo's raw weights, allocation and variation weight IDs, and a default variant are sent so Datadog assigns subjects exactly as Eppo does. Partial exposure becomes a rollout that starts immediately
- Sets each environment's default variant before enabling any environment
- Synchronizes the Eppo display name when re-migrating an existing Datadog flag, and the targeting of every mapped environment, including disabled ones
- Enables the flag in the Datadog environments that correspond to active Eppo environments

Flags migrated before Eppo-compatible bucketing follow the same rules when re-migrated, including the failures above, but keep Datadog bucketing: no Eppo IDs are sent and their targeting filter keys never change. A warning is recorded, because subjects in splits and partial rollouts are not assigned as in Eppo.
