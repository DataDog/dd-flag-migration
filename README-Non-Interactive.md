# Non-interactive mode

Pass `--interactive=false` to run `migrate` or `sync-tags` entirely from CLI arguments, with no prompts. This is useful for scripted or CI environments. For installation and the interactive workflows, see the [main README](README.md).

Credentials are read from environment variables, the same as in interactive mode. See the credentials section of your migration guide: [Eppo](README-Eppo.md#credentials-youll-need), [LaunchDarkly](README-LaunchDarkly.md#credentials-youll-need), or [Datadog → Datadog](README-Datadog.md#credentials-youll-need).

---

## migrate

Set `DD_SITE` in the job environment or pass `--datadog-site`; you do not need to provide both.

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

### Eppo → Datadog

Eppo migrations don't need a project key.

Migrate an Eppo flag:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --env-map production,Production \
  --feature-flag my-flag
```

### LaunchDarkly → Datadog

LaunchDarkly migrations require `--project`.

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

### Datadog → Datadog

`--datadog-site` and `--project` are not used for `Datadog`.

Copy flags from the `SOURCE_DD_*` org to the `TARGET_DD_*` org. Environment names in `--env-map` are `source-org-environment,target-org-environment`:

```bash
npx @datadog/dd-flag-migration migrate --interactive=false \
  --provider Datadog \
  --env-map Production,Production \
  --env-map Staging,Staging \
  --feature-flag flag-one
```

---

## sync-tags

Non-interactive tag sync runs write a JSON result document to stdout, including the report's `exportPath`; status messages and spreadsheet confirmation go to stderr.

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

### sync-tags examples

Preview an additive tag sync for an Eppo flag:

```bash
npx @datadog/dd-flag-migration sync-tags --interactive=false \
  --provider Eppo \
  --datadog-site datadoghq.com \
  --dry-run \
  --feature-flag my-flag
```

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
