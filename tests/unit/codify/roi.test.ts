import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../../src/config/defaults.js";
import { admitCodify, forwardRoiHolds, rankScore, type AdmissionInput } from "../../../src/codify/roi.js";
import { clusterExecutions } from "../../../src/codify/miner.js";
import { cleanLanded, versionBumpExecution } from "../../helpers/codify-cluster.js";
import type { Cluster, LandedRecord } from "../../../src/codify/types.js";

function input(over: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    cfg: { ...DEFAULTS.operator.codify, repos: ["acme/widgets"] },
    repo: "acme/widgets",
    committedLayer3: true,
    dailySpendUsd: 0,
    dailyBudgetUsd: DEFAULTS.operator.dailyBudgetUsd,
    idleLanes: 2,
    maxLanes: DEFAULTS.operator.maxLanes,
    codifyRunsToday: 0,
    candidatesThisRun: 0,
    window: {
      n: 10,
      medianStageCostUsd: 3,
      horizonDays: 30,
      windowDays: 30,
      estimatedLaneCostUsd: 6,
    },
    breaker: { spend60d: 0, savedUsd60d: 0 },
    ...over,
  };
}

describe("admitCodify", () => {
  it("admits a default opted-in repo with idle lanes and passing ROI", () => {
    expect(admitCodify(input())).toEqual({ ok: true });
  });

  it("table: each refusal reason", () => {
    const rows: Array<[string, Partial<AdmissionInput>]> = [
      ["disabled", { cfg: { ...DEFAULTS.operator.codify, enabled: false, repos: ["acme/widgets"] } }],
      ["repo-not-opted-in", { cfg: { ...DEFAULTS.operator.codify, repos: [] } }],
      ["no-layer3", { committedLayer3: false }],
      ["reserve", { dailySpendUsd: DEFAULTS.operator.dailyBudgetUsd - DEFAULTS.operator.codify.reserveUsd + 1 }],
      ["idle-lanes", { idleLanes: 0 }],
      ["max-per-day", { codifyRunsToday: DEFAULTS.operator.codify.maxPerDay }],
      ["max-candidates", { candidatesThisRun: DEFAULTS.operator.codify.maxCandidatesPerRun }],
      ["forward-roi", { window: { n: 2, medianStageCostUsd: 3, horizonDays: 30, windowDays: 30, estimatedLaneCostUsd: 6 } }],
      ["breaker", { breaker: { spend60d: 31, savedUsd60d: 15 } }],
    ];
    for (const [reason, over] of rows) {
      expect(admitCodify(input(over)), reason).toEqual({ ok: false, reason });
    }
  });

  it("codify.repos: [] is repo-not-opted-in even when enabled", () => {
    expect(DEFAULTS.operator.codify.enabled).toBe(true);
    expect(DEFAULTS.operator.codify.repos).toEqual([]);
    expect(admitCodify(input({ cfg: { ...DEFAULTS.operator.codify } }))).toEqual({
      ok: false,
      reason: "repo-not-opted-in",
    });
  });

  it("seeds with bypassRoiAndRecurrence still fail disabled/not-opted-in/no-layer3/reserve/idle/maxPerDay", () => {
    const bypass = { bypassRoiAndRecurrence: true as const };
    expect(admitCodify(input({ ...bypass, cfg: { ...DEFAULTS.operator.codify, enabled: false, repos: ["acme/widgets"] } }))).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(admitCodify(input({ ...bypass, cfg: { ...DEFAULTS.operator.codify, repos: [] } }))).toEqual({
      ok: false,
      reason: "repo-not-opted-in",
    });
    expect(admitCodify(input({ ...bypass, committedLayer3: false }))).toEqual({ ok: false, reason: "no-layer3" });
    expect(admitCodify(input({ ...bypass, dailySpendUsd: 140 }))).toEqual({ ok: false, reason: "reserve" });
    expect(admitCodify(input({ ...bypass, idleLanes: 0 }))).toEqual({ ok: false, reason: "idle-lanes" });
    expect(admitCodify(input({ ...bypass, codifyRunsToday: 3 }))).toEqual({ ok: false, reason: "max-per-day" });
    expect(admitCodify(input({
      ...bypass,
      candidatesThisRun: 2,
      window: { n: 2, medianStageCostUsd: 3, horizonDays: 30, windowDays: 30, estimatedLaneCostUsd: 6 },
      breaker: { spend60d: 31, savedUsd60d: 15 },
    }))).toEqual({ ok: true });
  });
});

describe("forwardRoiHolds", () => {
  const windowBase = { medianStageCostUsd: 3, horizonDays: 30, windowDays: 30, estimatedLaneCostUsd: 6 };

  it("N=2, horizon=window, median=3, laneCost=6, forwardRoi=3 fails; N=10 passes", () => {
    expect(forwardRoiHolds({ ...windowBase, n: 2 }, 3)).toBe(false);
    expect(forwardRoiHolds({ ...windowBase, n: 10 }, 3)).toBe(true);
    expect(DEFAULTS.operator.codify.forwardRoi).toBe(3);
  });
});

describe("rankScore", () => {
  function clusterWith(landed: LandedRecord[]): Cluster {
    const execs = landed.map((l, i) =>
      versionBumpExecution({
        runId: l.runId,
        landed: l,
        features: {
          reproducibleByCommand: 1,
          diffIsSubstitution: 1,
          literalsSourced: 1,
          zeroFixRounds: 1,
          lowModelEffort: 0,
          planImperative: 0,
          small: 0,
        },
        title: `Bump widgets to 1.2.${i}`,
      }),
    );
    return clusterExecutions(execs)[0]!;
  }

  it("awards +N for surviving clean landings and −N for human-modified", () => {
    const surviving = clusterWith([
      cleanLanded("r1"),
      cleanLanded("r2"),
    ]);
    const modified = clusterWith([
      cleanLanded("r1", { landedAs: "human-modified" }),
      cleanLanded("r2", { landedAs: "human-modified" }),
    ]);
    expect(rankScore(surviving)).toBe(surviving.preScore + 2);
    expect(rankScore(modified)).toBe(modified.preScore - 2);
    expect(rankScore(surviving)).toBeGreaterThan(rankScore(modified));
  });
});
