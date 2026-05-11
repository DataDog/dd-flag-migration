# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-05-11

First public release.

### Migration — Eppo

- Migrate Eppo flags to Datadog via interactive CLI
- Map variation types (`BOOLEAN`, `INTEGER`, `NUMERIC`, `JSON`, `STRING`)
- Translate targeting filters and targeting rules from Eppo allocations
- Enable flags in the Datadog environments that correspond to active Eppo environments
- Skip flags of unsupported types (`BANDIT`, `LAYER`)

### Migration — LaunchDarkly

- Migrate LaunchDarkly flags to Datadog via interactive CLI
- Map flag types (`boolean`, multivariate) to Datadog value types (`BOOLEAN`, `STRING`, `NUMERIC`, `JSON`)
- Convert individual user targets into `ONE_OF` targeting conditions on the `key` attribute
- Translate targeting rule clauses: `in`, `contains`, `startsWith`, `endsWith`, `matches`, numeric comparisons (`lt`, `lte`, `gt`, `gte`), and semver comparisons (`semVerEqual`, `semVerLessThan`, `semVerGreaterThan`, `semVerLessThanOrEqual`, `semVerGreaterThanOrEqual`)
- Support negated operators (De Morgan's law inversion for comparison operators; `NOT_ONE_OF`, `NOT_MATCHES`)
- Convert percentage rollouts from LaunchDarkly's 100,000-weight scale to Datadog's 0–100 scale
- Create a fallthrough (default) targeting filter per environment
- Enable flags in Datadog environments where the flag was enabled (`on: true`) in LaunchDarkly
- Set `distribution_channel: CLIENT` for flags with semver targeting conditions
- Sync targeting for flags that already exist in Datadog when new environments are added
- Detect and skip archived flags
- Detect progressive rollouts via the releases API and skip flags with rollouts still in progress
- Warn on flags with prerequisites (migrated but prerequisites are not enforced in Datadog)
- Skip flags that use unsupported date-based operators (`before`, `after`)

#### Segment migration (Phase 1)

- Discover all LD segments referenced by selected flags and migrate them as Datadog saved filters
- Non-negated `segmentMatch` clauses → OR fan-out targeting rules (one rule per segment)
- Negated `segmentMatch` clauses → AND-combined saved filter conditions (all segments required)
- Cap fan-out at 100 combinations; skip the flag if exceeded

#### Cross-project conflict resolution

- Detect flag key conflicts between LaunchDarkly projects migrating into the same Datadog organization
- Offer skip or prefix options for conflicting flags; prefix is applied to the Datadog flag key

#### Team-based access control (RBAC)

- Walk LaunchDarkly custom roles and team assignments to identify teams with edit access to the project
- Translate those teams to Datadog restriction policies on migrated flags
- Interactively resolve team key mismatches between LaunchDarkly and Datadog
- Migrate LaunchDarkly flag tags to Datadog

### Evaluation

- Compare flag evaluations side-by-side between Eppo and Datadog using source SDK and Datadog CDN
- Auto-generate test cases from each flag's targeting rules
- Import custom test cases from a CSV file
- Display results in a table with match/mismatch highlighting

### CLI

- Interactive provider selection (Eppo, LaunchDarkly)
- Credential prompts with server-side validation; credentials saved to `~/.dd-flag-migration/config.json`
- Dry run mode (`--dry-run`) writes all API requests to a timestamped JSON file without creating flags
- Multi-site support (`datadogSite` config key) for EU, US3, US5, AP1 regions
- Export migration results to `.xlsx`
- Supply chain security via `@lavamoat/allow-scripts` (all dependency install scripts blocked by default)
