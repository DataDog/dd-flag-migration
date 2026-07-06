import fs from 'node:fs';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import AxiosMockAdapter from 'axios-mock-adapter';
import { ddClient } from '../src/datadog.js';
import { eppoClient } from '../src/eppo/api.js';
import { runEppoMigration } from '../src/eppo/index.js';
import type { EppoFlag } from '../src/eppo/types.js';
import { ldClient } from '../src/launchdarkly/api.js';
import { runLaunchDarklyMigration } from '../src/launchdarkly/index.js';
import type { LDFlag } from '../src/launchdarkly/types.js';

const DD_SITE = 'test.invalid';
const DD_BASE = `https://api.${DD_SITE}`;
const EPPO_BASE = 'https://eppo.cloud';
const LD_BASE = 'https://app.launchdarkly.com';

function ddEnvironment(id: string, name: string, isProduction = false) {
	return {
		id,
		type: 'feature-flag-environments',
		attributes: {
			name,
			is_production: isProduction,
			queries: [name.toLowerCase()],
			require_feature_flag_approval: false,
		},
	};
}

function ddFlagDetail(variants: unknown[] = []) {
	return {
		data: {
			id: 'dd-flag-1',
			type: 'feature-flags',
			attributes: {
				variants,
				feature_flag_environments: [],
			},
		},
	};
}

function parseLastJsonOutput(writes: string[]): {
	success: boolean;
	summary: {
		created: number;
		synced: number;
		skipped: number;
		errored: number;
	};
	failures: Array<{ key: string; error: string }>;
} {
	for (let i = writes.length - 1; i >= 0; i--) {
		const trimmed = writes[i].trimStart();
		if (trimmed.startsWith('{') && trimmed.includes('"summary"')) {
			return JSON.parse(writes[i]);
		}
	}
	throw new Error('No JSON output was written');
}

function eppoFlag(): EppoFlag {
	return {
		id: 1,
		key: 'flag-with-bad-variant',
		name: 'Flag With Bad Variant',
		variation_type: 'BOOLEAN',
		tag_names: [],
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		variations: [
			{ id: 10, name: 'On', variant_key: 'on' },
			{ id: 20, name: 'Off', variant_key: 'off' },
		],
		environments: [
			{ id: 100, name: 'Production', active: false, is_production: true },
		],
		allocations: [],
	};
}

function ldFlag(): LDFlag {
	return {
		name: 'Flag With Bad Variant',
		kind: 'boolean',
		key: 'flag-with-bad-variant',
		variations: [
			{ _id: 'var-on', value: true, name: 'On' },
			{ _id: 'var-off', value: false, name: 'Off' },
		],
		defaults: { onVariation: 0, offVariation: 1 },
		environments: {
			production: {
				on: false,
				archived: false,
				targets: [],
				contextTargets: [],
				rules: [],
				fallthrough: { variation: 1 },
				offVariation: 1,
				prerequisites: [],
				_environmentName: 'Production',
			},
		},
		tags: [],
		archived: false,
		deprecated: false,
		temporary: false,
	};
}

