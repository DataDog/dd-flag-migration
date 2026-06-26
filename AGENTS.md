# Agent guidelines

Guidance for future changes to dd-flag-migration.

## Re-migration sync contract

Customers typically run their source platform (LaunchDarkly or Eppo) and Datadog in parallel for weeks-to-months while migrating the code that evaluates flags. During this dual-run window the **source platform is the source of truth** — customers continue to edit flags there. The migration tool's job on re-migration is to make Datadog match.

When adding or changing what gets synced, classify each field into one of these tiers and follow the contract for that tier:

### Tier 1 — Full sync (replace, including deletes)

The source platform owns these end-to-end. On re-migration, make Datadog match exactly — add what's new, update what changed, delete what's gone.

- Targeting rules / allocations (PUT-replace per environment)
- Tags (PUT-replace; empty array clears all tags)
- Default variant (per environment)
- Environment enablement
- **Variants** (POST/PUT/DELETE via the `/feature-flags/{id}/variants` sub-resource)

When introducing a new field in this tier: a missing value in the source must propagate as a removal in Datadog, not as a no-op.

### Tier 2 — Additive merge

Datadog-side state may exist that the source system doesn't know about, and clobbering it would be surprising. Merge: union with what's on Datadog, dedupe, preserve unrelated bindings.

- **Restriction policies**: editor-team principals derived from RBAC walk are merged into existing editor bindings; non-editor bindings (e.g., viewer) are preserved.
- **Saved filters** for LD segments / Eppo audiences: PUT-replace the body (`name`, `targeting_rules`, `description`, `migration_metadata`) of every matched filter so source-side edits propagate, but saved filters outside the current re-migration's selection are preserved. Deletes are intentionally out of scope — a saved filter can be referenced by flags outside the current selection, so deleting one would orphan those references.

When introducing a new field in this tier: GET current state, compute union with source-derived state, PUT/POST merged result.

### Tier 3 — Never sync

Identifiers and anchors that downstream Datadog references depend on. Changing them silently has high blast radius (dashboards, alerts, links, allocations).

- Flag `key` (primary identifier)
- Flag `id` (UUID, immutable)
- Variant UUID (allocations reference variants by ID)

Renames in the source platform do not propagate. Customers must delete + recreate if they truly need a different key.

## When adding a new sync field

1. Decide which tier it belongs to. Default to Tier 1 unless there's a concrete reason to merge or preserve.
2. Wire it into **both** `src/eppo/index.ts` and `src/launchdarkly/index.ts` re-migration paths — they have identical structure.
3. Each path has two sub-branches: `envsToEnable.length === 0` (no new envs to enable, sync metadata only) and `envsToEnable.length > 0` (full re-sync). Cover both.
4. Each branch has a `dryRun` and a live mode. Cover both.
5. Mirror the existing `migration_metadata` pattern when creating new Datadog resources, with `provider: 'launchdarkly' | 'eppo'` plus a source identifier.
6. Update the spinner success message to include counts for the new field.

## When the backend gains new capabilities

Saved-filter deletes are intentionally out of scope (a saved filter can be referenced by flags outside the current re-migration's selection — deleting one orphans those references). When a new backend API ships:

1. Check whether it changes the tier of an existing field. If a Tier 3 field becomes updatable, promote to Tier 1.
2. Audit the dual-run divergence implication — what state does the new API let us reconcile that we couldn't before?
3. Wire it through both sources, both branches, both dry-run and live paths, with tests.

## Sync ordering invariants

Datadog allocations reference variants by **UUID**, not by key. That makes
variants write-after-references: any reordering that lets an allocation
reference a removed variant causes either a server-side delete rejection or a
dangling reference.

Two rules follow:

1. **Variant deletes run last.** In `syncVariants`, creates and updates fire
   before deletes. When a caller has its own allocation rewrites to interleave,
   it should call `syncVariantsCreatesAndUpdates` first, then
   `syncAllocationsForEnvironment`, then `applyVariantDeletes` — in that order.
2. **Variant key is immutable; UUID is the contract.** A source-side rename
   changes the slugified key but the matching DD variant's `key` stays put;
   only `name`, `value`, and `migration_metadata` move. `planVariantSync`
   matches on `migration_metadata.source_id` first (survives renames), then
   falls back to key (for legacy variants migrated before `source_id` was
   recorded).

The `envsToEnable.length === 0` re-migration sub-branch does **not** rewrite
allocations, so it must **skip variant deletes** entirely — a delete there
would orphan UUID references that no code path is going to clean up. Tags and
restriction policy still sync; variants only get creates and updates.

## When adding a new source provider

A new provider integration needs to translate around the constraints below.
Copying the source shape directly will produce evaluations that diverge from
the source even when migration reports success.

### Targeting on the subject's identity uses `id`, not `key`

Datadog's UFC evaluator only aliases the literal attribute name `"id"` to the
subject's `targeting_key`. Any condition emitted with `attribute: "key"` is
looked up in the attribute bag verbatim, finds nothing for SDK callers who pass
their identity via `targeting_key`, and fails to match — sending the subject
silently down the fallthrough.

Translate any source-side identity reference (LD individual `targets`,
user-kind `contextTargets`, rule clauses on `key`, equivalent Eppo / future
provider constructs) to `attribute: "id"` for user-kind contexts. For non-user
contexts, dot-notate the kind (see below). The `targetKeyAttribute` helper in
`src/launchdarkly/migration.ts` is the canonical implementation.

### Multi-context targeting uses dot notation

Datadog has no multi-context type — there is one flat attribute bag per
evaluation. LD's per-kind context attributes (and any analogous construct in a
new provider) must be flattened to dot-prefixed attribute names on emit
(`ld_application.versionName`, `device.os`, etc.). The evaluation tool mirrors
this on the read side: synthetic test cases for non-user kinds attach
`${kind}.key` to the attribute bag rather than expecting Datadog to understand
a separate context object.

### JSON variants cannot be top-level arrays

Datadog's variant-value schema rejects top-level JSON arrays. When the source
provider allows a variant whose value is `[...]`, wrap it as `{ "value": [...] }`
during migration (and unwrap symmetrically anywhere the migration tool needs to
compare against the source). Top-level objects, scalars, and null are accepted
as-is; only the array case needs the wrapper.

## Required verification

Per `CLAUDE.md`: `yarn typecheck && yarn lint:fix && yarn test` must pass before claiming a change complete. Do not skip.
