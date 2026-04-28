# Design: LaunchDarkly Segment Migration to Datadog Saved Filters

## Context

LaunchDarkly segments are reusable targeting groups that can be referenced from flag rules via the `segmentMatch` operator. Currently, the migration tool skips any flag containing a `segmentMatch` clause (1,185 clauses across the dataset). Datadog's equivalent concept is a **saved filter** — a reusable set of targeting rules that can be referenced from flag allocations.

This design adds segment migration support: LaunchDarkly segments are imported as Datadog saved filters, and flags using `segmentMatch` are migrated with saved filter references instead of being skipped.

**Jira Epic:** FFL-2028

---

## Approach: Two-Phase Migration

**Phase 1** migrates segments as saved filters (runs first, independently).
**Phase 2** migrates flags with `segmentMatch` support (existing flow, enhanced to reference saved filters).

This mirrors the natural dependency order: saved filters must exist before flags can reference them.

---

## 1. Architecture Overview

The migration flow becomes:

```
Authenticate → Select Project → Select Environments → Map Environments
→ [NEW] Migrate Segments as Saved Filters
→ Select Flags → Migrate Flags (now with segmentMatch support)
```

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `src/launchdarkly/segments.ts` | Migration tool | Segment fetching, transformation, saved filter creation |
| `src/launchdarkly/negation.ts` | Migration tool | De Morgan's negation + DNF conversion |

### Modified Components

| Component | Change |
|-----------|--------|
| `src/launchdarkly/types.ts` | New `LDSegment` type |
| `src/launchdarkly/api.ts` | New `fetchSegment()` / `fetchSegments()` |
| `src/launchdarkly/migration.ts` | Remove `segmentMatch` from unsupported ops, add `resolveSegmentMatch()`, modify `buildAllocations()` |
| `src/launchdarkly/index.ts` | Thread segment migration phase, pass lookup map to flag migration |
| `src/datadog.ts` | New `createSavedFilter()` / `listSavedFilters()` |
| `src/types.ts` | New saved filter request/response types |

### Backend Dependencies (dd-source)

| Change | File | Description |
|--------|------|-------------|
| Add `migration_metadata` JSONB column | `model/saved_filter.go` | Same pattern as `feature_flag.go` MigrationMetadata field |
| Accept `migration_metadata` in create DTO | `dto/saved_filter_dto.go` | Optional field on `CreateSavedFilterRequest` |
| Query by `migration_metadata` | `repository/saved_filter_repository.go` | Find existing saved filter by segment key for idempotency |
| Accept `saved_filter_id` on targeting rules | `dto/allocation_dto.go` | Add optional `saved_filter_id` field to `TargetingRuleRequest` |
| Wire saved filter refs to join table | `allocation_handler.go` | Write `targeting_rule_saved_filter_refs` rows when `saved_filter_id` is present |
| Public v2 endpoint for saved filters | New handler | Same shape as existing `/api/ui/ffe/saved-filters`, mounted at `/api/v2/...` |

---

## 2. Data Transformation: LD Segments to DD Saved Filters

### Shape 1: Rule-based segment (non-negated) — 1,157 occurrences

Each LD segment rule becomes one DD targeting rule (OR between rules). Each clause within a rule becomes one DD condition (AND within a rule). Direct 1:1 mapping — LD segments are already in DNF.

```
LD Segment "specialty-sprx":
  rules: [{ clauses: [{ attribute: "tenant", op: "in", values: ["specialty-sprx"], negate: false }] }]

DD Saved Filter "specialty-sprx (production)":
  creation_type: "RULES"
  targeting_rules: [{ conditions: [{ operator: "ONE_OF", attribute: "tenant", value: ["specialty-sprx"] }] }]
```

### Shape 2: Rule-based segment (negated) — 54 occurrences

Requires De Morgan's law + DNF conversion. See section 3 (Negation Engine).

