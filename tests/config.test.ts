import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

let tempHome: string;

function configFilePath(): string {
	return path.join(tempHome, '.dd-flag-migration', 'config.json');
}

beforeEach(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-flag-config-'));
	jest.resetModules();
});

afterEach(() => {
	jest.resetModules();
	fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('config', () => {
	it('drops legacy credential fields when saving the Datadog site', async () => {
		const configFile = configFilePath();
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				datadogSite: 'datadoghq.com',
				datadogApiKey: 'old-api-key',
				datadogAppKey: 'old-app-key',
				datadogClientToken: 'old-client-token',
				eppoApiKey: 'old-eppo-api-key',
				eppoSdkKeys: { production: 'old-eppo-sdk-key' },
				launchdarklyApiKey: 'old-ld-api-key',
				launchdarklySDKKeys: { production: 'old-ld-sdk-key' },
			}),
		);

		jest.unstable_mockModule('node:os', () => ({
			default: { homedir: () => tempHome },
			homedir: () => tempHome,
		}));

		const { getDatadogSite, saveDatadogSite } = await import(
			'../src/config.js'
		);

		expect(getDatadogSite()).toBe('datadoghq.com');

		saveDatadogSite('datadoghq.eu');

		const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(saved).toEqual({ datadogSite: 'datadoghq.eu' });
	});
});
