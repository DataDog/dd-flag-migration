# RBAC-Based Team Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace maintainer-based team tagging with RBAC-based project-level team discovery so migrated flags get `team:` tags for teams with edit access.

**Architecture:** Fetch LD custom roles and teams-with-roles at migration time. Filter roles whose policies grant edit actions on the selected project. Cross-reference with team role assignments. Apply resulting team keys as `team:` tags to all migrated flags.

**Tech Stack:** TypeScript, axios, Jest, axios-mock-adapter

**Spec:** `docs/superpowers/specs/2026-04-29-rbac-team-tagging-design.md`

---

### Task 1: Add new RBAC types to `types.ts`

**Files:**
- Modify: `src/launchdarkly/types.ts`

- [ ] **Step 1: Add the new type definitions**

Add at the end of `src/launchdarkly/types.ts`, before the migration file section:

```ts
// ─── LaunchDarkly RBAC Types ────────────────────────────────────────────────

export interface LDPolicyStatement {
	effect: 'allow' | 'deny';
	actions?: string[];
	notActions?: string[];
	resources?: string[];
	notResources?: string[];
}

export interface LDCustomRole {
	key: string;
	name: string;
	policy: LDPolicyStatement[];
}

export interface LDTeamWithRoles {
	key: string;
	name: string;
	roles: Array<{ key: string }>;
}
```

- [ ] **Step 2: Remove old maintainer types**

Remove from `src/launchdarkly/types.ts`:
- `LDMemberSummary` interface (lines 83-89)
- `LDMaintainerTeam` interface (lines 91-94)
- `LDTeamSummary` interface (lines 96-99)
- `LDMember` interface (lines 101-105)

- [ ] **Step 3: Remove maintainer fields from LDFlag**

In the `LDFlag` interface, remove these four fields:
- `maintainerId?: string;`
- `_maintainer?: LDMemberSummary;`
- `maintainerTeamKey?: string;`
- `_maintainerTeam?: LDMaintainerTeam;`

- [ ] **Step 4: Run typecheck to see expected failures**

Run: `yarn typecheck`
Expected: Compilation errors in `api.ts`, `migration.ts`, `index.ts`, and test files referencing removed types and fields. This is expected — we'll fix them in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add src/launchdarkly/types.ts
git commit -m "refactor: replace maintainer types with RBAC types in LD types"
```

---

### Task 2: Add `fetchCustomRoles` and `fetchTeamsWithRoles` to `api.ts`

**Files:**
- Modify: `src/launchdarkly/api.ts`
- Test: `tests/launchdarkly/api.test.ts`

- [ ] **Step 1: Write failing tests for `fetchCustomRoles`**

Add to `tests/launchdarkly/api.test.ts`. Update the imports at the top to include `fetchCustomRoles`:

```ts
import {
	createLDClient,
	fetchCustomRoles,
	fetchFlag,
	fetchFlags,
	fetchProjectEnvironments,
	fetchProjects,
	ldClient,
	validateLDApiKey,
} from '../../src/launchdarkly/api.js';
```

Remove these imports that will no longer exist:
- `buildMemberTeamCache`
- `ForbiddenError`
- `fetchMember`

Add the test block:

```ts
// ─── fetchCustomRoles ────────────────────────────────────────────────────────