**Concrete example:** A flag rule says "target users NOT in the `internal-beta` segment", where the segment has two rules:

```
LD Segment "internal-beta":
  rules: [
    {
      // Rule 1: employee on a beta plan
      clauses: [
        { attribute: "employee",    op: "in",       values: [true],       negate: false },
        { attribute: "plan",        op: "in",       values: ["beta"],     negate: false }
      ]
    },
    {
      // Rule 2: QA user on any internal org
      clauses: [
        { attribute: "role",        op: "in",       values: ["qa"],       negate: false },
        { attribute: "org_id",      op: "in",       values: ["1","2","3"],negate: false }
      ]
    }
  ]
```

The segment in DNF: `(employee=true AND plan=beta) OR (role=qa AND org_id IN [1,2,3])`

Negating that:

```
NOT( (employee=true AND plan=beta) OR (role=qa AND org_id IN [1,2,3]) )

Step 1 — De Morgan's on the outer OR:
  = NOT(employee=true AND plan=beta) AND NOT(role=qa AND org_id IN [1,2,3])

Step 2 — De Morgan's on each inner AND:
  = (employee NOT_ONE_OF [true] OR plan NOT_ONE_OF [beta])
    AND
    (role NOT_ONE_OF [qa] OR org_id NOT_ONE_OF [1,2,3])

Step 3 — Distribute (Cartesian product of the two disjunctions):
  = (employee NOT_ONE_OF [true] AND role NOT_ONE_OF [qa])
    OR (employee NOT_ONE_OF [true] AND org_id NOT_ONE_OF [1,2,3])
    OR (plan NOT_ONE_OF [beta]     AND role NOT_ONE_OF [qa])
    OR (plan NOT_ONE_OF [beta]     AND org_id NOT_ONE_OF [1,2,3])
```

This produces the DD saved filter `"NOT internal-beta (production)"` with **4 targeting rules**:

```
DD Saved Filter "NOT internal-beta (production)":
  creation_type: "RULES"
  targeting_rules: [
    { conditions: [{ operator: "NOT_ONE_OF", attribute: "employee", value: ["true"] },
                   { operator: "NOT_ONE_OF", attribute: "role",     value: ["qa"]  }] },
    { conditions: [{ operator: "NOT_ONE_OF", attribute: "employee", value: ["true"] },
                   { operator: "NOT_ONE_OF", attribute: "org_id",   value: ["1","2","3"] }] },
    { conditions: [{ operator: "NOT_ONE_OF", attribute: "plan",     value: ["beta"] },
                   { operator: "NOT_ONE_OF", attribute: "role",     value: ["qa"]  }] },
    { conditions: [{ operator: "NOT_ONE_OF", attribute: "plan",     value: ["beta"] },
                   { operator: "NOT_ONE_OF", attribute: "org_id",   value: ["1","2","3"] }] }
  ]
```

The group count formula is: `product of (clause count per rule)` = 2 × 2 = 4 groups.

### Shape 3: List-based segment (non-negated)

Large value lists in a single clause with `op: "in"` on `attribute: "key"`.

```
DD Saved Filter:
  creation_type: "LIST"
  targeting_rules: [{ conditions: [{ operator: "ONE_OF", attribute: "key", value: [...1443 IDs] }] }]
```

### Shape 4: List-based segment (negated)

```
DD Saved Filter "NOT ec-fraudulent-users (production)":
  creation_type: "LIST"
  targeting_rules: [{ conditions: [{ operator: "NOT_ONE_OF", attribute: "key", value: [...1443 IDs] }] }]
```

### Naming Convention

- Non-negated: `"{segment-name} ({env-key})"`
- Negated: `"NOT {segment-name} ({env-key})"`

### Environment Scoping

LD segments are per-environment; DD saved filters are org-scoped. One saved filter is created per segment+env combination, since rules can differ across environments.

### Included/Excluded Lists

LD segments have `included` and `excluded` arrays (user IDs directly included/excluded, separate from rules):

