import { describe, it, expect, vi } from "vitest";
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

  it("passes the current runId to the issue analyst dispatch", async () => {
    const deliver = vi.fn(async () => ({
      step: "analyze",
      verdict: "PASS" as const,
      artifacts: ["issue-brief.md"],
    }));
    const step = issueAnalyze.steps[0];

    const result = await step.run({
      run: {
        runId: "issue-run-1",
        workflow: "issue-analyze",
        goal: "Fix #123 [tracker:gh]",
        status: "running",
        currentStep: "analyze",
        iteration: 1,
        budget: {
          maxIterations: 1,
          maxCostUsd: 1,
          maxWallSeconds: 60,
          maxTokens: 1000,
          spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
        },
        steps: [],
        artifacts: {},
        approvals: [],
        planMode: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      team: { deliver } as any,
      observer: {} as any,
      engine: {} as any,
    });

    expect(result.success).toBe(true);
    expect(deliver).toHaveBeenCalledWith(
      "issue-analyst",
      expect.objectContaining({ to: "issue-analyst" }),
      { runId: "issue-run-1" },
    );
  });
});