describe('fetchCustomRoles', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns custom roles with policy statements', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/roles').reply(200, {
			items: [
				{
					key: 'editor',
					name: 'Editor',
					policy: [
						{
							effect: 'allow',
							actions: ['updateFlagVariations'],
							resources: ['proj/my-project:env/*:flag/*'],
						},
					],
				},
			],
		});

		const roles = await fetchCustomRoles(API_KEY);
		expect(roles).toEqual([
			{
				key: 'editor',
				name: 'Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		]);
	});

	it('returns empty array on 403', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/roles').reply(403);

		const roles = await fetchCustomRoles(API_KEY);
		expect(roles).toEqual([]);
	});

	it('propagates non-403 errors', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/roles').reply(500);

		await expect(fetchCustomRoles(API_KEY)).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test -- --testPathPattern=api.test`
Expected: FAIL — `fetchCustomRoles` is not exported

- [ ] **Step 3: Implement `fetchCustomRoles`**

In `src/launchdarkly/api.ts`, add the import for the new type at the top:

```ts
import type { LDCustomRole, LDEnvironment, LDFlag } from './types.js';
```

(Remove `LDMember` from the import.)

Add the function:

```ts
// ─── Custom Roles ────────────────────────────────────────────────────────────

/**
 * Fetch all custom roles from the LaunchDarkly API.
 * Returns empty array on 403 (Enterprise-only feature).
 */
export async function fetchCustomRoles(
	apiKey: string,
): Promise<LDCustomRole[]> {
	try {
		const response = await ldClient.get<{ items: LDCustomRole[] }>(
			`${LD_BASE_URL}/api/v2/roles`,
			{ headers: ldHeaders(apiKey) },
		);
		return response.data.items ?? [];
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			return [];
		}
		throw err;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test -- --testPathPattern=api.test`
Expected: `fetchCustomRoles` tests PASS. (Other tests may still fail due to removed types — that's OK.)

- [ ] **Step 5: Write failing tests for `fetchTeamsWithRoles`**

Add the import `fetchTeamsWithRoles` to the test file's import block. Then add:

```ts
// ─── fetchTeamsWithRoles ─────────────────────────────────────────────────────

describe('fetchTeamsWithRoles', () => {
	let mock: AxiosMockAdapter;

	beforeEach(() => {
		mock = new AxiosMockAdapter(ldClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns teams with their assigned roles', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/teams').reply(200, {
			items: [
				{
					key: 'platform',
					name: 'Platform',
					roles: { items: [{ key: 'editor' }] },
				},
			],
			totalCount: 1,
		});

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
		]);
	});

	it('paginates through multiple pages', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			key: `team-${i}`,
			name: `Team ${i}`,
			roles: { items: [{ key: 'editor' }] },
		}));
		const page2 = [
			{
				key: 'team-100',
				name: 'Team 100',
				roles: { items: [{ key: 'viewer' }] },
			},
		];

		mock
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, { items: page1, totalCount: 101 })
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, { items: page2, totalCount: 101 });

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toHaveLength(101);
	});

	it('retries with older API version when roles are missing', async () => {
		// First call: roles missing (empty items on all teams)
		mock
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [
					{ key: 'platform', name: 'Platform', roles: { items: [] } },
				],
				totalCount: 1,
			})
			// Second call with older API version: roles present
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [
					{
						key: 'platform',
						name: 'Platform',
						roles: { items: [{ key: 'editor' }] },
					},
				],
				totalCount: 1,
			});

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
		]);
	});

	it('returns empty array on 403', async () => {
		mock.onGet('https://app.launchdarkly.com/api/v2/teams').reply(403);

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([]);
	});

	it('returns teams with empty roles when retry also has no roles', async () => {
		mock
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [
					{ key: 'platform', name: 'Platform', roles: { items: [] } },
				],
				totalCount: 1,
			})
			.onGet('https://app.launchdarkly.com/api/v2/teams')
			.replyOnce(200, {
				items: [
					{ key: 'platform', name: 'Platform', roles: { items: [] } },
				],
				totalCount: 1,
			});

		const teams = await fetchTeamsWithRoles(API_KEY);
		expect(teams).toEqual([
			{ key: 'platform', name: 'Platform', roles: [] },
		]);
	});
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `yarn test -- --testPathPattern=api.test`
Expected: FAIL — `fetchTeamsWithRoles` is not exported

- [ ] **Step 7: Implement `fetchTeamsWithRoles`**

Add the import for the new type:

```ts
import type { LDCustomRole, LDEnvironment, LDFlag, LDTeamWithRoles } from './types.js';
```

Add the function:

