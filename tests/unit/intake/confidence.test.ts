import { describe, expect, it } from "vitest";
import type { Brief } from "../../../src/intake/brief-schema.js";
import { computeConfidence } from "../../../src/intake/confidence.js";

function brief(over: Partial<Brief> = {}): Brief {
  return {
    kind: "bug",
    flags: [],
    size: "M",
    reproSteps: "present",
    acceptanceCriteria: [{ id: "AC1", text: "it works", source: "quoted", quote: "it works" }],
    likelyPaths: ["src/a.ts"],
    questions: [],
    goal: "fix it",
    samples: { n: 2, kinds: ["bug", "bug"], acAgreement: 1 },
    prior: { from: "none" },
    confidence: "LOW",
    tier: "low",
    lane: "bug",
    ...over,
  };
}

describe("computeConfidence", () => {
  it("is HIGH when two samples agree with a prior, MEDIUM without a prior", () => {
    const samples = [brief({ kind: "bug" }), brief({ kind: "bug" })];
    const merged = brief({ kind: "bug", samples: { n: 2, kinds: ["bug", "bug"], acAgreement: 1 } });
    expect(
      computeConfidence({ prior: { kind: "bug", from: "label" }, samples, merged }).confidence,
    ).toBe("HIGH");
    expect(computeConfidence({ samples, merged }).confidence).toBe("MEDIUM");
    expect(computeConfidence({ prior: { from: "none" }, samples, merged }).confidence).toBe("MEDIUM");
  });

  it("is MEDIUM with priorDisagreed when the prior disagrees with unanimous samples", () => {
    const samples = [brief({ kind: "bug" }), brief({ kind: "bug" })];
    const merged = brief({ kind: "bug", samples: { n: 2, kinds: ["bug", "bug"], acAgreement: 1 } });
    const result = computeConfidence({
      prior: { kind: "feature", from: "title-prefix" },
      samples,
      merged,
    });
    expect(result.confidence).toBe("MEDIUM");
    expect(result.priorDisagreed).toBe(true);
  });

  it("is LOW on a three-way split", () => {
    const samples = [brief({ kind: "bug" }), brief({ kind: "feature" }), brief({ kind: "chore" })];
    const merged = brief({
      kind: "bug",
      samples: { n: 3, kinds: ["bug", "feature", "chore"], acAgreement: 0.2 },
    });
    expect(computeConfidence({ samples, merged }).confidence).toBe("LOW");
  });

  it("downgrades one level when acAgreement is below 0.5", () => {
    const samples = [brief({ kind: "bug" }), brief({ kind: "bug" })];
    const merged = brief({ kind: "bug", samples: { n: 2, kinds: ["bug", "bug"], acAgreement: 0.49 } });
    expect(
      computeConfidence({ prior: { kind: "bug", from: "label" }, samples, merged }).confidence,
    ).toBe("MEDIUM");
    expect(computeConfidence({ samples, merged }).confidence).toBe("LOW");
  });
});
