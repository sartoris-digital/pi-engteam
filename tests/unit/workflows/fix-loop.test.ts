import { describe, it, expect, vi } from "vitest";
import type { VerdictPayload } from "../../../src/types.js";
import type { StepContext } from "../../../src/workflows/types.js";
import { fixLoop } from "../../../src/workflows/fix-loop.js";

function makeCtx(
  verdicts: Record<string, VerdictPayload> = {},
  overrides?: Partial<StepContext["run"]>,
): StepContext {
  const team = {
    deliver: vi.fn(async (_agentName: string, msg: any) => {
      const match = typeof msg.summary === "string" && msg.summary.match(/Execute step: (.+)/);
      if (match) {
        const stepName = match[1];
        return verdicts[stepName] ?? { step: stepName, verdict: "PASS" };
      }
      return undefined;
    }),
  };

  const ctx: StepContext = {
    run: {
      runId: "run-fix-1",
      workflow: "fix-loop",
      goal: "Fix the memory leak in the cache layer",
      status: "running",
      currentStep: "analyze",
      iteration: 0,
      budget: {
        maxIterations: 12,
        maxCostUsd: 30,
        maxWallSeconds: 7200,
        maxTokens: 200000,
        spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
      },
      steps: [],
      artifacts: {},
      approvals: [],
      planMode: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    },
    team: team as any,
    observer: { emit: vi.fn() } as any,
    engine: {} as any,
  };

  return ctx;
}

describe("fix-loop workflow – structure", () => {
  it("has correct name and step count", () => {
    expect(fixLoop.name).toBe("fix-loop");
    expect(fixLoop.steps).toHaveLength(5);
    expect(fixLoop.steps.map(s => s.name)).toEqual([
      "analyze", "implement", "test", "review", "judge-gate",
    ]);
  });

  it("defaults are set correctly", () => {
    expect(fixLoop.defaults.maxIterations).toBe(12);
    expect(fixLoop.defaults.maxCostUsd).toBe(30);
    expect(fixLoop.defaults.maxWallSeconds).toBe(7200);
  });
});

describe("fix-loop workflow – analyze step", () => {
  it("PASS → success with fix-plan artifact", async () => {
    const ctx = makeCtx({
      analyze: { step: "analyze", verdict: "PASS", artifacts: ["fix-plan.md"] },
    });
    const analyzeStep = fixLoop.steps.find(s => s.name === "analyze")!;

    const result = await analyzeStep.run(ctx);
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
  });

  it("FAIL → not success, halt", async () => {
    const ctx = makeCtx({
      analyze: { step: "analyze", verdict: "FAIL", issues: ["Cannot determine root cause without access to prod logs"] },
    });
    const analyzeStep = fixLoop.steps.find(s => s.name === "analyze")!;

    const result = await analyzeStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
  });
});

describe("fix-loop workflow – transitions", () => {
  it("analyze PASS → implement", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "analyze" && tr.to === "implement")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(false);
  });

  it("analyze FAIL → halt", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "analyze" && tr.to === "halt")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("implement PASS → test", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "implement" && tr.to === "test")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("implement FAIL → analyze", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "implement" && tr.to === "analyze")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("test PASS → review", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "test" && tr.to === "review")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("test FAIL → implement (failure output in handoffHint)", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "test" && tr.to === "implement")!;
    expect(t.when({ success: false, verdict: "FAIL", handoffHint: "3 tests failed" })).toBe(true);
  });

  it("review PASS → judge-gate", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "review" && tr.to === "judge-gate")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("review FAIL → implement", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "review" && tr.to === "implement")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("judge-gate PASS → halt", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "judge-gate" && tr.to === "halt")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("judge-gate FAIL → implement", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "judge-gate" && tr.to === "implement")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });
});

describe("fix-loop workflow – implement step injects all feedback", () => {
  it("injects test handoffHint, reviewer issues, and judge issues into prompt", async () => {
    const ctx = makeCtx(
      { implement: { step: "implement", verdict: "PASS" } },
      {
        artifacts: { "fix-plan": "fix-plan.md" },
        steps: [
          {
            name: "test",
            verdict: "FAIL",
            handoffHint: "FAIL src/cache.test.ts: expected 0 got 5 leaked references",
          },
          {
            name: "review",
            verdict: "FAIL",
            issues: ["Missing null check on eviction callback"],
          },
          {
            name: "judge-gate",
            verdict: "FAIL",
            issues: ["Fix does not address concurrent access scenario"],
          },
        ],
      },
    );

    const implementStep = fixLoop.steps.find(s => s.name === "implement")!;
    await implementStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("FAIL src/cache.test.ts: expected 0 got 5 leaked references");
    expect(msg).toContain("Missing null check on eviction callback");
    expect(msg).toContain("Fix does not address concurrent access scenario");
    expect(msg).toContain("fix-plan.md");
  });
});

describe("fix-loop workflow – full happy path (analyze→implement→test→review→judge-gate)", () => {
  it("each step returns PASS in sequence", async () => {
    const ctx = makeCtx({}, { artifacts: { "fix-plan": "fix-plan.md" } });

    const steps = {
      analyze: fixLoop.steps.find(s => s.name === "analyze")!,
      implement: fixLoop.steps.find(s => s.name === "implement")!,
      test: fixLoop.steps.find(s => s.name === "test")!,
      review: fixLoop.steps.find(s => s.name === "review")!,
      judgeGate: fixLoop.steps.find(s => s.name === "judge-gate")!,
    };

    const analyzeResult = await steps.analyze.run(ctx);
    expect(analyzeResult.success).toBe(true);

    const implementResult = await steps.implement.run(ctx);
    expect(implementResult.success).toBe(true);

    const testResult = await steps.test.run(ctx);
    expect(testResult.success).toBe(true);

    const reviewResult = await steps.review.run(ctx);
    expect(reviewResult.success).toBe(true);

    const judgeResult = await steps.judgeGate.run(ctx);
    expect(judgeResult.success).toBe(true);
  });
});
