# Post-migration actions

These commands help you manage flags after they've been migrated to Datadog. For installation and the primary commands (`migrate`, `migration-status`, and `evaluate`), see the [main README](README.md).

```bash
# manage team permissions after migration
npx @datadog/dd-flag-migration bulk-permissions

# enable migrated flags in one or more environments
npx @datadog/dd-flag-migration bulk-enable

# sync tags from your source provider onto migrated flags
npx @datadog/dd-flag-migration sync-tags
```

Credentials are read from environment variables. If any required variable is missing, the tool prints a list of the missing names to stderr and exits with code 1. Each section below lists the variables and Datadog Application Key scopes the command needs.

---

## Bulk permission management

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

## Bulk environment enablement

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

## Tag sync

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