describe('flag-level migration failures', () => {
	let ddMock: AxiosMockAdapter;
	let eppoMock: AxiosMockAdapter;
	let ldMock: AxiosMockAdapter;
	let stdoutWrites: string[];

	beforeEach(() => {
		ddMock = new AxiosMockAdapter(ddClient as never);
		eppoMock = new AxiosMockAdapter(eppoClient as never);
		ldMock = new AxiosMockAdapter(ldClient as never);
		stdoutWrites = [];
		process.exitCode = undefined;
		process.env.EPPO_API_KEY = 'eppo-api-key';
		process.env.LAUNCHDARKLY_API_KEY = 'ld-api-key';

		jest.spyOn(process.stdout, 'write').mockImplementation(((
			chunk: unknown,
		) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as never);
		jest.spyOn(process.stderr, 'write').mockReturnValue(true as never);
		jest.spyOn(fs, 'existsSync').mockReturnValue(true);
		jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
	});

	afterEach(() => {
		ddMock.restore();
		eppoMock.restore();
		ldMock.restore();
		jest.restoreAllMocks();
		process.exitCode = undefined;
		delete process.env.EPPO_API_KEY;
		delete process.env.LAUNCHDARKLY_API_KEY;
	});

	function mockDatadogForEppoExistingFlag(): void {
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: 'flag-with-bad-variant',
						name: 'Flag With Bad Variant',
						migration_metadata: {
							provider: 'eppo',
							source_id: '1',
							source_key: 'flag-with-bad-variant',
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
	}

	function mockEppoSourceData(): void {
		eppoMock
			.onGet(`${EPPO_BASE}/api/v1/feature-flags`)
			.reply(200, [eppoFlag()]);
		eppoMock.onGet(`${EPPO_BASE}/api/v1/audiences`).reply(200, []);
	}

	it('captures Eppo live variant sync failures in the migration report', async () => {
		mockEppoSourceData();
		mockDatadogForEppoExistingFlag();
		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags/dd-flag-1/variants`)
			.reply(400, { errors: [{ detail: 'Invalid variant value' }] });

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['flag-with-bad-variant'],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: 'flag-with-bad-variant', error: 'Invalid variant value' },
		]);
		expect(process.exitCode).toBe(1);
	});

	it('captures Eppo dry-run flag failures in the dry-run report', async () => {
		mockEppoSourceData();
		mockDatadogForEppoExistingFlag();
		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(500, { errors: [{ detail: 'detail lookup failed' }] });

		await runEppoMigration('dd-api-key', 'dd-app-key', DD_SITE, true, {
			nonInteractive: {
				envMap: [['Production', 'Production']],
				flagKeys: ['flag-with-bad-variant'],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: 'flag-with-bad-variant', error: 'detail lookup failed' },
		]);
		expect(process.exitCode).toBe(1);
	});

	it('captures LaunchDarkly live variant sync failures in the migration report', async () => {
		const flag = ldFlag();
		ldMock.onGet(`${LD_BASE}/api/v2/projects`).reply(200, {
			items: [{ key: 'proj', name: 'Project' }],
			totalCount: 1,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/flags/proj/${flag.key}`).reply(200, flag);
		ldMock.onGet(`${LD_BASE}/api/v2/projects/proj`).reply(200, {
			environments: {
				items: [
					{
						key: 'production',
						name: 'Production',
						color: '417505',
						archived: false,
					},
				],
			},
		});
		ldMock.onGet(`${LD_BASE}/api/v2/roles`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ldMock.onGet(`${LD_BASE}/api/v2/teams`).reply(200, {
			items: [],
			totalCount: 0,
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags`).reply(200, {
			data: [
				{
					id: 'dd-flag-1',
					type: 'feature-flags',
					attributes: {
						key: flag.key,
						name: flag.name,
						migration_metadata: {
							project_key: 'proj',
							flag_key: flag.key,
						},
					},
				},
			],
			meta: { page: { total: 1 } },
		});
		ddMock.onGet(`${DD_BASE}/api/v2/feature-flags/environments`).reply(200, {
			data: [ddEnvironment('dd-prod', 'Production', true)],
		});
		ddMock
			.onGet(`${DD_BASE}/api/v2/feature-flags/dd-flag-1`)
			.reply(200, ddFlagDetail());
		ddMock
			.onPost(`${DD_BASE}/api/v2/feature-flags/dd-flag-1/variants`)
			.reply(400, { errors: [{ detail: 'Invalid LD variant value' }] });

		await runLaunchDarklyMigration('dd-api-key', 'dd-app-key', DD_SITE, false, {
			nonInteractive: {
				projectKey: 'proj',
				envMap: [['production', 'Production']],
				flagKeys: [flag.key],
			},
			doExport: false,
		});

		const report = parseLastJsonOutput(stdoutWrites);
		expect(report.success).toBe(false);
		expect(report.summary).toMatchObject({ created: 0, synced: 0, errored: 1 });
		expect(report.failures).toEqual([
			{ key: flag.key, error: 'Invalid LD variant value' },
		]);
		expect(process.exitCode).toBe(1);
	});
});
