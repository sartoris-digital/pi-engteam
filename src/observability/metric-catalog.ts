// Phase E item E4 — single source of truth for every metric the
// pi-engineering runtime emits. Threshold definitions (E1), canary
// gate criteria (E3), and chaos-test assertions (E7) all import
// from this module. A reference to a name not in the catalog fails
// the build (caller can use the exported `METRIC_NAMES` array to
// assert presence in CI).
//
// Naming convention: `pi_eng_<noun>_<unit_or_total>{labels}`. All
// counters carry a `_total` suffix. Cardinality budget per item E4:
// each metric's label set is bounded — no `runId` labels on
// exported metrics.

export type MetricType = "counter" | "gauge" | "histogram";

export type MetricEntry = {
  name: string;
  type: MetricType;
  unit: string;
  description: string;
  labels: string[]; // declared label keys (excluding implicit `metric`)
  alertExpr?: string; // E1 threshold (Prometheus-style expression)
  alertWindow?: string; // e.g. "10m", "24h" — runbook reference window
  runbook?: string; // short text or pointer
};

export const METRIC_CATALOG: Record<string, MetricEntry> = {
  pi_eng_fallback_fired_total: {
    name: "pi_eng_fallback_fired_total",
    type: "counter",
    unit: "1",
    description: "Number of times a CoPilot-compat recovery tier fired (synthesis, stdout-scan, retry, etc.).",
    labels: ["tier", "agent", "step", "provider"],
    alertExpr: 'sum by (tier) (rate(pi_eng_fallback_fired_total[10m])) > 0.5',
    alertWindow: "10m",
    runbook: "Spike in deep-tier fallbacks → re-probe provider; check Pi version.",
  },
  pi_eng_verdict_timeout_total: {
    name: "pi_eng_verdict_timeout_total",
    type: "counter",
    unit: "1",
    description: "Steps that hit StepTimeoutError without an agent verdict.",
    labels: ["agent", "step"],
    alertExpr: 'sum by (agent, step) (increase(pi_eng_verdict_timeout_total[30m])) > 3',
    alertWindow: "30m",
    runbook: "Same step timing out repeatedly → raise step timeout or switch model tier.",
  },
  pi_eng_activity_drops_total: {
    name: "pi_eng_activity_drops_total",
    type: "counter",
    unit: "1",
    description: "Activity events dropped under ring pressure.",
    labels: ["kind", "provider"],
    alertExpr: 'sum by (kind) (rate(pi_eng_activity_drops_total{kind!="thinking"}[5m])) > 0',
    alertWindow: "5m",
    runbook: "Any essential-kind drop is page-worthy.",
  },
  pi_eng_activity_disk_usage_bytes: {
    name: "pi_eng_activity_disk_usage_bytes",
    type: "gauge",
    unit: "bytes",
    description: "Total bytes used under <runsDir>/_activity/ (sums canonical + legacy-mirror surfaces).",
    labels: ["surface"],
  },
  pi_eng_activity_disk_quota_bytes: {
    name: "pi_eng_activity_disk_quota_bytes",
    type: "gauge",
    unit: "bytes",
    description: "Configured _activity quota per surface.",
    labels: ["surface"],
    alertExpr: 'sum(pi_eng_activity_disk_usage_bytes) / sum(pi_eng_activity_disk_quota_bytes) > 0.85',
    alertWindow: "5m",
    runbook: "Active-run-aware pruner should already be degrading old terminal runs.",
  },
  pi_eng_stuck_warning_total: {
    name: "pi_eng_stuck_warning_total",
    type: "counter",
    unit: "1",
    description: "Stuck-warning events emitted by the activity queue's lifecycle detector.",
    labels: ["kind"],
  },
  pi_eng_stuck_warning_resolved_total: {
    name: "pi_eng_stuck_warning_resolved_total",
    type: "counter",
    unit: "1",
    description: "Stuck warnings resolved with explicit outcome (true_stuck / false_positive / unknown).",
    labels: ["kind", "outcome"],
  },
  pi_eng_stuck_warning_false_positive_ratio: {
    name: "pi_eng_stuck_warning_false_positive_ratio",
    type: "gauge",
    unit: "ratio",
    description: "false_positive / total resolved warnings over the rolling window.",
    labels: [],
    alertExpr: 'pi_eng_stuck_warning_false_positive_ratio > 0.10 and sum(pi_eng_stuck_warning_resolved_total) >= 50',
    alertWindow: "24h",
    runbook: "Tune stuck thresholds; ratio > 10% with N>=50 indicates over-eager warnings.",
  },
  pi_eng_capability_override_total: {
    name: "pi_eng_capability_override_total",
    type: "counter",
    unit: "1",
    description: "PI_ENGINEERING_ALLOW_STALE_CAPABILITIES overrides applied (operator opt-out).",
    labels: ["mode"],
    alertExpr: 'increase(pi_eng_capability_override_total{mode="enforce"}[24h]) > 0',
    alertWindow: "24h",
    runbook: "Production enforce overrides require investigation.",
  },
  pi_eng_capability_mismatch_total: {
    name: "pi_eng_capability_mismatch_total",
    type: "counter",
    unit: "1",
    description: "Probe-bundle vs runtime mismatches detected at run/spawn time.",
    labels: ["provider", "kind"],
  },
  pi_eng_capability_stale_total: {
    name: "pi_eng_capability_stale_total",
    type: "counter",
    unit: "1",
    description: "Capability bundles refused due to staleness or broken hash.",
    labels: ["provider"],
  },
  pi_eng_redaction_pattern_miss_total: {
    name: "pi_eng_redaction_pattern_miss_total",
    type: "counter",
    unit: "1",
    description: "Honeytoken-scanner hits — a secret-class string slipped past the Redactor.",
    labels: ["class"],
    alertExpr: 'increase(pi_eng_redaction_pattern_miss_total[1h]) > 0',
    alertWindow: "1h",
    runbook: "CREDENTIAL LEAK INCIDENT — rotate the leaked credential class immediately; patch the redactor; re-deploy.",
  },
  pi_eng_phase_b_auto_disabled_total: {
    name: "pi_eng_phase_b_auto_disabled_total",
    type: "counter",
    unit: "1",
    description: "Phase B auto-disable events (latched after >3 essential coalesces in 60s).",
    labels: ["reason"],
    alertExpr: 'increase(pi_eng_phase_b_auto_disabled_total[24h]) > 0',
    alertWindow: "24h",
    runbook: "Investigate slow disk / SSE consumer / oversaturated stream.",
  },
  pi_eng_cohort_overflow_total: {
    name: "pi_eng_cohort_overflow_total",
    type: "counter",
    unit: "1",
    description: "Registry overflow events — >256 distinct cohort tuples observed.",
    labels: ["provider"],
    alertExpr: 'increase(pi_eng_cohort_overflow_total[24h]) > 0',
    alertWindow: "24h",
    runbook: "Block feature ramps; expand registry or stricter tuple dimensions.",
  },
  pi_eng_feature_gate_breach_total: {
    name: "pi_eng_feature_gate_breach_total",
    type: "counter",
    unit: "1",
    description: "Feature ramp gate breached → cohort rolled back + paging fired.",
    labels: ["feature"],
    alertExpr: 'increase(pi_eng_feature_gate_breach_total[1h]) > 0',
    alertWindow: "1h",
    runbook: "Auto-rollback already fired; investigate root cause before re-ramping.",
  },
  pi_eng_protection_block_total: {
    name: "pi_eng_protection_block_total",
    type: "counter",
    unit: "1",
    description: "Layer-A protected-path writes blocked. Bounded labels — raw redacted path in logs only.",
    labels: ["path_class", "rule", "surface"],
  },
  pi_eng_usage_unavailable_total: {
    name: "pi_eng_usage_unavailable_total",
    type: "counter",
    unit: "1",
    description: "Subprocess returned no token/cost usage data — wall-clock-only budget enforced.",
    labels: ["provider"],
  },
  pi_eng_workflow_success_total: {
    name: "pi_eng_workflow_success_total",
    type: "counter",
    unit: "1",
    description: "Workflows that reached a terminal `succeeded` state, broken down by workflow + cohort.",
    labels: ["workflow", "cohort"],
  },
};

export const METRIC_NAMES = Object.keys(METRIC_CATALOG);

/**
 * Lookup helper used by emitters + alert-generators. Throws on
 * undefined name so a typo in a caller fails the build (when
 * called from a top-level TS module) or fails CI tests.
 */
export function metric(name: string): MetricEntry {
  const entry = METRIC_CATALOG[name];
  if (!entry) throw new Error(`metric-catalog: unknown metric name '${name}'`);
  return entry;
}
