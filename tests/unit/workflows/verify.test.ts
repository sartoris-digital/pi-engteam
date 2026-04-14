import { describe, it, expect, vi } from "vitest";
import type { VerdictPayload } from "../../../src/types.js";
import type { StepContext } from "../../../src/workflows/types.js";
import { verify } from "../../../src/workflows/verify.js";

function makeCtx(overrides?: Partial<StepContext["run"]>): StepContext {
  const listeners = new Map<string, (v: VerdictPayload) => void>();

  const engine = {
    registerVerdictListener: vi.fn((_runId: string, stepName: string, fn: (v: VerdictPayload) => void) => {
      listeners.set(stepName, fn);
    }),
  };

  const team = {
    deliver: vi.fn(async (_agentName: string, _msg: unknown) => {
      // No-op by default; tests fire verdicts directly via listeners
    }),
  };

  const ctx: StepContext = {
    run: {
      runId: "run-1",
      workflow: "verify",
      goal: "Test the codebase",
      status: "running",
      currentStep: "audit",
      iteration: 0,
      budget: {
        maxIterations: 8,
        maxCostUsd: 20,
        maxWallSeconds: 3600,
        maxTokens: 100000,
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

  // Make deliver fire the registered listener immediately after registration
  (team.deliver as any).mockImplementation(async (_agentName: string, _msg: unknown) => {
    // verdicts are fired by individual tests
  });

  return ctx;
}

function fireVerdict(ctx: StepContext, stepName: string, payload: VerdictPayload) {
  const engine = ctx.engine as any;
  const calls: Array<[string, string, (v: VerdictPayload) => void]> = engine.registerVerdictListener.mock.calls;
  const call = calls.findLast(([_runId, sn]) => sn === stepName);
  if (!call) throw new Error(`No listener registered for step "${stepName}"`);
  call[2](payload);
}

describe("verify workflow – structure", () => {
  it("has correct name and step count", () => {
    expect(verify.name).toBe("verify");
    expect(verify.steps).toHaveLength(5);
    expect(verify.steps.map(s => s.name)).toEqual([
      "audit", "write-tests", "validate", "review", "judge-gate",
    ]);
  });

  it("defaults are set correctly", () => {
    expect(verify.defaults.maxIterations).toBe(8);
    expect(verify.defaults.maxCostUsd).toBe(20);
    expect(verify.defaults.maxWallSeconds).toBe(3600);
  });
});

describe("verify workflow – audit step", () => {
  it("PASS with gaps → success, no handoffHint", async () => {
    const ctx = makeCtx();
    const auditStep = verify.steps.find(s => s.name === "audit")!;

    const promise = auditStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "audit", { step: "audit", verdict: "PASS", issues: ["gap1", "gap2"] });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.handoffHint).toBeUndefined();
  });

  it("PASS with no-gaps handoffHint → success with no-gaps hint", async () => {
    const ctx = makeCtx();
    const auditStep = verify.steps.find(s => s.name === "audit")!;

    const promise = auditStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "audit", {
      step: "audit",
      verdict: "PASS",
      handoffHint: "no-gaps",
    });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.handoffHint).toBe("no-gaps");
  });

  it("FAIL → not success", async () => {
    const ctx = makeCtx();
    const auditStep = verify.steps.find(s => s.name === "audit")!;

    const promise = auditStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "audit", { step: "audit", verdict: "FAIL", issues: ["critical error"] });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
  });
});

describe("verify workflow – transitions", () => {
  it("audit PASS (no handoffHint) → write-tests", () => {
    const transition = verify.transitions.find(
      t => t.from === "audit" && t.to === "write-tests",
    )!;
    expect(transition).toBeDefined();
    expect(transition.when({ success: true, verdict: "PASS" })).toBe(true);
    expect(transition.when({ success: true, verdict: "PASS", handoffHint: "no-gaps" })).toBe(false);
  });

  it("audit PASS (handoffHint=no-gaps) → halt [success path]", () => {
    const transition = verify.transitions.find(
      t => t.from === "audit" && t.to === "halt",
    )!;
    expect(transition).toBeDefined();
    expect(transition.when({ success: true, verdict: "PASS", handoffHint: "no-gaps" })).toBe(true);
    expect(transition.when({ success: true, verdict: "PASS" })).toBe(false);
  });

  it("audit FAIL → halt", () => {
    const failTransition = verify.transitions.find(
      t => t.from === "audit" && t.to === "halt" && t.when({ success: false, verdict: "FAIL" }),
    )!;
    expect(failTransition).toBeDefined();
    expect(failTransition.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("write-tests PASS → validate", () => {
    const t = verify.transitions.find(tr => tr.from === "write-tests" && tr.to === "validate")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(false);
  });

  it("write-tests FAIL → halt", () => {
    const t = verify.transitions.find(tr => tr.from === "write-tests" && tr.to === "halt")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("validate PASS → review", () => {
    const t = verify.transitions.find(tr => tr.from === "validate" && tr.to === "review")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("validate FAIL → write-tests", () => {
    const t = verify.transitions.find(tr => tr.from === "validate" && tr.to === "write-tests")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("review PASS → judge-gate", () => {
    const t = verify.transitions.find(tr => tr.from === "review" && tr.to === "judge-gate")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("review FAIL → write-tests", () => {
    const t = verify.transitions.find(tr => tr.from === "review" && tr.to === "write-tests")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("judge-gate PASS → halt", () => {
    const t = verify.transitions.find(tr => tr.from === "judge-gate" && tr.to === "halt")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("judge-gate FAIL → write-tests", () => {
    const t = verify.transitions.find(tr => tr.from === "judge-gate" && tr.to === "write-tests")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });
});

describe("verify workflow – write-tests step injects feedback", () => {
  it("includes reviewer issues in prompt when present", async () => {
    const ctx = makeCtx({
      artifacts: { "audit-gaps": "gap-report.md" },
      steps: [
        {
          name: "review",
          verdict: "FAIL",
          issues: ["missing edge case for null input"],
        },
      ],
    });

    const writeTestsStep = verify.steps.find(s => s.name === "write-tests")!;
    const promise = writeTestsStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "write-tests", { step: "write-tests", verdict: "PASS" });
    await promise;

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("missing edge case for null input");
    expect(msg).toContain("gap-report.md");
  });

  it("includes failing test output in prompt when validate failed", async () => {
    const ctx = makeCtx({
      artifacts: {},
      steps: [
        {
          name: "validate",
          verdict: "FAIL",
          handoffHint: "Test suite: 3 failed\n  FAIL src/foo.test.ts",
        },
      ],
    });

    const writeTestsStep = verify.steps.find(s => s.name === "write-tests")!;
    const promise = writeTestsStep.run(ctx);
    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "write-tests", { step: "write-tests", verdict: "PASS" });
    await promise;

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("FAIL src/foo.test.ts");
  });
});
