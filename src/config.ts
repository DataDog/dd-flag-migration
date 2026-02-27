import os from 'os';
import path from 'path';
import fs from 'fs';
import type { Config } from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.dd-flag-migration');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(): Config {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getEppoApiKey(): string | undefined {
  return loadConfig().eppoApiKey;
}

export function saveEppoApiKey(key: string): void {
  const config = loadConfig();
  config.eppoApiKey = key;
  saveConfig(config);
}

export function getDatadogKeys(): { apiKey?: string; appKey?: string } {
  const config = loadConfig();
  return { apiKey: config.datadogApiKey, appKey: config.datadogAppKey };
}

export function saveDatadogKeys(apiKey: string, appKey: string): void {
  const config = loadConfig();
  config.datadogApiKey = apiKey;
  config.datadogAppKey = appKey;
  saveConfig(config);
}

export function getEppoSdkKeyForEnv(envName: string): string | undefined {
  return loadConfig().eppoSdkKeys?.[envName];
}

export function saveEppoSdkKeyForEnv(envName: string, key: string): void {
  const config = loadConfig();
  config.eppoSdkKeys = { ...config.eppoSdkKeys, [envName]: key };
  saveConfig(config);
}

export function getDatadogClientToken(): string | undefined {
  return loadConfig().datadogClientToken;
}

export function saveDatadogClientToken(token: string): void {
  const config = loadConfig();
  config.datadogClientToken = token;
  saveConfig(config);
}

export function getDatadogSite(): string | undefined {
  return loadConfig().datadogSite;
}

export function saveDatadogSite(site: string): void {
  const config = loadConfig();
  config.datadogSite = site;
  saveConfig(config);
}
