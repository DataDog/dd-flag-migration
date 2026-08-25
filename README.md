# Datadog Feature Flag Migration Tool

A CLI tool for migrating feature flags from your current provider into [Datadog Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/), with side-by-side evaluation to verify the migration before you switch over.

**Supported providers:** Eppo, LaunchDarkly

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

---

## Installation

Run without installing using `npx`:

```bash
# migrate flags
npx @datadog/dd-flag-migration migrate

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

## Credentials you'll need

Credentials are read from environment variables. Set them in your shell (or `.envrc`, `.env` loader, secret manager, etc.) before running `migrate`, `evaluate`, `bulk-permissions`, `bulk-enable`, or `sync-tags`. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1.

`DD_SITE` is optional for interactive commands and pre-fills the Datadog site prompt when set. For non-interactive `migrate` runs, use either `DD_SITE` or `--datadog-site`; the explicit CLI option takes precedence. The standalone `scripts/get-datadog-flag.sh` script requires `DD_SITE` and does not accept a site argument.

### Required for `migrate`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_API_KEY` | always | Datadog → Organization Settings → API Keys |
| `DD_APP_KEY` | always | Datadog → Organization Settings → Application Keys |
| `EPPO_API_KEY` | provider = Eppo | Eppo → Configuration → API Keys |
| `LAUNCHDARKLY_API_KEY` | provider = LaunchDarkly | LaunchDarkly → Account settings → Authorization → Access tokens |

Your LaunchDarkly access token needs **Reader** role permissions (or a custom role with `viewProject` access) to read projects, environments, and flag configurations.

`EPPO_*` variables are checked only when you select Eppo as the source provider. `LAUNCHDARKLY_*` variables are checked only when you select LaunchDarkly. You don't need to set both.

### Required for `evaluate`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_CLIENT_TOKEN` | always | Datadog → Organization Settings → Client Tokens |
| `EPPO_SDK_KEY` | migration was from Eppo | Eppo → SDK Keys (server SDK key, one per environment) |
| `LAUNCHDARKLY_API_KEY` | migration was from LaunchDarkly *(preferred)* | LaunchDarkly → Account settings → Authorization → Access tokens |

### Required for `bulk-permissions`, `bulk-enable`, and `sync-tags`

| Variable | Required when | Where to find it |
|---|---|---|
| `DD_API_KEY` | always | Datadog → Organization Settings → API Keys |
| `DD_APP_KEY` | always | Datadog → Organization Settings → Application Keys |

`sync-tags` also needs the source provider's credentials (`EPPO_API_KEY` or `LAUNCHDARKLY_API_KEY`) depending on the provider you select — the same variables used by `migrate`.

### Datadog Application Key permissions

Enable the scopes required for the command you are running:

| Scope | Required by | Description |
|---|---|---|
| `feature_flag_approvals_override` | Optional for `bulk-enable` | Bypasses Feature Flag approval requirements. Without it, approval-protected changes are submitted as approval requests and reported as such. |
| `feature_flag_config_read` | `migrate`, `bulk-permissions`, `bulk-enable`, `sync-tags` | View Feature Flag Configurations |
| `feature_flag_config_write` | `migrate`, `bulk-enable`, `sync-tags` | Edit Feature Flag Configurations |
| `feature_flag_environment_config_read` | `migrate`, `bulk-enable`, `sync-tags` | View Feature Flag Environment settings |
| `teams_read` | `migrate`, `bulk-permissions`, `sync-tags` | View Teams for team-based access controls |
| `restriction_policies_read` | `bulk-permissions` | View restriction policies |
| `restriction_policies_write` | `bulk-permissions` | Edit restriction policies |

To set these permissions, go to **Organization Settings → Application Keys**, select your key, and enable the scopes for the command. The feature flag scopes are under **Feature Flags**, `teams_read` is under **Teams**, and restriction-policy scopes are only used by `bulk-permissions`.

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

## Step 1 — Migrate flags

```bash
npx @datadog/dd-flag-migration migrate
```

The tool will walk you through:

