import { describe, it, expect, vi } from "vitest";
import type { StepContext } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { planBuildReviewFix } from "../../../src/workflows/plan-build-review-fix.js";

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  const listeners = new Map<string, (v: VerdictPayload) => void>();

  const engine = {
    registerVerdictListener: vi.fn((runId: string, step: string, fn: (v: VerdictPayload) => void) => {
      listeners.set(`${runId}:${step}`, fn);
    }),
    _emit: (runId: string, step: string, payload: VerdictPayload) => {
      const fn = listeners.get(`${runId}:${step}`);
      if (fn) fn(payload);
    },
  };

  const team = {
    deliver: vi.fn((_agentName: string, _msg: object) => Promise.resolve()),
  };

  const run = {
    runId: "test-run-id",
    goal: "test goal",
    artifacts: {} as Record<string, string>,
    steps: [] as Array<{ name: string; issues?: string[] }>,
  };

  const ctx: StepContext = {
    run: run as any,
    team: team as any,
    observer: { emit: vi.fn() } as any,
    engine: engine as any,
    ...overrides,
  };

  // Make deliver call the verdict listener synchronously for the step in the message
  (team.deliver as ReturnType<typeof vi.fn>).mockImplementation(
    (_agentName: string, msg: any) => {
      // Extract step from message summary ("Execute step: <name>")
      const match = typeof msg.summary === "string" && msg.summary.match(/Execute step: (.+)/);
      if (match) {
        const stepName = match[1];
        engine._emit(run.runId, stepName, {
          step: stepName,
          verdict: "PASS",
        });
      }
      return Promise.resolve();
    },
  );

  return ctx;
}

function makeCtxWithVerdicts(
  verdicts: Record<string, VerdictPayload>,
): StepContext {
  const listeners = new Map<string, (v: VerdictPayload) => void>();

  const engine = {
    registerVerdictListener: vi.fn((runId: string, step: string, fn: (v: VerdictPayload) => void) => {
      listeners.set(`${runId}:${step}`, fn);
    }),
    _emit: (runId: string, step: string, payload: VerdictPayload) => {
      const fn = listeners.get(`${runId}:${step}`);
      if (fn) fn(payload);
    },
  };

  const team = {
    deliver: vi.fn(),
  };

  const run = {
    runId: "test-run-id",
    goal: "test goal",
    artifacts: {} as Record<string, string>,
    steps: [] as Array<{ name: string; issues?: string[] }>,
  };

  const ctx: StepContext = {
    run: run as any,
    team: team as any,
    observer: { emit: vi.fn() } as any,
    engine: engine as any,
  };

  (team.deliver as ReturnType<typeof vi.fn>).mockImplementation(
    (_agentName: string, msg: any) => {
      const match = typeof msg.summary === "string" && msg.summary.match(/Execute step: (.+)/);
      if (match) {
        const stepName = match[1];
        const payload = verdicts[stepName] ?? { step: stepName, verdict: "PASS" };
        engine._emit(run.runId, stepName, payload);
      }
      return Promise.resolve();
    },
  );

  return ctx;
}

describe("planBuildReviewFix workflow definition", () => {
  it("has the correct name and step names", () => {
    expect(planBuildReviewFix.name).toBe("plan-build-review-fix");
    expect(planBuildReviewFix.steps.map(s => s.name)).toEqual(["plan", "build", "review", "fix"]);
  });

  it("has correct defaults", () => {
    expect(planBuildReviewFix.defaults.maxIterations).toBe(12);
    expect(planBuildReviewFix.defaults.maxCostUsd).toBe(30);
    expect(planBuildReviewFix.defaults.maxWallSeconds).toBe(5400);
  });
});

describe("planBuildReviewFix transitions", () => {
  it("plan PASS → build", () => {
    const t = planBuildReviewFix.transitions.find(
      t => t.from === "plan" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("build");
  });

  it("plan FAIL → halt", () => {
    const t = planBuildReviewFix.transitions.find(
      t => t.from === "plan" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("review PASS → halt", () => {
    const t = planBuildReviewFix.transitions.find(
      t => t.from === "review" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("review FAIL → fix", () => {
    const t = planBuildReviewFix.transitions.find(
      t => t.from === "review" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("fix");
  });

  it("fix PASS → review", () => {
    const t = planBuildReviewFix.transitions.find(
      t => t.from === "fix" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("review");
  });

  it("fix FAIL → halt", () => {
    const t = planBuildReviewFix.transitions.find(
      t => t.from === "fix" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });
});

describe("planBuildReviewFix step execution", () => {
  it("all steps PASS path: plan → build → review each return PASS", async () => {
    const ctx = makeCtx();
    const planStep = planBuildReviewFix.steps.find(s => s.name === "plan")!;
    const buildStep = planBuildReviewFix.steps.find(s => s.name === "build")!;
    const reviewStep = planBuildReviewFix.steps.find(s => s.name === "review")!;

    const planResult = await planStep.run(ctx);
    expect(planResult.verdict).toBe("PASS");
    expect(planResult.success).toBe(true);

    const buildResult = await buildStep.run(ctx);
    expect(buildResult.verdict).toBe("PASS");
    expect(buildResult.success).toBe(true);

    const reviewResult = await reviewStep.run(ctx);
    expect(reviewResult.verdict).toBe("PASS");
    expect(reviewResult.success).toBe(true);
  });

  it("plan FAIL → step returns success=false", async () => {
    const ctx = makeCtxWithVerdicts({
      plan: { step: "plan", verdict: "FAIL", issues: ["goal not feasible"] },
    });
    const planStep = planBuildReviewFix.steps.find(s => s.name === "plan")!;
    const result = await planStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("goal not feasible");
  });

  it("fix step injects review issues from ctx.run.steps", async () => {
    const ctx = makeCtx();
    // Seed a prior review step with issues
    (ctx.run.steps as any[]).push({
      name: "review",
      issues: ["missing null check", "test coverage low"],
    });

    const fixStep = planBuildReviewFix.steps.find(s => s.name === "fix")!;
    const result = await fixStep.run(ctx);
    expect(result.verdict).toBe("PASS");

    // The message delivered should contain the review issues
    const deliverCalls = (ctx.team.deliver as ReturnType<typeof vi.fn>).mock.calls;
    const fixDeliverCall = deliverCalls.find(
      ([_agent, msg]: [string, any]) => msg.summary === "Execute step: fix",
    );
    expect(fixDeliverCall).toBeDefined();
    expect(fixDeliverCall[1].message).toContain("missing null check");
    expect(fixDeliverCall[1].message).toContain("test coverage low");
  });

  it("review FAIL then fix PASS loop: fix step returns PASS", async () => {
    const ctx = makeCtxWithVerdicts({
      review: { step: "review", verdict: "FAIL", issues: ["type error on line 42"] },
      fix: { step: "fix", verdict: "PASS" },
    });
    (ctx.run.steps as any[]).push({
      name: "review",
      issues: ["type error on line 42"],
    });

    const reviewStep = planBuildReviewFix.steps.find(s => s.name === "review")!;
    const reviewResult = await reviewStep.run(ctx);
    expect(reviewResult.verdict).toBe("FAIL");

    const fixStep = planBuildReviewFix.steps.find(s => s.name === "fix")!;
    const fixResult = await fixStep.run(ctx);
    expect(fixResult.verdict).toBe("PASS");
    expect(fixResult.success).toBe(true);
  });
});
