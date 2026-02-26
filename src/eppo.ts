import axios from 'axios';
import type { EppoFlag, EppoFlagEnvironment } from './types.js';

const EPPO_BASE_URL = 'https://eppo.cloud';

type EppoFlagsResponse = EppoFlag[] | { data: EppoFlag[]; total: number };

export async function fetchEppoFlags(apiKey: string): Promise<EppoFlag[]> {
  const response = await axios.get<EppoFlagsResponse>(
    `${EPPO_BASE_URL}/api/v1/feature-flags`,
    {
      headers: {
        'x-eppo-token': apiKey,
        'Content-Type': 'application/json',
      },
      params: { limit: -1, include_detailed_allocations: true },
    }
  );

  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && 'data' in data && Array.isArray(data.data)) return data.data;
  return [];
}

export function extractEnvironments(flags: EppoFlag[]): EppoFlagEnvironment[] {
  const seen = new Map<number, EppoFlagEnvironment>();
  for (const flag of flags) {
    for (const env of flag.environments ?? []) {
      if (!seen.has(env.id)) seen.set(env.id, env);
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.is_production !== b.is_production) return a.is_production ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function validateEppoApiKey(apiKey: string): Promise<boolean> {
  try {
    await fetchEppoFlags(apiKey);
    return true;
  } catch {
    return false;
  }
}
