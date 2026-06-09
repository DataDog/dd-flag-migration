import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.dd-flag-migration');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig(): Config {
	try {
		if (!fs.existsSync(CONFIG_FILE)) return {};
		const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
		return JSON.parse(raw) as Config;
	} catch {
		return {};
	}
}

function saveConfig(config: Config): void {
	if (!fs.existsSync(CONFIG_DIR)) {
		fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
}

export function getDatadogSite(): string | undefined {
	return loadConfig().datadogSite;
}

export function saveDatadogSite(site: string): void {
	const config = loadConfig();
	config.datadogSite = site;
	saveConfig(config);
}
