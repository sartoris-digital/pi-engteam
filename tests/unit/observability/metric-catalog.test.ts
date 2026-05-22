import { describe, it, expect } from "vitest";
import { METRIC_CATALOG, METRIC_NAMES, metric } from "../../../src/observability/metric-catalog.js";

describe("metric-catalog", () => {
  it("exports a non-empty catalog", () => {
    expect(METRIC_NAMES.length).toBeGreaterThan(0);
  });

  it("every counter name ends in _total", () => {
    for (const name of METRIC_NAMES) {
      const m = METRIC_CATALOG[name];
      if (m.type === "counter") {
        expect(name.endsWith("_total")).toBe(true);
      }
    }
  });

  it("every entry's labels are bounded and don't contain runId", () => {
    for (const name of METRIC_NAMES) {
      const m = METRIC_CATALOG[name];
      // Per round 6 MED #2 / item E4: no runId labels on exported
      // metrics — runId is unbounded cardinality.
      expect(m.labels).not.toContain("runId");
      // Each label name is short + ascii.
      for (const label of m.labels) {
        expect(label).toMatch(/^[a-z_][a-z0-9_]*$/);
      }
    }
  });

  it("metric() throws on unknown name", () => {
    expect(() => metric("pi_eng_does_not_exist")).toThrow(/unknown metric/);
  });

  it("metric() returns the catalog entry for a known name", () => {
    const m = metric("pi_eng_fallback_fired_total");
    expect(m.type).toBe("counter");
    expect(m.labels).toContain("tier");
  });

  it("includes the round-12 missing entries (cohort overflow, capability mismatch, gate breach)", () => {
    // Round 11 MED #4: these MUST be in the catalog so generated
    // alerts can reference them.
    expect(METRIC_NAMES).toContain("pi_eng_capability_mismatch_total");
    expect(METRIC_NAMES).toContain("pi_eng_cohort_overflow_total");
    expect(METRIC_NAMES).toContain("pi_eng_feature_gate_breach_total");
    expect(METRIC_NAMES).toContain("pi_eng_stuck_warning_resolved_total");
  });

  it("alert expressions reference only cataloged metric names", () => {
    for (const name of METRIC_NAMES) {
      const m = METRIC_CATALOG[name];
      if (!m.alertExpr) continue;
      // Extract metric-name-shaped tokens (pi_eng_*) from the
      // expression and assert each is in the catalog.
      const refs = m.alertExpr.match(/pi_eng_[a-z_]+/g) ?? [];
      for (const r of refs) {
        expect(METRIC_NAMES, `alert expr for ${name} references unknown metric ${r}`).toContain(r);
      }
    }
  });
});
