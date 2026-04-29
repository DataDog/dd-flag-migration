# RBAC-Based Team Tagging for LaunchDarkly Migration

**Date:** 2026-04-29
**Branch:** greg.huels/FFL-2170/access-controls
**Jira:** FFL-2170

## Summary

Replace the current maintainer-based team tagging with RBAC-based team tagging. Instead of deriving `team:` tags from a flag's `maintainerId` / `maintainerTeamKey` (which represent ownership, not access), discover which teams have **edit access** to the LD project via custom roles and tag all migrated flags with those teams. The Datadog backend uses `team:` tags to grant editor access, so this ensures the right teams can edit their flags post-migration.

## Approach

**Project-level RBAC evaluation (Approach A).** All flags in a project receive the same set of team tags based on which teams have project-level edit access. Flag-level policy evaluation was rejected as overly complex for minimal real-world benefit.

## New LD API Functions (`api.ts`)

### `fetchCustomRoles(apiKey): Promise<LDCustomRole[]>`

- `GET /api/v2/roles` (paginated)
- Returns all custom roles with their policy statements
- On 403: warn and return empty array (Enterprise-only API)

### `fetchTeamsWithRoles(apiKey): Promise<LDTeamWithRoles[]>`

- `GET /api/v2/teams?expand=roles` (paginated)
- First attempt: no explicit API version header
- If roles come back empty/missing on all teams: retry with `LD-API-Version: 20220603` header
- On 403: warn and return empty array

### New Types (`types.ts`)

```ts
interface LDPolicyStatement {
  effect: 'allow' | 'deny';
  actions?: string[];
  notActions?: string[];
  resources?: string[];
  notResources?: string[];
}

interface LDCustomRole {
  key: string;
  name: string;
  policy: LDPolicyStatement[];
}

interface LDTeamWithRoles {
  key: string;
  name: string;
  roles: Array<{ key: string }>;
}
```

## Policy Evaluation (`migration.ts`)

### `findProjectEditorRoleKeys(roles, projectKey): Set<string>`

Identifies which custom roles grant edit access to the given project.

**Edit actions:** `updateFlagVariations`, `createFlag`, `updateFlag`

A role is an "editor" if any of its policy statements satisfies:
- `effect: 'allow'`
- `actions` contains at least one edit action, or `actions: ['*']`
- `resources` matches the project via patterns like:
  - `proj/<projectKey>:*`
  - `proj/<projectKey>:env/*:flag/*`
  - `proj/*:*` (wildcard all projects)
- OR `notResources` is used and the project is NOT excluded

Returns a `Set<string>` of role keys.

### `findTeamsWithEditAccess(teams, editorRoleKeys): Set<string>`

For each team, checks if any of its assigned role keys are in the editor role set. Returns a `Set<string>` of team keys.

## Simplified `buildFlagTags` (`migration.ts`)

```ts
function buildFlagTags(
  flag: LDFlag,
  projectEditorTeamKeys: Set<string>,
  teamKeyMapping?: Map<string, string>,
): string[] {
  const teamTags = [...projectEditorTeamKeys].map(key => {
    const mapped = teamKeyMapping?.get(key) ?? key;
    return `team:${mapped}`;
  });
  return [...teamTags, ...flag.tags];
}
```

All flags in the project get the same team tags. Per-flag maintainer logic is removed.

## Orchestration Changes (`index.ts`)

In `executeMigration`, after fetching flag details:

1. Spinner: "Fetching custom roles..." -> `fetchCustomRoles(ldApiKey)`
   - On 403: warn "Custom Roles API not available -- team tags will be skipped", proceed with empty team set
2. Spinner: "Fetching teams with role assignments..." -> `fetchTeamsWithRoles(ldApiKey)`
   - On 403 or empty roles: warn, proceed with empty team set
3. `findProjectEditorRoleKeys(roles, projectKey)` -> editor role keys
4. `findTeamsWithEditAccess(teams, editorRoleKeys)` -> `projectEditorTeamKeys`

The existing team key mismatch prompt and `promptForTeamMapping` flow operate on `projectEditorTeamKeys` instead of the old maintainer-derived keys. The interactive mapping UX is unchanged.

`buildFlagTags` calls change from:
```ts
buildFlagTags(flag, memberTeamCache, teamKeyMapping)
```
to:
```ts
buildFlagTags(flag, projectEditorTeamKeys, teamKeyMapping)
```

## Cleanup (Removals)

### `api.ts`
- `fetchMember`
- `buildMemberTeamCache`
- `ForbiddenError` class

### `types.ts`
- `LDMemberSummary`
- `LDMember`
- `LDTeamSummary`
- `LDMaintainerTeam`

### `LDFlag` type
- `maintainerId`
- `_maintainer`
- `maintainerTeamKey`
- `_maintainerTeam`

### `migration.ts`
- `collectLDTeamKeys`
- `buildTeamTags` (logic absorbed into simplified `buildFlagTags`)

## Fallback Behavior

| Scenario | Behavior |
|---|---|
| Custom Roles API returns 403 | Warn user, skip team tagging entirely |
| Teams API returns 403 | Warn user, skip team tagging entirely |
| `expand=roles` returns empty | Retry with `LD-API-Version: 20220603`, if still empty warn and skip |
| No roles grant edit access to project | No team tags applied (flags can be tagged manually in DD) |

## Tests

### Remove
- All `buildTeamTags` tests
- All `collectLDTeamKeys` tests
- All `buildMemberTeamCache` tests
- `memberTeamCache` / `teamKeyMapping` references from `migrate-flag.test.ts`

### Add
- `findProjectEditorRoleKeys`: exact project match, wildcard project, `notResources`, deny overrides allow, `*` actions, no matching actions
- `findTeamsWithEditAccess`: teams with/without matching roles, empty inputs
- Updated `buildFlagTags`: project-level team tags + LD source tags, with/without mapping
- `fetchTeamsWithRoles`: fallback to older API version when roles missing
- `fetchCustomRoles`: 403 handling
