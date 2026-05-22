// Phase A configuration — env-var-driven feature flags + capability
// gate mode. Read ONCE at process boot via `getPhaseAConfig()`; the
// result is cached so child callers see a stable view of the rollout
// state. Mutating the env after first call has no effect.
import type { CapabilityMode } from "./capability-matrix.js";

export type PhaseAConfig = {
  // Round 6 HIGH #2 + round 11 MED #1: the "real" kill switch.
  // When set to "2.0.x", every behavior-changing Phase A item is
  // disabled; the runtime matches a 2.0.x install byte-for-byte
  // except for the always-on rollout-telemetry exception
  // (PLAN E16 — not yet implemented; legacy_mode currently
  // simply turns off Phase A items).
  legacyMode: boolean;

  // Round 4 LOW + round 6 MED #1 + round 8 MED #1 + round 9 HIGH #1:
  // capability gate mode. Default `warn` for the 2.1.0 release;
  // flips to `enforce` only after per-cohort soak.
  capabilityMode: CapabilityMode;

  // Round 3 MED #4 + round 10 MED #2: feature flags. Each defaults to
  // OFF in the 2.1.0 release; ramped via cohort-based controller.
  // Until item 24's full rollout controller exists, env vars drive
  // these directly so operators can opt in per feature.
  verdictSlotHostOwned: boolean;
  acceptPredicates: boolean;
  forcedRetriesEnabled: boolean;
  forcedRetryBudget: number;
  telemetryEnabled: boolean;
  expandedStateProtection: boolean;

  // Round 13 MED #1: granular kill switches (subset).
  noNewWrites: boolean;
};

const DEFAULT_PHASE_A_CONFIG: PhaseAConfig = {
  legacyMode: false,
  capabilityMode: "warn",
  // Per-feature defaults OFF in 2.1.0; ramp by env var or cohort
  // controller. Round 8 HIGH #1 — no behavior changes default-on
  // before a representative canary.
  verdictSlotHostOwned: false,
  acceptPredicates: false,
  forcedRetriesEnabled: true,
  forcedRetryBudget: 1,
  telemetryEnabled: false,
  expandedStateProtection: true,
  noNewWrites: false,
};

let cached: PhaseAConfig | undefined;

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

function parseCapabilityMode(v: string | undefined, fallback: CapabilityMode): CapabilityMode {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "observe" || s === "warn" || s === "enforce") return s as CapabilityMode;
  return fallback;
}

function parseNum(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return fallback;
}

/**
 * Resolve the Phase A configuration from environment variables.
 * Cached after first call. Pass `force: true` to re-read (only used
 * by tests).
 */
export function getPhaseAConfig(opts?: { force?: boolean }): PhaseAConfig {
  if (cached && !opts?.force) return cached;

  const legacyEnv = process.env.PI_ENGINEERING_LEGACY_MODE;
  const legacy = legacyEnv === "2.0.x" || legacyEnv === "true" || legacyEnv === "1";

  if (legacy) {
    // Legacy mode bypasses every Phase A behavior. The
    // rollout-telemetry exception from PLAN E16 lives at a
    // different layer and is not affected by this flag.
    cached = {
      ...DEFAULT_PHASE_A_CONFIG,
      legacyMode: true,
      capabilityMode: "observe",
      verdictSlotHostOwned: false,
      acceptPredicates: false,
      forcedRetriesEnabled: false,
      forcedRetryBudget: 0,
      telemetryEnabled: false,
      expandedStateProtection: false,
    };
    return cached;
  }

  cached = {
    legacyMode: false,
    capabilityMode: parseCapabilityMode(process.env.PI_ENGINEERING_CAPABILITY_MODE, DEFAULT_PHASE_A_CONFIG.capabilityMode),
    verdictSlotHostOwned: parseBool(process.env.PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED, DEFAULT_PHASE_A_CONFIG.verdictSlotHostOwned),
    acceptPredicates: parseBool(process.env.PI_ENGINEERING_ACCEPT_PREDICATES, DEFAULT_PHASE_A_CONFIG.acceptPredicates),
    forcedRetriesEnabled: parseBool(process.env.PI_ENGINEERING_FORCED_RETRIES, DEFAULT_PHASE_A_CONFIG.forcedRetriesEnabled),
    forcedRetryBudget: parseNum(process.env.PI_ENGINEERING_FORCED_RETRY_BUDGET, DEFAULT_PHASE_A_CONFIG.forcedRetryBudget),
    telemetryEnabled: parseBool(process.env.PI_ENGINEERING_TELEMETRY, DEFAULT_PHASE_A_CONFIG.telemetryEnabled),
    expandedStateProtection: parseBool(process.env.PI_ENGINEERING_EXPANDED_STATE_PROTECTION, DEFAULT_PHASE_A_CONFIG.expandedStateProtection),
    noNewWrites: parseBool(process.env.PI_ENGINEERING_EMERGENCY_NO_NEW_WRITES, DEFAULT_PHASE_A_CONFIG.noNewWrites),
  };
  return cached;
}

/** Test-only: reset the cache so the next `getPhaseAConfig()` re-reads env. */
export function resetPhaseAConfigCache(): void {
  cached = undefined;
}
