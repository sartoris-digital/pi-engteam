import type { CodifyConfig } from "../config/schema.js";
import type { Cluster } from "./types.js";

export interface AdmissionInput {
  cfg: CodifyConfig;
  repo: string;
  committedLayer3: boolean;
  dailySpendUsd: number;
  dailyBudgetUsd: number;
  idleLanes: number;
  maxLanes: number;
  codifyRunsToday: number;
  candidatesThisRun: number;
  window: {
    n: number;
    medianStageCostUsd: number;
    horizonDays: number;
    windowDays: number;
    estimatedLaneCostUsd: number;
  };
  breaker: { spend60d: number; savedUsd60d: number };
  bypassRoiAndRecurrence?: boolean;
}

export type AdmissionDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "disabled"
        | "repo-not-opted-in"
        | "no-layer3"
        | "reserve"
        | "idle-lanes"
        | "max-per-day"
        | "max-candidates"
        | "forward-roi"
        | "breaker";
    };

export function forwardRoiHolds(window: AdmissionInput["window"], forwardRoi: number): boolean {
  if (window.windowDays <= 0) return false;
  const projected = window.n * (window.horizonDays / window.windowDays) * window.medianStageCostUsd;
  return projected >= forwardRoi * window.estimatedLaneCostUsd;
}

export function admitCodify(input: AdmissionInput): AdmissionDecision {
  const { cfg } = input;
  if (!cfg.enabled) return { ok: false, reason: "disabled" };
  if (cfg.repos.length === 0 || !cfg.repos.includes(input.repo)) return { ok: false, reason: "repo-not-opted-in" };
  if (!input.committedLayer3) return { ok: false, reason: "no-layer3" };
  if (input.dailyBudgetUsd - input.dailySpendUsd < cfg.reserveUsd) return { ok: false, reason: "reserve" };
  if (input.idleLanes < cfg.requireIdleLanes) return { ok: false, reason: "idle-lanes" };
  if (input.codifyRunsToday >= cfg.maxPerDay) return { ok: false, reason: "max-per-day" };
  const bypass = input.bypassRoiAndRecurrence === true;
  if (!bypass && input.candidatesThisRun >= cfg.maxCandidatesPerRun) return { ok: false, reason: "max-candidates" };
  if (!bypass && !forwardRoiHolds(input.window, cfg.forwardRoi)) return { ok: false, reason: "forward-roi" };
  if (!bypass && input.breaker.spend60d > 2 * input.breaker.savedUsd60d) return { ok: false, reason: "breaker" };
  return { ok: true };
}

export function rankScore(cluster: Cluster): number {
  let score = cluster.preScore;
  for (const m of cluster.members) {
    const survival = m.survival;
    const survived =
      survival !== undefined && !survival.reverted && !survival.retouched && !survival.linkedBug;
    if (m.landedAs === "human-modified") score -= 1;
    else if (survived) score += 1;
  }
  return score;
}