```ts
// ─── Teams with Roles ────────────────────────────────────────────────────────

interface LDTeamsResponse {
	items: Array<{
		key: string;
		name: string;
		roles?: { items: Array<{ key: string }> };
	}>;
	totalCount: number;
}

function parseTeams(data: LDTeamsResponse): LDTeamWithRoles[] {
	return (data.items ?? []).map((t) => ({
		key: t.key,
		name: t.name,
		roles: t.roles?.items ?? [],
	}));
}

/**
 * Fetch all teams with their assigned custom roles from the LaunchDarkly API.
 * Uses expand=roles to include role assignments. If roles come back empty on
 * all teams, retries with an older API version header (LD-API-Version: 20220603)
 * since expand=roles was removed in version 20240415.
 * Returns empty array on 403 (Enterprise-only feature).
 */
export async function fetchTeamsWithRoles(
	apiKey: string,
	apiVersion?: string,
): Promise<LDTeamWithRoles[]> {
	try {
		const teams: LDTeamWithRoles[] = [];
		let offset = 0;
		const limit = 100;

		while (true) {
			const headers: Record<string, string> = {
				...ldHeaders(apiKey),
				...(apiVersion ? { 'LD-API-Version': apiVersion } : {}),
			};

			const response = await ldClient.get<LDTeamsResponse>(
				`${LD_BASE_URL}/api/v2/teams`,
				{
					headers,
					params: { expand: 'roles', limit, offset },
				},
			);

			teams.push(...parseTeams(response.data));
			offset += (response.data.items ?? []).length;
			if (
				(response.data.items ?? []).length < limit ||
				offset >= response.data.totalCount
			) {
				break;
			}
		}

		// If no team has any roles and we haven't tried the older API version,
		// retry with the pre-20240415 version where expand=roles was supported.
		if (
			!apiVersion &&
			teams.length > 0 &&
			teams.every((t) => t.roles.length === 0)
		) {
			return fetchTeamsWithRoles(apiKey, '20220603');
		}

		return teams;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 403) {
			return [];
		}
		throw err;
	}
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `yarn test -- --testPathPattern=api.test`
Expected: `fetchTeamsWithRoles` tests PASS

- [ ] **Step 9: Remove old member/cache code from `api.ts`**

Remove from `src/launchdarkly/api.ts`:
- `ForbiddenError` class
- `fetchMember` function
- `buildMemberTeamCache` function

- [ ] **Step 10: Remove old member/cache tests from `api.test.ts`**

Remove from `tests/launchdarkly/api.test.ts`:
- The `makeFlagForCache` helper function
- The entire `describe('fetchMember', ...)` block
- The entire `describe('buildMemberTeamCache', ...)` block
- Remove unused `LDFlag` type import if no longer needed

- [ ] **Step 11: Run tests to verify api tests pass**

Run: `yarn test -- --testPathPattern=api.test`
Expected: All tests PASS

- [ ] **Step 12: Commit**

```bash
git add src/launchdarkly/api.ts src/launchdarkly/types.ts tests/launchdarkly/api.test.ts
git commit -m "feat: add fetchCustomRoles and fetchTeamsWithRoles, remove member APIs"
```

---

### Task 3: Add policy evaluation functions to `migration.ts`

**Files:**
- Modify: `src/launchdarkly/migration.ts`
- Test: `tests/launchdarkly/migration.test.ts`

- [ ] **Step 1: Write failing tests for `findProjectEditorRoleKeys`**

In `tests/launchdarkly/migration.test.ts`, update imports to add the new functions and remove the old ones:

```ts
import {
	buildAllocations,
	buildFlagTags,
	buildTargetingRules,
	buildVariants,
	findProjectEditorRoleKeys,
	findTeamsWithEditAccess,
	getEnvsToEnable,
	mapFlagType,
	mapOperator,
	shouldSkipFlag,
} from '../../src/launchdarkly/migration.js';
```

Remove `buildTeamTags` and `collectLDTeamKeys` from the imports.

Add the import for the new type:

```ts
import type { LDClause, LDCustomRole, LDFlag, LDTeamWithRoles } from '../../src/launchdarkly/types.js';
```

Add the test block (at the end, replacing the old `buildTeamTags` and `collectLDTeamKeys` tests):

```ts
// ─── findProjectEditorRoleKeys ───────────────────────────────────────────────

