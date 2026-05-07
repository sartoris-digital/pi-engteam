import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export type ProviderQuota = {
  provider: string;
  account?: string;
  rpmCeiling: number;
  tpmCeiling: number;
  windowMs: number;
};

export type RateLimitConfig = {
  enabled: boolean;
  maxConcurrent: number;
  providers: ProviderQuota[];
  warnThresholdPct: number;
  pauseThresholdPct: number;
};

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  enabled: false,
  maxConcurrent: 4,
  providers: [],
  warnThresholdPct: 80,
  pauseThresholdPct: 95,
};

async function loadJson<T>(path: string, defaults: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return { ...defaults, ...JSON.parse(raw) } as T;
  } catch {
    return defaults;
  }
}

const engineeringTeamDir = () => join(homedir(), ".pi", "engineering-team");

export async function loadRateLimitConfig(): Promise<RateLimitConfig> {
  return loadJson(join(engineeringTeamDir(), "rate-limits.json"), DEFAULT_RATE_LIMIT_CONFIG);
}