- **Non-negated saved filter:** `included` → extra OR group with `ONE_OF` on `key`
- **Negated saved filter:** `included` becomes `NOT_ONE_OF` (ANDed with all negated groups); `excluded` becomes an additional OR group with `ONE_OF` (users excluded from the segment are included in the negation)

---

## 3. Negation Engine (`src/launchdarkly/negation.ts`)

### Algorithm

```
Input:  DNF = Group1 OR Group2 OR ... OR GroupN
        where Groupi = Cond1 AND Cond2 AND ... AND CondM

Step 1: Negate each condition within each group (De Morgan's on inner AND)
        notGroupi = notCond1 OR notCond2 OR ... OR notCondM

Step 2: AND the negated groups together (De Morgan's on outer OR)
        notDNF = notGroup1 AND notGroup2 AND ... AND notGroupN

Step 3: Distribute to get DNF (Cartesian product)
        Result = cross product of all notGroupi disjunctions
```

### Condition Negation

Reuses the existing `mapOperator` function's negation logic:

| Original | Negated |
|----------|---------|
| `ONE_OF` | `NOT_ONE_OF` |
| `NOT_ONE_OF` | `ONE_OF` |
| `MATCHES` | `NOT_MATCHES` |
| `NOT_MATCHES` | `MATCHES` |
| `LT` | `GTE` |
| `LTE` | `GT` |
| `GT` | `LTE` |
| `GTE` | `LT` |
| `SEMVER_EQ` | `SEMVER_NEQ` |
| `SEMVER_NEQ` | `SEMVER_EQ` |
| `SEMVER_LT` | `SEMVER_GTE` |
| `SEMVER_LTE` | `SEMVER_GT` |
| `SEMVER_GT` | `SEMVER_LTE` |
| `SEMVER_GTE` | `SEMVER_LT` |

### Explosion Guard

The Cartesian product can grow exponentially. A segment with N rules of M clauses each produces M^N groups. Limit: 100 groups maximum. If exceeded, warn and skip the negated variant. In practice, most segments have 1 rule with 1-2 clauses.

### Exported Functions

```typescript
/** Negate a set of targeting rules (already in DNF) and return new DNF */
negateTargetingRules(rules: DatadogTargetingRule[]): DatadogTargetingRule[]

/** Negate a single condition */
negateCondition(condition: DatadogCondition): DatadogCondition

/** Cartesian product of arrays of targeting rule groups */
cartesianProduct(groups: DatadogCondition[][]): DatadogTargetingRule[]
```

---

## 4. Mapping segmentMatch to Saved Filter References

Saved filter references live on **targeting rules** via `targeting_rule_saved_filter_refs`. Each targeting rule can optionally reference one saved filter via `saved_filter_id`. The allocation's list of targeting rules provides the OR ordering.

### Case 1: Pure segmentMatch rule (1,124 cases)

An LD rule with only a `segmentMatch` clause becomes a targeting rule with just `saved_filter_id`, no inline conditions.

```
LD Flag rule:
  { clauses: [{ op: "segmentMatch", values: ["cvs"], negate: false }], variation: 0 }

DD Allocation targeting rule:
  { saved_filter_id: "<id of cvs saved filter>" }
```

### Case 2: Multi-segment clause (65 cases)

An LD `segmentMatch` clause with multiple values (`values: ["cvs", "specialty"]`) means OR — match segment cvs OR segment specialty. Each segment becomes its own targeting rule.

```
LD Flag rule:
  { clauses: [{ op: "segmentMatch", values: ["cvs", "specialty"], negate: false }], variation: 0 }

DD Allocation targeting rules:
  [
    { saved_filter_id: "<id of cvs saved filter>" },
    { saved_filter_id: "<id of specialty saved filter>" }
  ]
```

### Case 3: Mixed rule — segmentMatch AND other clauses (61 cases)

