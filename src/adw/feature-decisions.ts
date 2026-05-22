// Phase D item 24 partial — per-run feature-decision vector.
//
// Round 10 MED #2: feature decisions are frozen per run. At run
// start the controller computes a deterministic decision vector
// from a stable cohort key (round 11 MED #2 + round 13 MED #2:
// host + account + Pi-runtime fingerprint, NOT runId) and
// persists it to `<runDir>/feature-decisions.json`. Every step of
// that run reads the SAME vector; `rollout.json` edits + auto-
// disable affect only NEW runs.
//
// `feature-decisions.json` is in the Layer-A protected list
// (Phase A item 9 + round 15 HIGH #3) so an agent cannot tamper
// with its own feature exposure.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { PhaseAConfig } from "../team/phaseA-config.js";

export type FeatureVector = {
  // The exact fields that materially affect step behavior.
  verdictSlotHostOwned: boolean;
  acceptPredicates: boolean;
  forcedRetriesEnabled: boolean;
  forcedRetryBudget: number;
  telemetryEnabled: boolean;
  expandedStateProtection: boolean;
  activityStreamEnabled: boolean;
  capabilityMode: PhaseAConfig["capabilityMode"];
};

export type FrozenDecisions = {
  schemaVersion: 1;
  runId: string;
  cohortKey: string;
  cohortHash: string;
  frozenAt: string;
  features: FeatureVector;
};

/**
 * Compute a stable cohort identifier per round 13 MED #2. Includes
 * provider + modelId + accountFingerprint + piVersion + piBuildHash
 * + hostId, so a 1% canary exposes ~1% of distinct accounts under a
 * given Pi runtime fingerprint rather than randomly touching new
 * accounts over time.
 */
export function computeCohortKey(input: {
  provider: string;
  modelId: string;
  accountFingerprint: string;
  piVersion: string;
  piBuildHash: string;
  hostId: string;
}): { key: string; hash: string } {
  const key = [
    input.provider,
    input.modelId,
    input.accountFingerprint,
    input.piVersion,
    input.piBuildHash,
    input.hostId,
  ].join("|");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return { key, hash };
}

/**
 * Snapshot the current Phase A config into a FeatureVector. In
 * Phase D v0.1 we lift the env-var-resolved values verbatim — the
 * full rollout controller (item 24) ramps these per cohort, but the
 * "frozen per run" guarantee already holds because we write the
 * snapshot to disk at run start and every step reads from there.
 */
export function snapshotFeatureVector(cfg: PhaseAConfig): FeatureVector {
  return {
    verdictSlotHostOwned: cfg.verdictSlotHostOwned,
    acceptPredicates: cfg.acceptPredicates,
    forcedRetriesEnabled: cfg.forcedRetriesEnabled,
    forcedRetryBudget: cfg.forcedRetryBudget,
    telemetryEnabled: cfg.telemetryEnabled,
    expandedStateProtection: cfg.expandedStateProtection,
    activityStreamEnabled: cfg.activityStreamEnabled,
    capabilityMode: cfg.capabilityMode,
  };
}

/**
 * Persist the frozen vector to `<runDir>/feature-decisions.json`.
 * Atomic write-temp-rename. Returns the resolved path. The file is
 * orchestrator-owned per Layer-A protection (item 9).
 */
export function writeFrozenDecisions(runDir: string, decisions: FrozenDecisions): string {
  const path = join(runDir, "feature-decisions.json");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(decisions, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/**
 * Read the frozen vector back. Returns undefined when the file is
 * missing (caller decides whether to fall back to live config or
 * fail). On schemaVersion mismatch returns undefined.
 */
export function readFrozenDecisions(runDir: string): FrozenDecisions | undefined {
  const path = join(runDir, "feature-decisions.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schemaVersion !== 1) return undefined;
    return parsed as FrozenDecisions;
  } catch {
    return undefined;
  }
}
