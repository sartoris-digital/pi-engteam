import { describe, it, expect } from "vitest";
import { generateRunbook } from "../../../src/observability/runbook-generator.js";
import { METRIC_CATALOG, METRIC_NAMES } from "../../../src/observability/metric-catalog.js";

describe("runbook-generator", () => {
  it("emits a section for every cataloged metric", () => {
    const out = generateRunbook();
    for (const name of METRIC_NAMES) {
      expect(out).toContain(`## \`${name}\``);
    }
  });

  it("includes alert expressions and runbook actions when set", () => {
    const out = generateRunbook();
    for (const name of METRIC_NAMES) {
      const m = METRIC_CATALOG[name];
      if (m.alertExpr) {
        expect(out).toContain(m.alertExpr);
      }
      if (m.runbook) {
        expect(out).toContain(m.runbook);
      }
    }
  });

  it("output is deterministic across calls (stable diff)", () => {
    const a = generateRunbook();
    const b = generateRunbook();
    expect(a).toBe(b);
  });

  it("starts with the do-not-edit header", () => {
    const out = generateRunbook();
    expect(out).toMatch(/^# pi-engineering observability runbook/);
    expect(out).toContain("GENERATED FILE — do not edit");
  });
});
