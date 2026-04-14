import { describe, it, expect, vi } from "vitest";
import type { VerdictPayload } from "../../../src/types.js";
import type { StepContext } from "../../../src/workflows/types.js";
import { fixLoop } from "../../../src/workflows/fix-loop.js";

function makeCtx(overrides?: Partial<StepContext["run"]>): StepContext {
  const listeners = new Map<string, (v: VerdictPayload) => void>();

  const engine = {
    registerVerdictListener: vi.fn((_runId: string, stepName: string, fn: (v: VerdictPayload) => void) => {
      listeners.set(stepName, fn);
    }),
  };

  const team = {
    deliver: vi.fn(async (_agentName: string, _msg: unknown) => {}),
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
    engine: engine as any,
  };

  return ctx;
}

function fireVerdict(ctx: StepContext, stepName: string, payload: VerdictPayload) {
  const engine = ctx.engine as any;
  const calls: Array<[string, string, (v: VerdictPayload) => void]> = engine.registerVerdictListener.mock.calls;
  const call = calls.findLast(([_runId, sn]) => sn === stepName);
  if (!call) throw new Error(`No listener registered for step "${stepName}"`);
  call[2](payload);
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
    const ctx = makeCtx();
    const analyzeStep = fixLoop.steps.find(s => s.name === "analyze")!;

    const promise = analyzeStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "analyze", {
      step: "analyze",
      verdict: "PASS",
      artifacts: ["fix-plan.md"],
    });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
  });

  it("FAIL → not success, halt", async () => {
    const ctx = makeCtx();
    const analyzeStep = fixLoop.steps.find(s => s.name === "analyze")!;

    const promise = analyzeStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "analyze", {
      step: "analyze",
      verdict: "FAIL",
      issues: ["Cannot determine root cause without access to prod logs"],
    });

    const result = await promise;
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

  it("judge-gate FAIL → analyze (full re-plan)", () => {
    const t = fixLoop.transitions.find(tr => tr.from === "judge-gate" && tr.to === "analyze")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });
});

describe("fix-loop workflow – implement step injects all feedback", () => {
  it("injects test handoffHint, reviewer issues, and judge issues into prompt", async () => {
    const ctx = makeCtx({
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
    });

    const implementStep = fixLoop.steps.find(s => s.name === "implement")!;
    const promise = implementStep.run(ctx);

    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "implement", { step: "implement", verdict: "PASS" });
    await promise;

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
    const ctx = makeCtx({ artifacts: { "fix-plan": "fix-plan.md" } });

    const steps = {
      analyze: fixLoop.steps.find(s => s.name === "analyze")!,
      implement: fixLoop.steps.find(s => s.name === "implement")!,
      test: fixLoop.steps.find(s => s.name === "test")!,
      review: fixLoop.steps.find(s => s.name === "review")!,
      judgeGate: fixLoop.steps.find(s => s.name === "judge-gate")!,
    };

    // analyze
    const analyzePromise = steps.analyze.run(ctx);
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "analyze",
      ),
    );
    fireVerdict(ctx, "analyze", { step: "analyze", verdict: "PASS", artifacts: ["fix-plan.md"] });
    const analyzeResult = await analyzePromise;
    expect(analyzeResult.success).toBe(true);

    // implement
    const implementPromise = steps.implement.run(ctx);
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "implement",
      ),
    );
    fireVerdict(ctx, "implement", { step: "implement", verdict: "PASS" });
    const implementResult = await implementPromise;
    expect(implementResult.success).toBe(true);

    // test
    const testPromise = steps.test.run(ctx);
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "test",
      ),
    );
    fireVerdict(ctx, "test", { step: "test", verdict: "PASS" });
    const testResult = await testPromise;
    expect(testResult.success).toBe(true);

    // review
    const reviewPromise = steps.review.run(ctx);
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "review",
      ),
    );
    fireVerdict(ctx, "review", { step: "review", verdict: "PASS" });
    const reviewResult = await reviewPromise;
    expect(reviewResult.success).toBe(true);

    // judge-gate
    const judgePromise = steps.judgeGate.run(ctx);
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "judge-gate",
      ),
    );
    fireVerdict(ctx, "judge-gate", { step: "judge-gate", verdict: "PASS" });
    const judgeResult = await judgePromise;
    expect(judgeResult.success).toBe(true);
  });
});
