import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
	init,
	integrations,
	type LDClient,
	type LDContext,
} from '@launchdarkly/node-server-sdk';
import {
	buildLDContext,
	generateLDTestCases,
} from '../../src/launchdarkly/evaluate.js';
import type { LDClause, LDFlag } from '../../src/launchdarkly/types.js';

const cases = [
	{
		name: 'user-key',
		attribute: 'key',
		contextKind: 'user',
		matchesIdentity: true,
	},
	{
		name: 'user-reference',
		attribute: '/key',
		contextKind: 'user',
		matchesIdentity: true,
	},
	{
		name: 'org-key',
		attribute: 'key',
		contextKind: 'org',
		matchesIdentity: true,
	},
	{
		name: 'org-reference',
		attribute: '/key',
		contextKind: 'org',
		matchesIdentity: true,
	},
	{
		name: 'builtin-reference',
		attribute: '/key',
		contextKind: 'ld_device',
		matchesIdentity: true,
	},
	{
		name: 'legacy-key',
		attribute: 'key',
		contextKind: undefined,
		matchesIdentity: true,
	},
	{
		name: 'legacy-slash-key',
		attribute: '/key',
		contextKind: undefined,
		matchesIdentity: false,
	},
];

function makeFlag(key: string, clauseOverrides: Partial<LDClause>): LDFlag {
	return {
		key,
		name: key,
		kind: 'boolean',
		variations: [
			{ _id: 'v0', value: false },
			{ _id: 'v1', value: true },
		],
		defaults: { onVariation: 1, offVariation: 0 },
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
		environments: {
			test: {
				on: true,
				archived: false,
				targets: [],
				contextTargets: [],
				rules: [
					{
						_id: 'rule',
						variation: 1,
						trackEvents: false,
						clauses: [
							{
								_id: 'clause',
								attribute: 'key',
								contextKind: 'user',
								op: 'in',
								values: ['context-1'],
								negate: false,
								...clauseOverrides,
							},
						],
					},
				],
				fallthrough: { variation: 0 },
				offVariation: 0,
				prerequisites: [],
				_environmentName: 'test',
			},
		},
	};
}

// Use the real SDK's file data source: no API credentials, events, or network calls.
// Unlike migration mocks, this checks LD's modern/legacy reference interpretation.
describe('LaunchDarkly SDK identity reference semantics', () => {
	let directory: string;
	let client: LDClient;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'ld-identity-references-'));
		const flags: Record<string, unknown> = {};
		const segments: Record<string, unknown> = {};
		for (const testCase of cases) {
			const flag = makeFlag(testCase.name, {
				attribute: testCase.attribute,
				contextKind: testCase.contextKind,
			});
			const env = flag.environments?.test;
			const sdkFlag = {
				...env,
				key: flag.key,
				version: 1,
				variations: [false, true],
			};
			flags[flag.key] = sdkFlag;
			segments[flag.key] = {
				key: flag.key,
				version: 1,
				included: [],
				excluded: [],
				includedContexts: [],
				excludedContexts: [],
				rules: env?.rules,
			};
			for (const negate of [false, true]) {
				const key = `${flag.key}-segment-${negate}`;
				flags[key] = {
					...sdkFlag,
					key,
					rules: [
						{
							id: 'segment-rule',
							variation: 1,
							clauses: [
								{
									attribute: 'key',
									op: 'segmentMatch',
									values: [flag.key],
									negate,
								},
							],
						},
					],
				};
			}
		}
		const path = join(directory, 'flags.json');
		await writeFile(path, JSON.stringify({ flags, segments }));
		const source = new integrations.FileDataSourceFactory({ paths: [path] });
		client = init('offline-test-key', {
			updateProcessor: source.getFactory(),
			sendEvents: false,
			diagnosticOptOut: true,
		});
		await client.waitForInitialization({ timeout: 5 });
	}, 10000);

	afterAll(async () => {
		client?.close();
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it.each(
		cases,
	)('$name: checks real flag and segment matching against context identity', async (testCase) => {
		const context = { kind: testCase.contextKind ?? 'user', key: 'context-1' };
		for (const key of [testCase.name, `${testCase.name}-segment-false`]) {
			const result = await client.variationDetail(key, context, false);
			expect(result.reason.kind).not.toBe('ERROR');
			expect(result.value).toBe(testCase.matchesIdentity);
		}
		const inverse = await client.variationDetail(
			`${testCase.name}-segment-true`,
			context,
			false,
		);
		expect(inverse.reason.kind).not.toBe('ERROR');
		expect(inverse.value).toBe(!testCase.matchesIdentity);
	});

	it.each(
		cases,
	)('$name: generates matching and non-matching evaluation contexts', async (testCase) => {
		const flag = makeFlag(testCase.name, {
			attribute: testCase.attribute,
			contextKind: testCase.contextKind,
		});
		const generated = generateLDTestCases(flag, 'test');
		expect(generated).toHaveLength(3);
		for (const [index, tc] of generated.slice(1).entries()) {
			const subjectId = tc.subjectIdOverride ?? 'synthetic';
			const context = buildLDContext(
				subjectId,
				tc.attributes,
				tc.contextAttributes,
				tc.ldUserAttributes,
			) as LDContext;
			const result = await client.variationDetail(flag.key, context, false);
			expect(result.reason.kind).not.toBe('ERROR');
			expect(result.value).toBe(index === 0);
			if (testCase.matchesIdentity) {
				if ((testCase.contextKind ?? 'user') === 'user') {
					expect(tc.subjectIdOverride).toBeDefined();
					expect(tc.attributes).toEqual({});
				} else {
					expect(tc.attributes[`${testCase.contextKind}.key`]).toBeDefined();
					expect(
						tc.contextAttributes?.[testCase.contextKind ?? 'user']?.key,
					).toBeDefined();
				}
			} else {
				expect(tc.subjectIdOverride).toBeUndefined();
				expect((context as { key: string }).key).toBe('synthetic');
			}
		}
	});
});
