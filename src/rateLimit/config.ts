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

function validateConfig(parsed: unknown): RateLimitConfig {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("rate-limits.json: expected a top-level object");
  }
  const merged = { ...DEFAULT_RATE_LIMIT_CONFIG, ...(parsed as Partial<RateLimitConfig>) };
  if (!Array.isArray(merged.providers)) {
    throw new Error("rate-limits.json: 'providers' must be an array");
  }
  for (let i = 0; i < merged.providers.length; i++) {
    const p = merged.providers[i] as Partial<ProviderQuota> | undefined;
    if (!p || typeof p !== "object") {
      throw new Error(`rate-limits.json: providers[${i}] must be an object`);
    }
    if (typeof p.provider !== "string" || !p.provider) {
      throw new Error(`rate-limits.json: providers[${i}].provider must be a non-empty string`);
    }
    if (typeof p.rpmCeiling !== "number" || !Number.isFinite(p.rpmCeiling)) {
      throw new Error(`rate-limits.json: providers[${i}].rpmCeiling must be a number`);
    }
    if (typeof p.tpmCeiling !== "number" || !Number.isFinite(p.tpmCeiling)) {
      throw new Error(`rate-limits.json: providers[${i}].tpmCeiling must be a number`);
    }
    if (typeof p.windowMs !== "number" || !Number.isFinite(p.windowMs) || p.windowMs <= 0) {
      throw new Error(`rate-limits.json: providers[${i}].windowMs must be a positive number`);
    }
  }
  return merged;
}

const engineeringTeamDir = () => join(homedir(), ".pi", "engineering-team");

export async function loadRateLimitConfig(): Promise<RateLimitConfig> {
  const path = join(engineeringTeamDir(), "rate-limits.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return DEFAULT_RATE_LIMIT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[pi-engineering] rate-limits.json: invalid JSON: ${(err as Error).message}. Falling back to defaults.`);
    return DEFAULT_RATE_LIMIT_CONFIG;
  }
  try {
    return validateConfig(parsed);
  } catch (err) {
    console.warn(`[pi-engineering] ${(err as Error).message}. Falling back to defaults.`);
    return DEFAULT_RATE_LIMIT_CONFIG;
  }
}