describe('findProjectEditorRoleKeys', () => {
	it('matches role with exact project resource', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'editor',
				name: 'Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys).toEqual(new Set(['editor']));
	});

	it('matches role with wildcard project resource', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'super-editor',
				name: 'Super Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['createFlag'],
						resources: ['proj/*:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'any-project');
		expect(keys).toEqual(new Set(['super-editor']));
	});

	it('matches role with proj/key:* shorthand resource', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'proj-admin',
				name: 'Project Admin',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlag'],
						resources: ['proj/my-project:*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys).toEqual(new Set(['proj-admin']));
	});

	it('matches role with wildcard actions', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'admin',
				name: 'Admin',
				policy: [
					{
						effect: 'allow',
						actions: ['*'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys).toEqual(new Set(['admin']));
	});

	it('does not match role with non-edit actions only', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'viewer',
				name: 'Viewer',
				policy: [
					{
						effect: 'allow',
						actions: ['viewProject'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys.size).toBe(0);
	});

	it('does not match role targeting a different project', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'editor',
				name: 'Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/other-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys.size).toBe(0);
	});

	it('does not match deny-only statements', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'denied',
				name: 'Denied',
				policy: [
					{
						effect: 'deny',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys.size).toBe(0);
	});

	it('matches role using notResources that excludes other projects', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'broad-editor',
				name: 'Broad Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlag'],
						notResources: ['proj/secret-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys).toEqual(new Set(['broad-editor']));
	});

	it('does not match role using notResources that excludes the target project', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'broad-editor',
				name: 'Broad Editor',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlag'],
						notResources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys.size).toBe(0);
	});

	it('returns empty set for empty roles array', () => {
		const keys = findProjectEditorRoleKeys([], 'my-project');
		expect(keys.size).toBe(0);
	});

	it('matches multiple roles', () => {
		const roles: LDCustomRole[] = [
			{
				key: 'editor-a',
				name: 'Editor A',
				policy: [
					{
						effect: 'allow',
						actions: ['updateFlagVariations'],
						resources: ['proj/my-project:env/*:flag/*'],
					},
				],
			},
			{
				key: 'editor-b',
				name: 'Editor B',
				policy: [
					{
						effect: 'allow',
						actions: ['createFlag'],
						resources: ['proj/*:env/*:flag/*'],
					},
				],
			},
			{
				key: 'viewer',
				name: 'Viewer',
				policy: [
					{
						effect: 'allow',
						actions: ['viewProject'],
						resources: ['proj/my-project:*'],
					},
				],
			},
		];
		const keys = findProjectEditorRoleKeys(roles, 'my-project');
		expect(keys).toEqual(new Set(['editor-a', 'editor-b']));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test -- --testPathPattern=migration.test`
Expected: FAIL — `findProjectEditorRoleKeys` is not exported

- [ ] **Step 3: Implement `findProjectEditorRoleKeys`**

Add to `src/launchdarkly/migration.ts`:

```ts
import type {
	DatadogAllocationForFlagCreation,
	DatadogCreateFlagRequest,
	DatadogEnvironment,
	DatadogTargetingRule,
} from '../types.js';
import type { LDClause, LDCustomRole, LDFlag, LDRollout, LDTeamWithRoles } from './types.js';
```

Add the function in a new section after the Tag Building section:

```ts
// ─── RBAC Team Discovery ─────────────────────────────────────────────────────

const EDIT_ACTIONS = new Set([
	'updateFlagVariations',
	'createFlag',
	'updateFlag',
]);

/** Check if a resource pattern matches the given project key. */
function resourceMatchesProject(resource: string, projectKey: string): boolean {
	// Extract the project segment from patterns like "proj/<key>:..."
	const match = resource.match(/^proj\/([^:;]+)/);
	if (!match) return false;
	const projPattern = match[1];
	return projPattern === '*' || projPattern === projectKey;
}

/**
 * Find custom role keys that grant edit access to flags in the given project.
 * A role is an "editor" if it has at least one allow statement with an edit
 * action targeting the project's resource path.
 */
export function findProjectEditorRoleKeys(
	roles: LDCustomRole[],
	projectKey: string,
): Set<string> {
	const editorKeys = new Set<string>();

	for (const role of roles) {
		for (const statement of role.policy) {
			if (statement.effect !== 'allow') continue;

			// Check actions
			const actions = statement.actions ?? [];
			const hasEditAction =
				actions.includes('*') ||
				actions.some((a) => EDIT_ACTIONS.has(a));
			if (!hasEditAction) continue;

			// Check resources
			if (statement.resources) {
				const matchesProject = statement.resources.some((r) =>
					resourceMatchesProject(r, projectKey),
				);
				if (matchesProject) {
					editorKeys.add(role.key);
					break;
				}
			}

			// Check notResources — if present, grant access unless the project is excluded
			if (statement.notResources) {
				const isExcluded = statement.notResources.some((r) =>
					resourceMatchesProject(r, projectKey),
				);
				if (!isExcluded) {
					editorKeys.add(role.key);
					break;
				}
			}
		}
	}

	return editorKeys;
}
```

- [ ] **Step 4: Run tests to verify `findProjectEditorRoleKeys` tests pass**

Run: `yarn test -- --testPathPattern=migration.test`
Expected: `findProjectEditorRoleKeys` tests PASS (other tests may still have import issues — that's OK)

- [ ] **Step 5: Write failing tests for `findTeamsWithEditAccess`**

Add to `tests/launchdarkly/migration.test.ts`:

```ts
// ─── findTeamsWithEditAccess ─────────────────────────────────────────────────

describe('findTeamsWithEditAccess', () => {
	it('returns teams that have an editor role', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
			{ key: 'frontend', name: 'Frontend', roles: [{ key: 'viewer' }] },
		];
		const editorRoleKeys = new Set(['editor']);
		const result = findTeamsWithEditAccess(teams, editorRoleKeys);
		expect(result).toEqual(new Set(['platform']));
	});

	it('returns teams with any matching role', () => {
		const teams: LDTeamWithRoles[] = [
			{
				key: 'platform',
				name: 'Platform',
				roles: [{ key: 'viewer' }, { key: 'proj-admin' }],
			},
		];
		const editorRoleKeys = new Set(['proj-admin']);
		const result = findTeamsWithEditAccess(teams, editorRoleKeys);
		expect(result).toEqual(new Set(['platform']));
	});

	it('returns empty set when no teams have editor roles', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [{ key: 'viewer' }] },
		];
		const editorRoleKeys = new Set(['editor']);
		const result = findTeamsWithEditAccess(teams, editorRoleKeys);
		expect(result.size).toBe(0);
	});

	it('returns empty set for empty inputs', () => {
		const result = findTeamsWithEditAccess([], new Set());
		expect(result.size).toBe(0);
	});

	it('returns multiple teams when both have editor roles', () => {
		const teams: LDTeamWithRoles[] = [
			{ key: 'platform', name: 'Platform', roles: [{ key: 'editor' }] },
			{ key: 'backend', name: 'Backend', roles: [{ key: 'editor' }] },
			{ key: 'design', name: 'Design', roles: [{ key: 'viewer' }] },
		];
		const editorRoleKeys = new Set(['editor']);
		const result = findTeamsWithEditAccess(teams, editorRoleKeys);
		expect(result).toEqual(new Set(['platform', 'backend']));
	});
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `yarn test -- --testPathPattern=migration.test`
Expected: FAIL — `findTeamsWithEditAccess` is not exported