1. **Select your provider** — Eppo or LaunchDarkly
2. **Map environments** — link each source environment (e.g. `production`) to one or more corresponding Datadog environments
3. **Select flags** — choose which flags to migrate; flags already in Datadog are marked. Press **Tab** to open the advanced-filter screen and narrow the list by category (see [Advanced filtering](#advanced-filtering)), then **Ctrl+A** to select all remaining flags
4. **Confirm and migrate** — flags are created in Datadog and enabled in the mapped environments. A progress bar tracks migration status in real time

API keys are read from environment variables (see [Credentials](#credentials-youll-need)).
Set `DD_SITE` to pre-fill the Datadog site prompt, or pass `--datadog-site=<site>` to provide an explicit site without a prompt. For fully scripted runs, see [Non-interactive mode](#non-interactive-mode) below.

When the migration completes, a record is saved to `~/.dd-flag-migration/migration-<timestamp>.json`. In interactive mode you'll be prompted to export results to an `.xlsx` file; in non-interactive mode pass `--export=true` to generate one.

### Large migrations

For large flag sets, the tool supports splitting work across multiple runs:

- **Progress bar** — a sticky progress bar shows how many flags have been migrated so far, updating in real time
- **Tab to filter** — during flag selection, press **Tab** to open the advanced-filter screen and narrow the list by category, such as `not-yet-migrated`. Combined with **Ctrl+A**, this makes it easy to select only the remaining flags for the next run. See [Advanced filtering](#advanced-filtering)
- **Ctrl+C to save progress** — pressing **Ctrl+C** during migration saves a partial migration file (`~/.dd-flag-migration/migration-<timestamp>.json`) with all flags that completed successfully before the interruption. You can resume later by filtering to `not-yet-migrated` with **Tab**

### Advanced filtering

During flag selection, press **Tab** to open a multi-select filter screen. Categories start unchecked, which means no category filter is applied and all flags remain visible. Check one or more categories to narrow the flag list, then press **Enter** to apply the filter selection and return to flag selection, or **Escape** to cancel filter changes. Checking every category is equivalent to applying no category filter. Any selected flags that no longer match the applied filters are automatically unselected on return.

The available categories are:

- **new** — any environment — LaunchDarkly reports new for at least one non-archived environment _(LaunchDarkly only)_
- **active** — any environment — LaunchDarkly reports active for at least one non-archived environment _(LaunchDarkly only)_
- **inactive** — all environments — LaunchDarkly reports inactive for every non-archived environment whose status could be loaded _(LaunchDarkly only)_
- **launched** — any environment — LaunchDarkly reports launched for at least one non-archived environment _(LaunchDarkly only)_
- **previously-migrated** — flag — a matching flag already exists in Datadog; its targeting rules may still differ _(both providers)_
- **not-yet-migrated** — flag — no matching flag exists in Datadog yet _(both providers)_

The four lifecycle categories are derived from [LaunchDarkly flag statuses](https://launchdarkly.com/docs/api/feature-flags/get-feature-flag-status-across-environments), which are tracked per environment. Environment selection still controls what gets migrated; lifecycle filters look across all non-archived LaunchDarkly environments in the project so they can answer whether a flag appears to be used anywhere. If a status fetch fails, the tool does not treat that missing data as inactive. Eppo does not expose flag usage-recency data, so only the migration-state categories are available when migrating from Eppo.

### LaunchDarkly-specific workflow

When migrating from LaunchDarkly, the tool adds these steps:

1. **Select a LaunchDarkly project** — flags in LaunchDarkly are scoped to a project, so you pick one project at a time
2. **Select LaunchDarkly environments** — choose which environments within that project to migrate
3. **Link environments** — map each selected LaunchDarkly environment to one or more Datadog environments
4. **Select flags** — flags already in Datadog are shown with a checkmark and will have their targeting synced for new environments rather than being re-created

The tool translates LaunchDarkly targeting rules, individual user targets, percentage rollouts, and fallthrough variations into equivalent Datadog targeting filters. Before migrating flags, the tool runs a segment migration phase that converts referenced LaunchDarkly segments into Datadog saved filters and substitutes them into targeting rules. Flags that use unsupported operators (`before`, `after`) are automatically skipped with an explanation. Flags with prerequisites are migrated with a warning, since Datadog does not enforce prerequisites.

### Non-interactive mode

Pass `--interactive=false` to run the migration entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. Set `DD_SITE` in the job environment or pass `--datadog-site`; you do not need to provide both.

Non-interactive migrations write a JSON result document to stdout. Status messages, progress output, and export messages are written to stderr so stdout can be piped into tools such as `jq`.

**Required flags**

| Flag | Description |
|---|---|
| `--provider <Eppo\|LaunchDarkly>` | Source provider (case-insensitive) |
| `--datadog-site <site>` | Datadog site (e.g. `datadoghq.com`); optional when `DD_SITE` is set |
| `--env-map <source,target>` | Map a source environment to a Datadog environment. Repeat the option—including the same source—to map one source environment to multiple Datadog environments |
| `--feature-flag <key>` | Flag key to migrate. Repeat for each flag. For LaunchDarkly, use `<source-key>,<datadog-key>` to rename the Datadog flag |
| `--project <key>` | LaunchDarkly project key *(LaunchDarkly only)* |

**Optional flags**

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without writing to Datadog |
| `--export=<bool>` | Export results to an `.xlsx` file after migration (default: `false`) |

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

Migrate Eppo flags (no project key required):

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --env-map production,Production \
  --feature-flag my-flag
```

### Dry run

To preview what would be created without making any changes:

```bash
npx @datadog/dd-flag-migration migrate --dry-run
```

This writes the full list of API requests that would be sent to a `dry-run-<timestamp>.json` file in the current directory.

---

## Bulk Permission Management

After flags have been migrated, add or remove explicit Datadog team permissions with:

```bash
npx @datadog/dd-flag-migration bulk-permissions

# When running from this repository:
yarn bulk-permissions
```

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

The interactive flow mirrors the `migrate` command's provider and flag selection:

1. **Select a provider** — Eppo or LaunchDarkly.
2. For LaunchDarkly, **select a project** using the same project picker as `migrate`.
3. **Select flags** — the same searchable, filterable flag list used by `migrate`. Only flags that already exist in Datadog can have their tags synced; flags with no Datadog match are skipped.
4. **Choose a sync strategy** — *Additive Merge* or *Full Replace*.

### Sync strategies

- **Additive Merge** (default) — adds the source tags to each Datadog flag while preserving any tags that already exist in Datadog. Source tags are unioned with the existing Datadog tags; nothing is removed. This is the safe default and never deletes tags.
- **Full Replace** — replaces the Datadog flag's tags with exactly the source tags. Tags that exist only in Datadog are removed, so removals in the source platform propagate to Datadog. Use this when the source platform is the source of truth for tags.

For LaunchDarkly flags, the source tag set is the flag's own LD tags plus the `project:<key>` migration-link tag (so the Datadog→LaunchDarkly link is preserved on Full Replace). Team tags derived from the LaunchDarkly RBAC editor-team walk are not re-synced here — they belong to the restriction-policy flow.

For Eppo flags, the source tag set is the flag's `tag_names` as-is.

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

Preview an additive tag sync for an Eppo flag:

```bash
npx @datadog/dd-flag-migration sync-tags --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --dry-run \
  --feature-flag my-flag
```

### Dry run

To preview tag changes without writing to Datadog:

```bash
npx @datadog/dd-flag-migration sync-tags --dry-run
```

---

## Step 2 — Evaluate the migration

Once flags have been migrated, run the evaluation to compare how flags are evaluated in Eppo vs. Datadog for the same inputs:

```bash
npx @datadog/dd-flag-migration evaluate
```

The tool will:

1. **Select a migration file** — pick from previous migrations (most recent first)
2. **Select a Datadog environment** — choose which environment to evaluate against
3. **Enter a test subject ID** — a user ID (or any string) to use for flag evaluation
4. **Run evaluations** — the tool generates test cases from each flag's targeting rules and compares the provider and Datadog results side by side

Datadog and provider credentials are read from environment variables (see [Credentials](#credentials-youll-need)).

Results are displayed in a table showing the Eppo value, Datadog value, migration status, and whether the flag is enabled. Matching values are shown in green; differences in yellow.

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

Some LaunchDarkly and Eppo features have no direct equivalent in Datadog. The tool handles each case automatically — either by skipping the affected flag entirely or by applying the closest supported equivalent and recording the adjustment in the migration results.

### Flags that are skipped

| Feature | Provider | Reason |
|---|---|---|
| Date targeting (`before` / `after` operators) | LaunchDarkly | Date-based targeting conditions have no equivalent in Datadog targeting filters. Flags that use these operators are skipped. |
| Archived flags | LaunchDarkly | Archived flags are excluded from the migration entirely. |
| `BANDIT` and `LAYER` flag types | Eppo | These flag types are not yet supported and are skipped. |

### Flags that are migrated with adjustments

| Feature | Provider | How it's handled |
|---|---|---|
| Dependent flags (prerequisites) | LaunchDarkly | Datadog does not enforce flag prerequisites. Flags that depend on another flag being in a specific state are migrated with a warning, since the prerequisite relationship is not preserved. |
| SEMVER targeting on server-side flags | LaunchDarkly | SEMVER comparisons are a client-SDK feature in Datadog. Flags that use SEMVER targeting are automatically migrated with the **CLIENT** distribution channel, regardless of how they were originally configured. A warning is recorded in the migration results. |
| JSON variants that are top-level arrays | LaunchDarkly, Eppo | Datadog requires JSON variant values to be objects. Array-valued variants are automatically wrapped: `[...]` becomes `{ "value": [...] }`. A warning is recorded in the migration results. |

### Features with limited evaluation support

| Feature | Provider | Behavior |
|---|---|---|
| Mobile context kinds (`ld_application`, `ld_device`) | LaunchDarkly | These context kinds are auto-populated by LaunchDarkly's mobile client SDKs and cannot be evaluated by the server-side Node.js SDK used by this tool. Targeting rules that use them are shown as **not evaluated** during the evaluation step. The migration itself is correct — targeting rules are translated using the same prefixed attribute format (e.g. `ld_application.versionName`). |

---

## How it works

### Migration

#### Eppo

For each selected flag, the tool:

- Reads the flag's variations, targeting filters, and targeting rules from Eppo
- Creates an equivalent flag in Datadog via the Feature Flags API
- Enables the flag in the Datadog environments that correspond to active Eppo environments

Flags of type `BANDIT` or `LAYER` are skipped (not yet supported).

#### LaunchDarkly

For each selected flag, the tool:

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
- Creates a fallthrough (default) targeting filter for the environment
- For flags that already exist in Datadog, syncs targeting for newly mapped environments instead of re-creating the flag
- Enables the flag in Datadog environments where it was enabled (`on: true`) in LaunchDarkly

Archived flags and flags using unsupported operators (`before`, `after`) are skipped automatically. Individual segment rules that use unsupported features (multi-context membership, nested `segmentMatch`, or negation explosions) are skipped with a warning; the flags that reference them are still migrated with their other targeting rules intact.

### Evaluation

The evaluation tool generates test cases automatically from each flag's targeting rules — producing inputs that should match each rule and inputs that should not. It then calls the source provider's SDK and the Datadog feature flag CDN with the same subject ID and attributes, and compares the results.

This lets you verify that flag targeting logic was translated correctly before you cut over your application.

#### LaunchDarkly — mobile context kinds

Flags that target `ld_application` or `ld_device` context kinds (auto-populated by LaunchDarkly's mobile client SDKs) cannot be evaluated via the Node.js server-side SDK used by this tool. Test cases for those rules are shown as **not evaluated** (dimmed) with an explanatory note. The migration itself is correct — the targeting rules are translated into Datadog using the same prefixed attribute format (e.g. `ld_application.versionName`).
