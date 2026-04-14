import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { SafetyConfig, ModelRouting } from "./types.js";

const DEFAULT_SAFETY: SafetyConfig = {
  hardBlockers: { enabled: true, alwaysOn: true },
  planMode: { defaultOn: true },
  classification: {
    mode: "default-deny",
    safeAllowlistExtend: [],
    destructiveOverride: [],
  },
  approvalAuthority: "judge",
  exemptPaths: ["./tmp/**", "./.pi/engteam/runs/**"],
  tokenTtlSeconds: 300,
  allowRunLifetimeScope: true,
};

const DEFAULT_MODEL_ROUTING: ModelRouting = {
  overrides: {},
  budgetDownshift: {
    enabled: true,
    triggerAtPercent: 75,
    rules: {
      "claude-opus-4-6": "claude-sonnet-4-6",
      "claude-sonnet-4-6": "claude-haiku-4-5-20251001",
    },
    protected: ["judge", "architect"],
  },
};

async function loadJson<T>(path: string, defaults: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return { ...defaults, ...JSON.parse(raw) } as T;
  } catch {
    return defaults;
  }
}

const engteamDir = () => join(homedir(), ".pi", "engteam");

export async function loadSafetyConfig(): Promise<SafetyConfig> {
  return loadJson(join(engteamDir(), "safety.json"), DEFAULT_SAFETY);
}

export async function loadModelRouting(): Promise<ModelRouting> {
  return loadJson(join(engteamDir(), "model-routing.json"), DEFAULT_MODEL_ROUTING);
}
