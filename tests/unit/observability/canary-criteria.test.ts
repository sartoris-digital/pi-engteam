import { describe, it, expect } from "vitest";
import { evaluateCanary, DEFAULT_THRESHOLDS, type CanaryInput, type LeafCohort } from "../../../src/observability/canary-criteria.js";

function leaf(over: Partial<LeafCohort> = {}): LeafCohort {
  return {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    accountFingerprint: "acct",
    piVersion: "0.74.1",
    runCount: 50,
    successRate: 0.95,
    fallbackRate: 0.01,
    ...over,
  };
}

function goodInput(over: Partial<CanaryInput> = {}): CanaryInput {
  return {
    totalRuns: 300,
    windowDays: 14,
    p95ActivityLatencyMs: 100,
    essentialDropTotal: 0,
    thinkingDropPerMin: 100,
    cpuOverheadRatio: 0.02,
    diskBytesP95PerRun: 1_000_000,
    stuckFalsePositiveRatio: 0.02,
    stuckResolvedTotal: 100,
    phaseBAutoDisabledTotal: 0,
    cohortOverflowTotal: 0,
    cohortOverflowExemplarDrops: 0,
    baselineWorkflowSuccessRate: 0.95,
    leafCohorts: [
      leaf({ provider: "anthropic", modelId: "m1", accountFingerprint: "a1", piVersion: "0.74.1" }),
      leaf({ provider: "anthropic", modelId: "m2", accountFingerprint: "a2", piVersion: "0.75.0" }),
      leaf({ provider: "copilot", modelId: "m1", accountFingerprint: "a1", piVersion: "0.74.1" }),
      leaf({ provider: "copilot", modelId: "m2", accountFingerprint: "a2", piVersion: "0.75.0" }),
      leaf({ provider: "zenmux", modelId: "m1", accountFingerprint: "a1", piVersion: "0.74.1" }),
      leaf({ provider: "zenmux", modelId: "m2", accountFingerprint: "a2", piVersion: "0.75.0" }),
    ],
    ...over,
  };
}

describe("evaluateCanary", () => {
  it("passes when all coverage + perf criteria are met", () => {
    const r = evaluateCanary(goodInput());
    expect(r.pass).toBe(true);
    expect(r.undecided).toBe(false);
  });

  it("returns undecided when total runs are below threshold", () => {
    const r = evaluateCanary(goodInput({ totalRuns: 50 }));
    expect(r.undecided).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("returns undecided when fewer than 3 providers", () => {
    const r = evaluateCanary(goodInput({
      leafCohorts: [
        leaf({ provider: "anthropic", modelId: "m1", accountFingerprint: "a1", piVersion: "0.74.1" }),
        leaf({ provider: "anthropic", modelId: "m2", accountFingerprint: "a2", piVersion: "0.75.0" }),
      ],
    }));
    expect(r.undecided).toBe(true);
  });

  it("returns undecided when a leaf cohort is below min-N (round 15 MED #1)", () => {
    const r = evaluateCanary(goodInput({
      leafCohorts: [
        ...goodInput().leafCohorts,
        leaf({ provider: "newprov", modelId: "m", accountFingerprint: "a", piVersion: "v", runCount: 5 }),
      ],
    }));
    expect(r.undecided).toBe(true);
  });

  it("fails (not undecided) when essential drops are non-zero", () => {
    const r = evaluateCanary(goodInput({ essentialDropTotal: 3 }));
    expect(r.pass).toBe(false);
    expect(r.undecided).toBe(false);
    expect(r.criteria.find((c) => c.name === "perf.essentialDrops")!.ok).toBe(false);
  });

  it("fails when p95 latency exceeds threshold", () => {
    const r = evaluateCanary(goodInput({ p95ActivityLatencyMs: 500 }));
    expect(r.pass).toBe(false);
    expect(r.criteria.find((c) => c.name === "perf.latency")!.ok).toBe(false);
  });

  it("fails when CPU overhead exceeds 5%", () => {
    const r = evaluateCanary(goodInput({ cpuOverheadRatio: 0.10 }));
    expect(r.pass).toBe(false);
  });

  it("skips stuck-warning gate when N is below the minimum (round 15 LOW)", () => {
    const r = evaluateCanary(goodInput({
      stuckFalsePositiveRatio: 0.50, // would normally fail
      stuckResolvedTotal: 5,
    }));
    const stuck = r.criteria.find((c) => c.name === "quality.stuckFalsePositiveRatio")!;
    expect(stuck.ok).toBe(true);
    expect(stuck.reason).toMatch(/insufficient data/);
  });

  it("fails when cohort overflow is non-zero (round 11 MED #3)", () => {
    const r = evaluateCanary(goodInput({ cohortOverflowTotal: 1 }));
    expect(r.pass).toBe(false);
    expect(r.criteria.find((c) => c.name === "stability.cohortOverflow")!.ok).toBe(false);
  });

  it("default thresholds match the PLAN.md item E3 numbers", () => {
    expect(DEFAULT_THRESHOLDS.minTotalRuns).toBe(200);
    expect(DEFAULT_THRESHOLDS.minWindowDays).toBe(14);
    expect(DEFAULT_THRESHOLDS.minRunsPerLeafCohort).toBe(30);
    expect(DEFAULT_THRESHOLDS.maxP95ActivityLatencyMs).toBe(250);
    expect(DEFAULT_THRESHOLDS.maxStuckFalsePositiveRatio).toBe(0.05);
  });
});
