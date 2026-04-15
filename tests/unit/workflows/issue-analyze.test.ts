import { describe, it, expect } from "vitest";
import { issueAnalyze } from "../../../src/workflows/issue-analyze.js";

describe("issueAnalyze workflow", () => {
  it("has a single analyze step", () => {
    expect(issueAnalyze.steps.map(s => s.name)).toEqual(["analyze"]);
  });

  it("analyze step has no pauseAfter", () => {
    const step = issueAnalyze.steps[0];
    expect(step.pauseAfter).toBeUndefined();
  });

  it("transitions always go to halt regardless of verdict", () => {
    const passResult = { success: true, verdict: "PASS" as const };
    const failResult = { success: false, verdict: "FAIL" as const };
    const t = issueAnalyze.transitions.find(t => t.from === "analyze");
    expect(t).toBeDefined();
    expect(t!.to).toBe("halt");
    expect(t!.when(passResult)).toBe(true);
    expect(t!.when(failResult)).toBe(true);
  });
});
