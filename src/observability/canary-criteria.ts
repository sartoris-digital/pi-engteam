// Phase E item E3 — canary criteria evaluator.
//
// Reads a metric snapshot (from `MetricSnapshot`) and the rep-canary
// coverage state, evaluates the Phase B activation gates declared
// in PLAN.md item E3, and returns a structured decision:
//   - pass: criteria met, ramp can advance.
//   - fail: criteria miss, ramp blocked + reason.
//   - undecided: insufficient coverage (extends the canary window).
//
// Pure function — easy to drive from CI or from a periodic in-
// process timer that polls `CounterWal.computeTotals()` + caller-
// supplied gauges. Round 11 LOW: minimum-N denominators applied
// throughout so a quiet canary can't pass "green by construction".

export type LeafCohort = {
  provider: string;
  modelId: string;
  accountFingerprint: string;
  piVersion: string;
  runCount: number;
  successRate: number; // 0..1
  fallbackRate: number; // events per run
};

export type CanaryInput = {
  // Overall canary window stats.
  totalRuns: number;
  windowDays: number;
  // Per-leaf cohort breakdown (round 15 MED #1 — min 30/leaf).
  leafCohorts: LeafCohort[];
  // Phase B SLO metrics.
  p95ActivityLatencyMs: number;
  essentialDropTotal: number; // tool_call_invoke|result|error|verdict
  thinkingDropPerMin: number; // 99th percentile
  cpuOverheadRatio: number; // (canary - baseline) / baseline
  diskBytesP95PerRun: number;
  stuckFalsePositiveRatio: number;
  stuckResolvedTotal: number;
  phaseBAutoDisabledTotal: number;
  cohortOverflowTotal: number;
  cohortOverflowExemplarDrops: number;
  // Baseline workflow success rate for ± deltas.
  baselineWorkflowSuccessRate: number;
};

export type CriterionResult = {
  name: string;
  ok: boolean;
  reason: string;
};

export type CanaryDecision = {
  pass: boolean;
  undecided: boolean;
  criteria: CriterionResult[];
};

// Thresholds from PLAN item E3.
export const DEFAULT_THRESHOLDS = {
  minTotalRuns: 200,
  minWindowDays: 14,
  minProviderCount: 3,
  minModelsPerProvider: 2,
  minAccountsPerProvider: 2,
  minPiVersionCount: 2,
  minRunsPerLeafCohort: 30,
  maxP95ActivityLatencyMs: 250,
  maxThinkingDropPerMin: 1000,
  maxWorkflowSuccessDelta: 0.01, // ±1%
  maxCpuOverheadRatio: 0.05, // +5%
  maxDiskBytesP95PerRun: 4 * 1024 * 1024, // 4 MB
  maxStuckFalsePositiveRatio: 0.05, // 5%
  minStuckResolvedForGating: 50, // round 10 LOW
} as const;

