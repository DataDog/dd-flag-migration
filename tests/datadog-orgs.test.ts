import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../src/datadog/api.js';
import {
	assertDistinctDatadogOrgs,
	type DatadogOrgPair,
	datadogOrgPairFromValues,
	findUnsupportedOrgOverrides,
} from '../src/datadog/orgs.js';
import type { EnvVarName } from '../src/helpers/env.js';

const values = {
	SOURCE_DD_API_KEY: 'source-api',
	SOURCE_DD_APP_KEY: 'source-app',
	SOURCE_DD_SITE: 'source.example',
	TARGET_DD_API_KEY: 'target-api',
	TARGET_DD_APP_KEY: 'target-app',
	TARGET_DD_SITE: 'target.example',
} as Record<EnvVarName, string>;

function currentUser(orgId: string) {
	return {
		data: {
			id: 'user-id',
			relationships: { org: { data: { id: orgId } } },
		},
	};
}

describe('Datadog org pair credentials', () => {
	it('builds source and target connections from SOURCE_DD_* and TARGET_DD_*', () => {
		const pair = datadogOrgPairFromValues(values);
		expect(pair).toEqual({
			source: {
				role: 'source',
				apiKey: 'source-api',
				appKey: 'source-app',
				site: 'source.example',
			},
			target: {
				role: 'target',
				apiKey: 'target-api',
				appKey: 'target-app',
				site: 'target.example',
			},
		});
	});

	it('rejects overrides that would apply to both orgs', () => {
		expect(findUnsupportedOrgOverrides({})).toEqual([]);
		expect(
			findUnsupportedOrgOverrides({
				DD_BASE_URL: 'https://proxy.example',
				DD_HTTP_HEADERS: ' ',
			}),
		).toEqual(['DD_BASE_URL']);
	});
});

describe('assertDistinctDatadogOrgs', () => {
	let mock: AxiosMockAdapter;
	const pair: DatadogOrgPair = datadogOrgPairFromValues({
		...values,
		TARGET_DD_SITE: 'source.example',
	});

	beforeEach(() => {
		mock = new AxiosMockAdapter(ddClient as never);
	});

	afterEach(() => {
		mock.restore();
	});

	it('rejects identical credentials without calling the API', async () => {
		await expect(
			assertDistinctDatadogOrgs(
				datadogOrgPairFromValues({
					...values,
					TARGET_DD_API_KEY: 'source-api',
					TARGET_DD_APP_KEY: 'source-app',
					TARGET_DD_SITE: 'source.example',
				}),
			),
		).rejects.toThrow(/same Datadog org/);
		expect(mock.history.get).toHaveLength(0);
	});

	it('rejects different keys that belong to the same org', async () => {
		mock
			.onGet('https://api.source.example/api/v2/current_user')
			.reply(200, currentUser('org-1'));
		await expect(assertDistinctDatadogOrgs(pair)).rejects.toThrow(
			/same Datadog org/,
		);
	});

	it('accepts two different orgs', async () => {
		mock
			.onGet('https://api.source.example/api/v2/current_user')
			.replyOnce(200, currentUser('org-1'))
			.onGet('https://api.source.example/api/v2/current_user')
			.replyOnce(200, currentUser('org-2'));
		await expect(assertDistinctDatadogOrgs(pair)).resolves.toBeUndefined();
	});

	it('only warns when org identity cannot be confirmed', async () => {
		mock.onGet('https://api.source.example/api/v2/current_user').reply(403);
		await expect(assertDistinctDatadogOrgs(pair)).resolves.toBeUndefined();
	});
});