- [ ] **Step 7: Implement `findTeamsWithEditAccess`**

Add to `src/launchdarkly/migration.ts` in the RBAC Team Discovery section:

```ts
/**
 * Find team keys that have at least one of the given editor role keys assigned.
 */
export function findTeamsWithEditAccess(
	teams: LDTeamWithRoles[],
	editorRoleKeys: Set<string>,
): Set<string> {
	const teamKeys = new Set<string>();
	for (const team of teams) {
		if (team.roles.some((r) => editorRoleKeys.has(r.key))) {
			teamKeys.add(team.key);
		}
	}
	return teamKeys;
}
```

- [ ] **Step 8: Run tests to verify both new function tests pass**

Run: `yarn test -- --testPathPattern=migration.test`
Expected: `findProjectEditorRoleKeys` and `findTeamsWithEditAccess` tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/launchdarkly/migration.ts tests/launchdarkly/migration.test.ts
git commit -m "feat: add findProjectEditorRoleKeys and findTeamsWithEditAccess"
```

---

### Task 4: Rewrite `buildFlagTags` and remove old team tag functions

**Files:**
- Modify: `src/launchdarkly/migration.ts`
- Modify: `tests/launchdarkly/migration.test.ts`

- [ ] **Step 1: Remove old test blocks**

In `tests/launchdarkly/migration.test.ts`, remove these entire `describe` blocks:
- `describe('buildTeamTags', ...)`
- `describe('buildFlagTags', ...)`
- `describe('collectLDTeamKeys', ...)`
- `describe('buildTeamTags with teamKeyMapping', ...)`

- [ ] **Step 2: Write new `buildFlagTags` tests**

Add to `tests/launchdarkly/migration.test.ts`:

```ts
// ─── buildFlagTags ───────────────────────────────────────────────────────────