An LD rule with both `segmentMatch` and non-segment clauses AND'd together. The saved filter ref and inline conditions coexist on the same targeting rule.

```
LD Flag rule:
  { clauses: [
    { op: "segmentMatch", values: ["cvs"], negate: false },
    { op: "segmentMatch", values: ["mobile-web"], negate: true },
  ], variation: 0 }

DD Allocation targeting rule:
  {
    conditions: [],
    saved_filter_id: "<id of cvs saved filter>"
    // Note: the negated mobile-web reference uses the pre-negated saved filter
    // This requires two targeting rules since there are two segment refs
  }
```

When a mixed rule has multiple segmentMatch clauses (AND'd), this creates a challenge: each targeting rule can only hold one `saved_filter_id`. Since multiple segments AND'd together can't be expressed as a single targeting rule with one saved filter ref, we have two options:

1. **Inline the conditions** — resolve the segments' rules and inline them as conditions alongside the other clauses
2. **Split into nested saved filters** — combine the segments into a new composite saved filter (not supported in v1)

For the migration tool, option 1 is the pragmatic choice: when a rule AND's multiple `segmentMatch` clauses, inline the segment rules as conditions rather than referencing saved filters. This avoids the single-ref-per-rule limitation.

### Case 4: segmentMatch alongside non-segment clauses (simplest mixed case)

```
LD Flag rule:
  { clauses: [
    { op: "segmentMatch", values: ["cvs"], negate: false },
    { attribute: "version", op: "semVerGreaterThan", values: ["2.0.0"], negate: false }
  ], variation: 0 }

DD Allocation targeting rule:
  {
    saved_filter_id: "<id of cvs saved filter>",
    conditions: [{ operator: "SEMVER_GT", attribute: "version", value: ["2.0.0"] }]
  }
```

The saved filter is AND'd with the inline condition within the same targeting rule.

---

## 5. API Layer

### Migration Tool — New Functions (`src/datadog.ts`)

```typescript
/** Create a saved filter via the public v2 API */
createSavedFilter(apiKey, appKey, {
  name: string,
  description?: string,
  creation_type: "RULES" | "LIST",
  targeting_rules: DatadogTargetingRule[],
  migration_metadata?: {
    provider: "launchdarkly",
    project_key: string,
    segment_key: string,
    environment_key: string,
    negated: boolean
  }
}): Promise<{ id: string }>

/** List saved filters with optional search */
listSavedFilters(apiKey, appKey, { search?: string }): Promise<SavedFilterSummary[]>
```

### Migration Tool — Targeting Rule Changes

The existing `DatadogTargetingRule` type gains an optional `saved_filter_id` field:

```typescript
DatadogTargetingRule {
  conditions?: DatadogCondition[]    // inline conditions (AND'd together)
  saved_filter_id?: string           // NEW: reference to a saved filter (targeting_rule_saved_filter_refs)
}
```

A targeting rule can have:
- Only `conditions` — inline conditions AND'd together (existing behavior)
- Only `saved_filter_id` — the entire rule is a saved filter reference (pure segmentMatch)
- Both `conditions` AND `saved_filter_id` — inline conditions AND'd with the saved filter (mixed rule)

### Migration Tool — LD API (`src/launchdarkly/api.ts`)

```typescript
/** Fetch a single segment */
fetchSegment(apiKey, projectKey, envKey, segmentKey): Promise<LDSegment>

/** Fetch all segments for a project+env (paginated) */
fetchSegments(apiKey, projectKey, envKey): Promise<LDSegment[]>
```

---

## 6. Segment Migration Flow (`src/launchdarkly/segments.ts`)

### Step 1: Discover Needed Segments

Scan all flags across selected environments for `segmentMatch` clauses. Collect unique `(segmentKey, envKey, negated)` tuples. This avoids migrating unused segments.

### Step 2: Fetch Segments from LD API

For each `(segmentKey, envKey)`, call `GET /api/v2/segments/{projectKey}/{envKey}/{segmentKey}`. Reuse the rate-limiting pattern from `api.ts`.

### Step 3: Check for Already-Migrated Segments (Idempotency)

Query DD saved filters by `migration_metadata` to find segments already migrated. Populate the lookup map with existing saved filter IDs. Skip creation for segments that already exist.

### Step 4: Transform and Create Saved Filters

For each segment+env:

1. Map each LD rule's clauses to DD conditions using existing `mapOperator`
2. Add `included` list as an extra OR group (if non-empty)
3. Handle `excluded` list as a `NOT_ONE_OF` condition ANDed into every group
4. Determine `creation_type`: `"LIST"` if segment is purely a key-based list (single rule, single clause, `op: "in"`, `attribute: "key"`), otherwise `"RULES"`
5. If negated version is needed, run through `negateTargetingRules()` and create a second saved filter
6. Call `createSavedFilter()` with `migration_metadata`

### Step 5: Build Lookup Map

Result: `Map<string, string>` keyed by `"${segmentKey}:${envKey}:${negated}"` → `savedFilterId`. Passed to the flag migration phase.

### Console Output

```
Discovering segments referenced by flags...
  Found 47 segments across 2 environments
Fetching segments from LaunchDarkly...
  Fetched 47 segments (3 already migrated, skipped)
Creating saved filters...
  Created 41 saved filters (3 negated variants)
  2 segments skipped: unsupported operators in segment rules
```

---

## 7. Flag Migration Changes

### `migration.ts` Changes

1. **Remove `segmentMatch` from `UNSUPPORTED_OPS`.**

2. **New function `resolveSegmentMatch()`:**

```typescript
resolveSegmentMatch(
  clause: LDClause,
  envKey: string,
  savedFilterLookup: Map<string, string>
): { savedFilterIds: string[] } | { skip: string }
```

Each value in the clause's `values` array is a segment key (a single clause can reference multiple segments, 65 cases in the dataset). For each value, looks up `"${segmentKey}:${envKey}:${clause.negate}"` in the map. Returns all resolved IDs, or skips if any segment is missing from the lookup.

3. **Modified `buildAllocations()` and `buildTargetingRules()`:** When a rule contains `segmentMatch` clauses, targeting rules are built according to the cases in section 4:
   - **Pure segmentMatch, single segment** → one targeting rule with `saved_filter_id`, no conditions
   - **Pure segmentMatch, multiple segments** → multiple targeting rules, each with its own `saved_filter_id` (OR semantics)
   - **Single segmentMatch + other clauses** → one targeting rule with `saved_filter_id` AND inline conditions
   - **Multiple segmentMatch clauses AND'd together** → inline the segment rules as conditions (single `saved_filter_id` per targeting rule limitation)

4. **Modified `shouldSkipFlag()`:** No longer skips for `segmentMatch`. Skips only if the referenced segment wasn't successfully migrated (not in lookup map).

### `index.ts` Changes

- Thread the `savedFilterLookup` map from segment migration into `buildAllocations()` calls
- Update migration summary to include segment stats
- Update migration report JSON

### `types.ts` — New Types

```typescript
interface LDSegment {
  key: string
  name: string
  description?: string
  tags: string[]
  included: string[]
  excluded: string[]
  includedContexts: LDSegmentContext[]
  excludedContexts: LDSegmentContext[]
  rules: LDRule[]
  deleted: boolean
  _flags: Array<{ key: string; name: string }>
}
```

---

## 8. Error Handling & Idempotency

### Idempotency

The `migration_metadata` JSONB column on saved filters is the key. Before creating a saved filter, query for existing ones matching `{ project_key, segment_key, environment_key, negated }`.

```json
{
  "provider": "launchdarkly",
  "project_key": "digital-blocks",
  "segment_key": "specialty-sprx",
  "environment_key": "production",
  "negated": false
}
```

On re-run, already-migrated segments are skipped and their IDs are loaded into the lookup map.

### Error Categories

| Error | Behavior |
|-------|----------|
| Segment fetch fails (404) | Warn, skip segment, dependent flags also skipped |
| Segment has unsupported ops in its own rules | Warn, skip segment+dependent flags |
| Saved filter creation fails (API error) | Log error, add to failures, skip dependent flags |
| DNF explosion (>100 groups after Cartesian) | Warn, skip negated variant, dependent flags skipped |
| Saved filter already exists (idempotency) | Reuse existing ID silently |
| Segment referenced by flag but not in lookup | Skip flag with reason "segment not migrated" |
| Rate limit hit (429) | Retry with backoff (existing pattern) |

### Migration Report Additions

```typescript
segments: {
  discovered: number
  created: number
  negated: number
  skipped: number
  reused: number
  failures: Array<{ segmentKey: string; envKey: string; error: string }>
}
```

---

## 9. Testing Strategy

### Test Data

All tests use synthetic/fabricated segment data via factory helpers (`makeSegment()`, `makeSegmentRule()`, `makeSegmentClause()`). The `launchdarkly-requests/` folder contains customer data and is never committed into test fixtures. It is used only as a structural reference for a separate local-only e2e validation script.

### Unit Tests: `tests/launchdarkly/negation.test.ts` (new)

| Test Case | Input | Expected |
|-----------|-------|----------|
| Negate single condition `ONE_OF` | `ONE_OF` condition | `NOT_ONE_OF` condition |
| Negate `LT` | `LT` condition | `GTE` condition |
| Negate `MATCHES` | `MATCHES` condition | `NOT_MATCHES` condition |
| Negate single-rule single-clause | 1 group, 1 condition | 1 group, 1 negated condition |
| Negate single-rule multi-clause | 1 group, 3 conditions | 3 groups, 1 negated condition each |
| Negate multi-rule (Cartesian) | 2 groups of 2 conditions | 4 groups (2x2 product) |
| Explosion guard | 5 rules of 5 clauses (3,125 groups) | Error/skip result |
| Empty rules | No rules | Empty result |

### Unit Tests: `tests/launchdarkly/segments.test.ts` (new)

| Test Case | Description |
|-----------|-------------|
| Rule-based segment to saved filter | Transforms LD rules to DD targeting rules correctly |
| List-based segment to saved filter | Large values array, `creation_type: "LIST"` |
| Segment with `included` list | Extra OR group for included users |
| Segment with `excluded` list | `NOT_ONE_OF` condition ANDed into groups |
| Segment with rules and included | Rules OR'd with included list |
| Naming convention | Correct format for both variants |
| Migration metadata shape | Correct JSON structure |

### Unit Tests: `tests/launchdarkly/migration.test.ts` (extended)

| Test Case | Description |
|-----------|-------------|
| `segmentMatch` no longer skips | `shouldSkipFlag` returns `skip: false` |
| Pure segmentMatch rule | Targeting rule with `saved_filter_id`, no conditions |
| Multi-segment clause (`values: ["a","b"]`) | Multiple targeting rules, each with `saved_filter_id` |
| Single segmentMatch + other clauses | Targeting rule with `saved_filter_id` AND inline conditions |
| Multiple segmentMatch clauses AND'd | Inlines segment rules as conditions |
| Missing segment in lookup | Skips flag with reason |

### Local E2E Validation (not committed)

Separate script that reads from `launchdarkly-requests/` to validate transformation logic against real segment shapes. Developer-only, not part of the CI test suite.

---

## 10. Dataset Statistics

From analysis of `launchdarkly-requests/`:

- **Total segmentMatch clauses:** 1,185
- **Non-negated:** 1,157
- **Negated:** 54
- **Multi-segment values (>1 segment in one clause):** 65
- **Rules mixing segmentMatch with other clause types:** 61
- **Most common segment pattern:** Single rule, single clause, `op: "in"` on a tenant/key attribute
