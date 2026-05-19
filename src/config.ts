import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { SafetyConfig, ModelRouting } from "./types.js";
import { cloneDefaultApprovalWatcherConfig } from "./types.js";

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
  // Codex round-12 LOW: README documents default `false` (safer, no
  // reusable approval tokens by default) but the code shipped `true`,
  // so a fresh install accepted run-lifetime grants that the operator
  // never opted into. Align with the documented default; users who want
  // reusable tokens can set it in ~/.pi/engineering-team/safety.json.
  allowRunLifetimeScope: false,
  // PLAN.md round-A1+: ApprovalWatcher feature shipped DORMANT by default.
  // No watcher registers, no boot recovery, no fs changes until the
  // operator opts in via `enabled: true`. See ApprovalWatcherConfig docs.
  approvalWatcher: cloneDefaultApprovalWatcherConfig(),
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

/**
 * Strict variant of loadJson. ENOENT → defaults (fresh install).
 * Parse errors, permission errors, or other read errors → throws.
 *
 * Phase 9 review round-1 HIGH 2: the safety-config fail-closed paths
 * in SafetyGuard.findValidApproval + LearnerOrchestrator.checkApproval
 * relied on loadSafetyConfig() throwing on corruption. Without this
 * strict variant, loadJson swallowed every error and silently
 * returned DEFAULT_APPROVAL_WATCHER_CONFIG (which has pauseEpoch: 0),
 * masking real corruption + letting pre-stop tokens slip through.
 */
async function loadJsonStrict<T>(path: string, defaults: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return defaults;
    throw err;
  }
  return { ...defaults, ...JSON.parse(raw) } as T;
}

const engineeringTeamDir = () => join(homedir(), ".pi", "engineering-team");

// Phase 1 review round-1 MEDIUM 2: a partial user override of
// `approvalWatcher` that contains hostile shapes (string instead of bool,
// array instead of string array, wildcard `"*"` in canaryRunIds, etc.)
// would survive a shallow merge with truthy-but-invalid values that
// Phase 2 gates could misread. Sanitize each field per its expected type
// and reject the wildcard explicitly (PLAN.md round-A7 MEDIUM 4 requires
// `allRuns: true` for full rollout, not `canaryRunIds: ["*"]`).
function sanitizeApprovalWatcherConfig(raw: unknown): import("./types.js").ApprovalWatcherConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return cloneDefaultApprovalWatcherConfig();
  }
  const o = raw as Record<string, unknown>;
  const out: import("./types.js").ApprovalWatcherConfig = cloneDefaultApprovalWatcherConfig();

  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (o.mode === "dormant" || o.mode === "rollback") out.mode = o.mode;
  if (typeof o.dispatchPaused === "boolean") out.dispatchPaused = o.dispatchPaused;
  if (typeof o.emergencyStop === "boolean") out.emergencyStop = o.emergencyStop;
  if (typeof o.pauseEpoch === "number" && Number.isFinite(o.pauseEpoch) && o.pauseEpoch >= 0) {
    out.pauseEpoch = Math.floor(o.pauseEpoch);
  }
  if (Array.isArray(o.canaryRunIds)) {
    const ids = o.canaryRunIds.filter(
      (r): r is string => typeof r === "string" && r.length > 0 && r !== "*",
    );
    out.canaryRunIds = ids;
    if (o.canaryRunIds.some((r) => r === "*")) {
      // PLAN.md round-A7 MEDIUM 4: wildcard is rejected; operators must
      // opt into allRuns explicitly. Emit a warning at boot so the
      // operator notices the typo / misconfiguration.
      console.warn(
        "[approval-watcher] canaryRunIds contained '*' — wildcard not supported; use allRuns: true. Wildcard entries dropped.",
      );
    }
  }
  if (typeof o.allRuns === "boolean") out.allRuns = o.allRuns;
  if (
    typeof o.maxRequestAgeSeconds === "number" &&
    Number.isFinite(o.maxRequestAgeSeconds) &&
    o.maxRequestAgeSeconds > 0
  ) {
    out.maxRequestAgeSeconds = Math.floor(o.maxRequestAgeSeconds);
  }
  if (
    typeof o.maxPendingPerRun === "number" &&
    Number.isFinite(o.maxPendingPerRun) &&
    o.maxPendingPerRun > 0
  ) {
    out.maxPendingPerRun = Math.floor(o.maxPendingPerRun);
  }
  return out;
}

export async function loadSafetyConfig(): Promise<SafetyConfig> {
  const merged = await loadJson(join(engineeringTeamDir(), "safety.json"), DEFAULT_SAFETY);
  // PLAN.md round-A1+: per-field sanitize so hostile / typo'd user
  // overrides fall back to defaults instead of slipping through the
  // shallow JSON merge as truthy-but-invalid values.
  merged.approvalWatcher = sanitizeApprovalWatcherConfig(merged.approvalWatcher);
  return merged;
}

/**
 * Phase 9 review round-1 HIGH 2: strict safety-config loader for
 * approval gates. Throws on parse errors / permission errors so the
 * fail-closed catch in findValidApproval + LearnerOrchestrator is
 * actually exercised. ENOENT still returns defaults (fresh install
 * is a normal state).
 */
export async function loadSafetyConfigStrict(): Promise<SafetyConfig> {
  const merged = await loadJsonStrict(join(engineeringTeamDir(), "safety.json"), DEFAULT_SAFETY);
  merged.approvalWatcher = sanitizeApprovalWatcherConfig(merged.approvalWatcher);
  return merged;
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