describe('buildFlagTags', () => {
	it('returns team tags for all project editor teams', () => {
		const flag = makeFlag({ key: 'f1' });
		const editorTeams = new Set(['platform', 'backend']);
		expect(buildFlagTags(flag, editorTeams)).toEqual([
			'team:platform',
			'team:backend',
		]);
	});

	it('returns only LD source tags when no editor teams', () => {
		const flag = makeFlag({ key: 'f1', tags: ['ui', 'experiment'] });
		const editorTeams = new Set<string>();
		expect(buildFlagTags(flag, editorTeams)).toEqual(['ui', 'experiment']);
	});

	it('returns team tags first then LD source tags', () => {
		const flag = makeFlag({ key: 'f1', tags: ['ui'] });
		const editorTeams = new Set(['platform']);
		expect(buildFlagTags(flag, editorTeams)).toEqual([
			'team:platform',
			'ui',
		]);
	});

	it('returns empty array when neither editor teams nor LD tags exist', () => {
		const flag = makeFlag({ key: 'f1' });
		const editorTeams = new Set<string>();
		expect(buildFlagTags(flag, editorTeams)).toEqual([]);
	});

	it('applies teamKeyMapping to translate team keys to DD handles', () => {
		const flag = makeFlag({ key: 'f1', tags: ['ui'] });
		const editorTeams = new Set(['ld-platform']);
		const mapping = new Map([['ld-platform', 'dd-platform-eng']]);
		expect(buildFlagTags(flag, editorTeams, mapping)).toEqual([
			'team:dd-platform-eng',
			'ui',
		]);
	});

	it('passes through unmapped team keys unchanged', () => {
		const flag = makeFlag({ key: 'f1' });
		const editorTeams = new Set(['platform']);
		const mapping = new Map([['other-team', 'mapped-team']]);
		expect(buildFlagTags(flag, editorTeams, mapping)).toEqual([
			'team:platform',
		]);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test -- --testPathPattern=migration.test`
Expected: FAIL — `buildFlagTags` signature doesn't match (still expects old params)

- [ ] **Step 4: Rewrite `buildFlagTags` and remove old functions**

In `src/launchdarkly/migration.ts`:

Remove the entire "Tag Building" section containing:
- `collectLDTeamKeys` function
- `buildTeamTags` function
- The old `buildFlagTags` function

Replace with:

```ts
// ─── Tag Building ────────────────────────────────────────────────────────────

/**
 * Build the full tags array for a Datadog flag.
 * Combines team tags (derived from project-level RBAC) with the flag's LD source tags.
 * Applies teamKeyMapping to translate LD team keys → DD team handles when provided.
 */
export function buildFlagTags(
	flag: LDFlag,
	projectEditorTeamKeys: Set<string>,
	teamKeyMapping?: Map<string, string>,
): string[] {
	const teamTags = [...projectEditorTeamKeys].map((key) => {
		const mapped = teamKeyMapping?.get(key) ?? key;
		return `team:${mapped}`;
	});
	return [...teamTags, ...flag.tags];
}
```

- [ ] **Step 5: Run tests to verify all migration tests pass**

Run: `yarn test -- --testPathPattern=migration.test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/launchdarkly/migration.ts tests/launchdarkly/migration.test.ts
git commit -m "refactor: rewrite buildFlagTags for RBAC, remove maintainer-based tag functions"
```

---

### Task 5: Update `migrate-flag.test.ts` for new `buildFlagTags` signature

**Files:**
- Modify: `tests/launchdarkly/migrate-flag.test.ts`

- [ ] **Step 1: Update imports**

In `tests/launchdarkly/migrate-flag.test.ts`, the imports of `buildFlagTags` should already work since it's still exported. No import changes needed.

- [ ] **Step 2: Update the `migrateFlag` helper function**

Replace the `tagOptions` parameter and `buildFlagTags` call in the `migrateFlag` helper (around line 64-95):

```ts
function migrateFlag(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
	selectedEnvs: string[],
	tagOptions?: {
		projectEditorTeamKeys?: Set<string>;
		teamKeyMapping?: Map<string, string>;
	},
): {
	skipped: boolean;
	skipReason?: string;
	warn?: string;
	request?: DatadogCreateFlagRequest;
	envsToEnable: DatadogEnvironment[];
} {
	const skipResult = shouldSkipFlag(flag, selectedEnvs);
	if (skipResult.skip) {
		return {
			skipped: true,
			skipReason: skipResult.reason,
			envsToEnable: [],
		};
	}

	const variants = buildVariants(flag);
	const allocations = buildAllocations(flag, envMapping);
	const envsToEnable = getEnvsToEnable(flag, envMapping);
	const tags = buildFlagTags(
		flag,
		tagOptions?.projectEditorTeamKeys ?? new Set(),
		tagOptions?.teamKeyMapping,
	);

	const request: DatadogCreateFlagRequest = {
		key: flag.key,
		name: flag.name,
		value_type: mapFlagType(flag),
		variants,
		allocations: allocations.length > 0 ? allocations : undefined,
		...(tags.length > 0 ? { tags } : {}),
	};

	return {
		skipped: false,
		warn: skipResult.warn,
		request,
		envsToEnable,
	};
}
```

- [ ] **Step 3: Update the `migrateFlagWithConflicts` helper function**

Replace the `tagOptions` parameter and `buildFlagTags` call in the `migrateFlagWithConflicts` helper (around line 1088-1182):

```ts
function migrateFlagWithConflicts(
	flag: LDFlag,
	envMapping: Map<string, DatadogEnvironment>,
	selectedEnvs: string[],
	datadogFlags: DatadogFlagEntry[],
	projectKey: string,
	conflictResolution?: ConflictResolution,
	tagOptions?: {
		projectEditorTeamKeys?: Set<string>;
		teamKeyMapping?: Map<string, string>;
	},
): {
	action: 'create' | 'sync' | 'skip';
	skipReason?: string;
	request?: DatadogCreateFlagRequest;
	existingFlagId?: string;
	envsToEnable: DatadogEnvironment[];
} {
	const skipResult = shouldSkipFlag(flag, selectedEnvs);
	if (skipResult.skip) {
		return {
			action: 'skip',
			skipReason: skipResult.reason,
			envsToEnable: [],
		};
	}

	const variants = buildVariants(flag);
	const allocations = buildAllocations(flag, envMapping);
	const envsToEnable = getEnvsToEnable(flag, envMapping);
	const conflict = classifyConflict(datadogFlags, projectKey, flag.key);

	if (conflict.type === 'cross_project') {
		if (!conflictResolution || conflictResolution.action === 'skip') {
			return {
				action: 'skip',
				skipReason:
					'Key conflict: flag key already exists in Datadog from a different LaunchDarkly project',
				envsToEnable: [],
			};
		}
	}

	const existingFlagId =
		conflict.type === 'same_project' || conflict.type === 'manual'
			? conflict.existingFlag?.id
			: undefined;

	if (existingFlagId) {
		return {
			action: 'sync',
			existingFlagId,
			envsToEnable,
		};
	}

	const usePrefix =
		conflict.type === 'cross_project' &&
		conflictResolution?.action === 'prefix';
	const ddKey = usePrefix
		? `${conflictResolution.prefix}-${flag.key}`
		: flag.key;

	const metadata: MigrationMetadata = {
		project_key: projectKey,
		flag_key: flag.key,
		...(usePrefix ? { key_prefix: conflictResolution.prefix } : {}),
	};

	const tags = buildFlagTags(
		flag,
		tagOptions?.projectEditorTeamKeys ?? new Set(),
		tagOptions?.teamKeyMapping,
	);

	const request: DatadogCreateFlagRequest = {
		key: ddKey,
		name: flag.name,
		value_type: mapFlagType(flag),
		variants,
		allocations: allocations.length > 0 ? allocations : undefined,
		migration_metadata: metadata,
		...(tags.length > 0 ? { tags } : {}),
	};

	return {
		action: 'create',
		request,
		envsToEnable,
	};
}
```

- [ ] **Step 4: Update all test call sites**

Search for `memberTeamCache` in the test file and replace all occurrences. The changes follow this pattern:

Replace:
```ts
{ memberTeamCache: someCache }
```
With:
```ts
{ projectEditorTeamKeys: new Set(['team-key']) }
```

Replace:
```ts
{ memberTeamCache: emptyCache }
```
or
```ts
{ memberTeamCache: new Map() }
```
With:
```ts
{ projectEditorTeamKeys: new Set() }
```

Replace:
```ts
teamKeyMapping: mapping,
```
With (keep the same):
```ts
teamKeyMapping: mapping,
```

The specific test blocks to update are the team tagging tests (search for `memberTeamCache` in the file). For each one, replace the cache-based approach with the new `projectEditorTeamKeys` set. The team keys that were previously in the cache values or `maintainerTeamKey` field should now be in the `projectEditorTeamKeys` set.

- [ ] **Step 5: Remove `maintainerId` and `maintainerTeamKey` from test flag fixtures**

Search through the test file for any flag objects that set `maintainerId`, `_maintainer`, `maintainerTeamKey`, or `_maintainerTeam` and remove those fields, since they no longer exist on `LDFlag`.

- [ ] **Step 6: Run tests to verify all migrate-flag tests pass**

Run: `yarn test -- --testPathPattern=migrate-flag.test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add tests/launchdarkly/migrate-flag.test.ts
git commit -m "test: update migrate-flag tests for RBAC-based team tagging"
```

---

### Task 6: Update orchestration in `index.ts`

**Files:**
- Modify: `src/launchdarkly/index.ts`

- [ ] **Step 1: Update imports**

In `src/launchdarkly/index.ts`, update the imports:

From `./api.js`, replace:
```ts
import {
	buildMemberTeamCache,
	fetchFlag,
	fetchFlagRelease,
	fetchFlags,
	fetchProjectEnvironments,
	fetchProjects,
	isReleaseInProgress,
	type LDProject,
	validateLDApiKey,
} from './api.js';
```
With:
```ts
import {
	fetchCustomRoles,
	fetchFlag,
	fetchFlagRelease,
	fetchFlags,
	fetchProjectEnvironments,
	fetchProjects,
	fetchTeamsWithRoles,
	isReleaseInProgress,
	type LDProject,
	validateLDApiKey,
} from './api.js';
```

From `./migration.js`, replace:
```ts
import {
	buildAllocations,
	buildFlagTags,
	buildVariants,
	collectLDTeamKeys,
	getEnvsToEnable,
	mapFlagType,
	shouldSkipFlag,
} from './migration.js';
```
With:
```ts
import {
	buildAllocations,
	buildFlagTags,
	buildVariants,
	findProjectEditorRoleKeys,
	findTeamsWithEditAccess,
	getEnvsToEnable,
	mapFlagType,
	shouldSkipFlag,
} from './migration.js';
```

- [ ] **Step 2: Replace the member team cache block with RBAC discovery**

In the `executeMigration` function, find the block that starts with:
```ts
// Build member→teams cache for tag generation
const cacheSpinner = ora('Resolving team memberships…').start();
```

Replace everything from that comment through the end of the team key mismatch prompt (up to the `if (dryRun)` line) with:

```ts
	// Discover teams with edit access via RBAC
	let projectEditorTeamKeys = new Set<string>();

	const roleSpinner = ora('Fetching custom roles…').start();
	try {
		const [customRoles, teamsWithRoles] = await Promise.all([
			fetchCustomRoles(ldApiKey),
			fetchTeamsWithRoles(ldApiKey),
		]);

		if (customRoles.length === 0 && teamsWithRoles.length === 0) {
			roleSpinner.warn(
				'Custom Roles API not available — team tags will be skipped (requires Enterprise plan)',
			);
		} else {
			const editorRoleKeys = findProjectEditorRoleKeys(
				customRoles,
				projectKey,
			);
			projectEditorTeamKeys = findTeamsWithEditAccess(
				teamsWithRoles,
				editorRoleKeys,
			);

			if (projectEditorTeamKeys.size > 0) {
				roleSpinner.succeed(
					`Found ${projectEditorTeamKeys.size} team(s) with edit access to project "${projectKey}"`,
				);
			} else {
				roleSpinner.warn(
					`No teams found with edit access to project "${projectKey}" — flags will not get team tags`,
				);
			}
		}
	} catch (err) {
		roleSpinner.warn(
			`Could not resolve team access: ${formatAxiosError(err)}`,
		);
	}

	// Detect LD→DD team key mismatches and prompt for interactive mapping
	let teamKeyMapping: Map<string, string> | undefined;

	if (projectEditorTeamKeys.size > 0) {
		const teamSpinner = ora('Fetching Datadog teams…').start();
		try {
			const ddTeams = await fetchDatadogTeams(ddApiKey, ddAppKey, ddSite);
			teamSpinner.succeed(`Found ${ddTeams.length} Datadog team(s)`);

			const ddHandles = new Set(ddTeams.map((t) => t.handle));
			const mismatched = [...projectEditorTeamKeys].filter(
				(k) => !ddHandles.has(k),
			);

			if (mismatched.length > 0) {
				console.log();
				console.log(
					chalk.yellow(
						`  ${mismatched.length} LD team key(s) do not match any Datadog team handle:`,
					),
				);
				for (const key of mismatched) {
					console.log(chalk.yellow(`    • ${key}`));
				}
				console.log();

				const shouldMap = await confirm({
					message:
						'Would you like to map these to Datadog team handles now?',
					default: true,
				});

				if (shouldMap) {
					teamKeyMapping = new Map<string, string>();
					for (const ldKey of mismatched) {
						const ddHandle = await promptForTeamMapping(ldKey, ddTeams);
						if (ddHandle) {
							teamKeyMapping.set(ldKey, ddHandle);
						}
					}
					if (teamKeyMapping.size > 0) {
						console.log();
						console.log(
							chalk.green(
								`  Mapped ${teamKeyMapping.size} team key(s)`,
							),
						);
					}
				}
			}
		} catch (err) {
			teamSpinner.warn(
				`Could not fetch Datadog teams: ${formatAxiosError(err)}`,
			);
		}
	}
```

- [ ] **Step 3: Update all `buildFlagTags` call sites**

In `executeMigration`, find all calls to `buildFlagTags` and update them.

Replace:
```ts
const syncTags = buildFlagTags(flag, memberTeamCache, teamKeyMapping);
```
With:
```ts
const syncTags = buildFlagTags(flag, projectEditorTeamKeys, teamKeyMapping);
```

Replace:
```ts
const tags = buildFlagTags(flag, memberTeamCache, teamKeyMapping);
```
With:
```ts
const tags = buildFlagTags(flag, projectEditorTeamKeys, teamKeyMapping);
```

There are two occurrences — one in the sync path (around line 753) and one in the create path (around line 887).

- [ ] **Step 4: Run typecheck**

Run: `yarn typecheck`
Expected: PASS — no type errors

- [ ] **Step 5: Run all tests**

Run: `yarn typecheck && yarn lint:fix && yarn test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/launchdarkly/index.ts
git commit -m "feat: wire RBAC team discovery into migration orchestration"
```

---

### Task 7: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full validation suite**

Run: `yarn typecheck && yarn lint:fix && yarn test`
Expected: All pass with no errors or warnings

- [ ] **Step 2: Verify no references to removed code remain**

Search for any remaining references to removed identifiers:

```bash
grep -r "maintainerId\|maintainerTeamKey\|_maintainer\|buildMemberTeamCache\|fetchMember\|ForbiddenError\|collectLDTeamKeys\|buildTeamTags\|memberTeamCache\|LDMemberSummary\|LDMaintainerTeam\|LDTeamSummary\|LDMember" src/ tests/ --include="*.ts" -l
```

Expected: No files found (all references cleaned up)

- [ ] **Step 3: Commit any lint fixes**

If `yarn lint:fix` made any auto-formatting changes:

```bash
git add -A && git commit -m "style: lint fixes"
```
