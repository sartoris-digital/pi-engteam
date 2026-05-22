# pi-engineering observability runbook

> GENERATED FILE — do not edit. Source of truth is
> `src/observability/metric-catalog.ts`. Regenerate via
> `pnpm runbook` (CI verifies the diff is empty).

This runbook is the on-call reference for every metric the
pi-engineering runtime emits. Each entry includes: catalog name,
type, labels, units, alert expression, runbook action.

## `pi_eng_activity_disk_quota_bytes`

- **Type:** `gauge`
- **Unit:** `bytes`
- **Labels:** `surface`
- **Description:** Configured _activity quota per surface.
- **Alert (window 5m):**

  ```promql
  sum(pi_eng_activity_disk_usage_bytes) / sum(pi_eng_activity_disk_quota_bytes) > 0.85
  ```
- **Runbook:** Active-run-aware pruner should already be degrading old terminal runs.

## `pi_eng_activity_disk_usage_bytes`

- **Type:** `gauge`
- **Unit:** `bytes`
- **Labels:** `surface`
- **Description:** Total bytes used under <runsDir>/_activity/ (sums canonical + legacy-mirror surfaces).

## `pi_eng_activity_drops_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `kind`, `provider`
- **Description:** Activity events dropped under ring pressure.
- **Alert (window 5m):**

  ```promql
  sum by (kind) (rate(pi_eng_activity_drops_total{kind!="thinking"}[5m])) > 0
  ```
- **Runbook:** Any essential-kind drop is page-worthy.

## `pi_eng_capability_mismatch_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `provider`, `kind`
- **Description:** Probe-bundle vs runtime mismatches detected at run/spawn time.

## `pi_eng_capability_override_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `mode`
- **Description:** PI_ENGINEERING_ALLOW_STALE_CAPABILITIES overrides applied (operator opt-out).
- **Alert (window 24h):**

  ```promql
  increase(pi_eng_capability_override_total{mode="enforce"}[24h]) > 0
  ```
- **Runbook:** Production enforce overrides require investigation.

## `pi_eng_capability_stale_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `provider`
- **Description:** Capability bundles refused due to staleness or broken hash.

## `pi_eng_cohort_overflow_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `provider`
- **Description:** Registry overflow events — >256 distinct cohort tuples observed.
- **Alert (window 24h):**

  ```promql
  increase(pi_eng_cohort_overflow_total[24h]) > 0
  ```
- **Runbook:** Block feature ramps; expand registry or stricter tuple dimensions.

## `pi_eng_fallback_fired_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `tier`, `agent`, `step`, `provider`
- **Description:** Number of times a CoPilot-compat recovery tier fired (synthesis, stdout-scan, retry, etc.).
- **Alert (window 10m):**

  ```promql
  sum by (tier) (rate(pi_eng_fallback_fired_total[10m])) > 0.5
  ```
- **Runbook:** Spike in deep-tier fallbacks → re-probe provider; check Pi version.

## `pi_eng_feature_gate_breach_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `feature`
- **Description:** Feature ramp gate breached → cohort rolled back + paging fired.
- **Alert (window 1h):**

  ```promql
  increase(pi_eng_feature_gate_breach_total[1h]) > 0
  ```
- **Runbook:** Auto-rollback already fired; investigate root cause before re-ramping.

## `pi_eng_phase_b_auto_disabled_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `reason`
- **Description:** Phase B auto-disable events (latched after >3 essential coalesces in 60s).
- **Alert (window 24h):**

  ```promql
  increase(pi_eng_phase_b_auto_disabled_total[24h]) > 0
  ```
- **Runbook:** Investigate slow disk / SSE consumer / oversaturated stream.

## `pi_eng_protection_block_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `path_class`, `rule`, `surface`
- **Description:** Layer-A protected-path writes blocked. Bounded labels — raw redacted path in logs only.

## `pi_eng_redaction_pattern_miss_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `class`
- **Description:** Honeytoken-scanner hits — a secret-class string slipped past the Redactor.
- **Alert (window 1h):**

  ```promql
  increase(pi_eng_redaction_pattern_miss_total[1h]) > 0
  ```
- **Runbook:** CREDENTIAL LEAK INCIDENT — rotate the leaked credential class immediately; patch the redactor; re-deploy.

## `pi_eng_stuck_warning_false_positive_ratio`

- **Type:** `gauge`
- **Unit:** `ratio`
- **Labels:** _(none)_
- **Description:** false_positive / total resolved warnings over the rolling window.
- **Alert (window 24h):**

  ```promql
  pi_eng_stuck_warning_false_positive_ratio > 0.10 and sum(pi_eng_stuck_warning_resolved_total) >= 50
  ```
- **Runbook:** Tune stuck thresholds; ratio > 10% with N>=50 indicates over-eager warnings.

## `pi_eng_stuck_warning_resolved_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `kind`, `outcome`
- **Description:** Stuck warnings resolved with explicit outcome (true_stuck / false_positive / unknown).

## `pi_eng_stuck_warning_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `kind`
- **Description:** Stuck-warning events emitted by the activity queue's lifecycle detector.

## `pi_eng_usage_unavailable_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `provider`
- **Description:** Subprocess returned no token/cost usage data — wall-clock-only budget enforced.

## `pi_eng_verdict_timeout_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `agent`, `step`
- **Description:** Steps that hit StepTimeoutError without an agent verdict.
- **Alert (window 30m):**

  ```promql
  sum by (agent, step) (increase(pi_eng_verdict_timeout_total[30m])) > 3
  ```
- **Runbook:** Same step timing out repeatedly → raise step timeout or switch model tier.

## `pi_eng_workflow_success_total`

- **Type:** `counter`
- **Unit:** `1`
- **Labels:** `workflow`, `cohort`
- **Description:** Workflows that reached a terminal `succeeded` state, broken down by workflow + cohort.
