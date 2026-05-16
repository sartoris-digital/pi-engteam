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
  exemptPaths: ["./tmp/**", "./.pi/engineering-team/runs/**"],
  tokenTtlSeconds: 300,
  allowRunLifetimeScope: true,
};

const DEFAULT_MODEL_ROUTING: ModelRouting = {
  overrides: {},
  budgetDownshift: {
    enabled: true,
    triggerAtPercent: 75,
    rules: {
      "claude-opus-4.6": "claude-sonnet-4.6",
      "claude-sonnet-4.6": "claude-haiku-4.5",
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

const engineeringTeamDir = () => join(homedir(), ".pi", "engineering-team");

export async function loadSafetyConfig(): Promise<SafetyConfig> {
  return loadJson(join(engineeringTeamDir(), "safety.json"), DEFAULT_SAFETY);
}

// Codex round-5 MEDIUM: model-routing.json was shallow-merged into the
// defaults with no shape validation. A user writing
// `{"overrides":{"judge":{"unexpected":"object"}}}` would land an object
// in TeamRuntime.effectiveModel and crash modelToProvider's
// `.split("/")` call. Validate each override is `Record<agentName, string>`
// with bounded string length, and drop entries that don't conform —
// keeping the default for invalid agents rather than booting with a
// dispatch crash waiting to happen.
const MAX_MODEL_STRING = 256;
function sanitizeModelRouting(raw: ModelRouting): ModelRouting {
  const cleanOverrides: Record<string, string> = {};
  if (raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)) {
    for (const [agent, model] of Object.entries(raw.overrides)) {
      if (typeof agent !== "string" || agent.length === 0) continue;
      if (typeof model !== "string" || model.length === 0 || model.length > MAX_MODEL_STRING) {
        console.error(
          `[pi-engineering] model-routing override for '${agent}' is not a non-empty string ≤ ${MAX_MODEL_STRING} chars — dropping. Got: ${typeof model}`,
        );
        continue;
      }
      cleanOverrides[agent] = model;
    }
  }
  // budgetDownshift is structured; only touch obvious type drift.
  const bds = raw.budgetDownshift ?? DEFAULT_MODEL_ROUTING.budgetDownshift;
  const cleanBds = {
    enabled: typeof bds.enabled === "boolean" ? bds.enabled : DEFAULT_MODEL_ROUTING.budgetDownshift.enabled,
    triggerAtPercent: typeof bds.triggerAtPercent === "number" ? bds.triggerAtPercent : DEFAULT_MODEL_ROUTING.budgetDownshift.triggerAtPercent,
    rules: (bds.rules && typeof bds.rules === "object" && !Array.isArray(bds.rules))
      ? Object.fromEntries(
        Object.entries(bds.rules).filter(([k, v]) => typeof k === "string" && typeof v === "string"),
      )
      : DEFAULT_MODEL_ROUTING.budgetDownshift.rules,
    protected: Array.isArray(bds.protected) ? bds.protected.filter((s): s is string => typeof s === "string") : DEFAULT_MODEL_ROUTING.budgetDownshift.protected,
  };
  return { overrides: cleanOverrides, budgetDownshift: cleanBds };
}

export async function loadModelRouting(): Promise<ModelRouting> {
  const raw = await loadJson(join(engineeringTeamDir(), "model-routing.json"), DEFAULT_MODEL_ROUTING);
  return sanitizeModelRouting(raw);
}