export function evaluateCanary(input: CanaryInput, thresholds = DEFAULT_THRESHOLDS): CanaryDecision {
  const c: CriterionResult[] = [];

  // Coverage floor.
  const totalRunsOk = input.totalRuns >= thresholds.minTotalRuns;
  c.push({
    name: "coverage.totalRuns",
    ok: totalRunsOk,
    reason: `${input.totalRuns} runs vs threshold ${thresholds.minTotalRuns}`,
  });
  const windowOk = input.windowDays >= thresholds.minWindowDays;
  c.push({
    name: "coverage.windowDays",
    ok: windowOk,
    reason: `${input.windowDays}d vs threshold ${thresholds.minWindowDays}d`,
  });

  const providers = new Set(input.leafCohorts.map((l) => l.provider));
  const providerOk = providers.size >= thresholds.minProviderCount;
  c.push({
    name: "coverage.providers",
    ok: providerOk,
    reason: `${providers.size} providers vs threshold ${thresholds.minProviderCount}`,
  });

  // Per-provider model + account coverage.
  for (const p of providers) {
    const models = new Set(input.leafCohorts.filter((l) => l.provider === p).map((l) => l.modelId));
    const accounts = new Set(input.leafCohorts.filter((l) => l.provider === p).map((l) => l.accountFingerprint));
    c.push({
      name: `coverage.models[${p}]`,
      ok: models.size >= thresholds.minModelsPerProvider,
      reason: `${models.size} models for ${p}`,
    });
    c.push({
      name: `coverage.accounts[${p}]`,
      ok: accounts.size >= thresholds.minAccountsPerProvider,
      reason: `${accounts.size} accounts for ${p}`,
    });
  }

  const piVersions = new Set(input.leafCohorts.map((l) => l.piVersion));
  c.push({
    name: "coverage.piVersions",
    ok: piVersions.size >= thresholds.minPiVersionCount,
    reason: `${piVersions.size} piVersions vs threshold ${thresholds.minPiVersionCount}`,
  });

  // Per-leaf min-N (round 15 MED #1).
  const thinLeaves = input.leafCohorts.filter((l) => l.runCount < thresholds.minRunsPerLeafCohort);
  c.push({
    name: "coverage.leafMinN",
    ok: thinLeaves.length === 0,
    reason: thinLeaves.length === 0
      ? `every leaf cohort >= ${thresholds.minRunsPerLeafCohort} runs`
      : `${thinLeaves.length} leaf cohort(s) below ${thresholds.minRunsPerLeafCohort} (extend the canary)`,
  });

  // Latency.
  c.push({
    name: "perf.latency",
    ok: input.p95ActivityLatencyMs < thresholds.maxP95ActivityLatencyMs,
    reason: `p95 ${input.p95ActivityLatencyMs}ms vs max ${thresholds.maxP95ActivityLatencyMs}ms`,
  });

  // Essential drops MUST be zero.
  c.push({
    name: "perf.essentialDrops",
    ok: input.essentialDropTotal === 0,
    reason: `essential drops = ${input.essentialDropTotal}`,
  });

  // Thinking drops.
  c.push({
    name: "perf.thinkingDropRate",
    ok: input.thinkingDropPerMin < thresholds.maxThinkingDropPerMin,
    reason: `${input.thinkingDropPerMin}/min vs max ${thresholds.maxThinkingDropPerMin}/min`,
  });

  // CPU overhead.
  c.push({
    name: "perf.cpuOverhead",
    ok: input.cpuOverheadRatio < thresholds.maxCpuOverheadRatio,
    reason: `+${(input.cpuOverheadRatio * 100).toFixed(2)}% vs max +${(thresholds.maxCpuOverheadRatio * 100).toFixed(2)}%`,
  });

  // Disk per run.
  c.push({
    name: "perf.diskPerRun",
    ok: input.diskBytesP95PerRun < thresholds.maxDiskBytesP95PerRun,
    reason: `p95 ${input.diskBytesP95PerRun}B vs max ${thresholds.maxDiskBytesP95PerRun}B`,
  });

  // Per-cohort success delta — average leaf success rate vs baseline.
  const avgLeafSuccess = input.leafCohorts.length === 0
    ? 1
    : input.leafCohorts.reduce((s, l) => s + l.successRate, 0) / input.leafCohorts.length;
  const successDelta = Math.abs(avgLeafSuccess - input.baselineWorkflowSuccessRate);
  c.push({
    name: "perf.successDelta",
    ok: successDelta <= thresholds.maxWorkflowSuccessDelta,
    reason: `Δ ${(successDelta * 100).toFixed(2)}% vs max ±${(thresholds.maxWorkflowSuccessDelta * 100).toFixed(2)}%`,
  });

  // Stuck-warning false-positive — only gates when N is sufficient
  // (round 10 LOW + round 15 LOW).
  if (input.stuckResolvedTotal >= thresholds.minStuckResolvedForGating) {
    c.push({
      name: "quality.stuckFalsePositiveRatio",
      ok: input.stuckFalsePositiveRatio <= thresholds.maxStuckFalsePositiveRatio,
      reason: `${(input.stuckFalsePositiveRatio * 100).toFixed(2)}% with N=${input.stuckResolvedTotal}`,
    });
  } else {
    c.push({
      name: "quality.stuckFalsePositiveRatio",
      ok: true,
      reason: `N=${input.stuckResolvedTotal} < ${thresholds.minStuckResolvedForGating} — gate skipped (insufficient data)`,
    });
  }

  // Auto-disable + cohort overflow MUST be zero.
  c.push({
    name: "stability.phaseBAutoDisabled",
    ok: input.phaseBAutoDisabledTotal === 0,
    reason: `${input.phaseBAutoDisabledTotal} auto-disables in window`,
  });
  c.push({
    name: "stability.cohortOverflow",
    ok: input.cohortOverflowTotal === 0,
    reason: `${input.cohortOverflowTotal} overflow events`,
  });
  c.push({
    name: "stability.cohortOverflowExemplarDrops",
    ok: input.cohortOverflowExemplarDrops === 0,
    reason: `${input.cohortOverflowExemplarDrops} exemplar drops`,
  });

  const allCoverageOk = c
    .filter((x) => x.name.startsWith("coverage."))
    .every((x) => x.ok);
  const allPerfOk = c.filter((x) => !x.name.startsWith("coverage.")).every((x) => x.ok);

  if (!allCoverageOk) {
    return { pass: false, undecided: true, criteria: c };
  }
  return { pass: allPerfOk, undecided: false, criteria: c };
}
