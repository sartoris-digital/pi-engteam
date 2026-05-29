import { describe, it, expect, vi } from "vitest";
import type { VerdictPayload } from "../../../src/types.js";
import type { StepContext } from "../../../src/workflows/types.js";
import { verify } from "../../../src/workflows/verify.js";

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
    engine: { getRunsDir: () => "/tmp/test-runs" } as any,
  };

  return ctx;
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
    expect(verify.defaults.maxWallSeconds).toBe(7200);
  });
});

describe("verify workflow – audit step", () => {
  it("PASS with gaps → success, no handoffHint", async () => {
    const ctx = makeCtx({
      audit: { step: "audit", verdict: "PASS", issues: ["gap1", "gap2"] },
    });
    const auditStep = verify.steps.find(s => s.name === "audit")!;

    const result = await auditStep.run(ctx);
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.handoffHint).toBeUndefined();
  });

  it("PASS with no-gaps handoffHint → success with no-gaps hint", async () => {
    const ctx = makeCtx({
      audit: { step: "audit", verdict: "PASS", handoffHint: "no-gaps" },
    });
    const auditStep = verify.steps.find(s => s.name === "audit")!;

    const result = await auditStep.run(ctx);
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.handoffHint).toBe("no-gaps");
  });

  it("FAIL → not success", async () => {
    const ctx = makeCtx({
      audit: { step: "audit", verdict: "FAIL", issues: ["critical error"] },
    });
    const auditStep = verify.steps.find(s => s.name === "audit")!;

    const result = await auditStep.run(ctx);
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

  it("audit PASS (handoffHint=no-gaps) → validate [runs existing tests]", () => {
    const transition = verify.transitions.find(
      t => t.from === "audit" && t.to === "validate",
    )!;
    expect(transition).toBeDefined();
    expect(transition.when({ success: true, verdict: "PASS", handoffHint: "no-gaps" })).toBe(true);
    expect(transition.when({ success: true, verdict: "PASS" })).toBe(false);
  });

  it("audit FAIL → validate (GHCP timeout resilience)", () => {
    const failTransition = verify.transitions.find(
      t => t.from === "audit" && t.to === "validate" && t.when({ success: false, verdict: "FAIL" }),
    )!;
    expect(failTransition).toBeDefined();
    expect(failTransition.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("write-tests PASS → validate", () => {
    const t = verify.transitions.find(tr => tr.from === "write-tests" && tr.to === "validate")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(false);
  });

  it("write-tests FAIL → validate (GHCP timeout resilience)", () => {
    const t = verify.transitions.find(
      tr => tr.from === "write-tests" && tr.to === "validate" && tr.when({ success: false, verdict: "FAIL" }),
    )!;
    expect(t).toBeDefined();
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("validate PASS → review", () => {
    const t = verify.transitions.find(tr => tr.from === "validate" && tr.to === "review")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("validate FAIL → review (GHCP: always move forward, no write-tests↔validate loop)", () => {
    const t = verify.transitions.find(
      tr => tr.from === "validate" && tr.to === "review" && tr.when({ success: false, verdict: "FAIL" }),
    )!;
    expect(t).toBeDefined();
    expect(t.to).toBe("review");
  });

  it("review PASS → judge-gate", () => {
    const t = verify.transitions.find(tr => tr.from === "review" && tr.to === "judge-gate")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("review FAIL → judge-gate (GHCP: produce verdict.md instead of looping)", () => {
    const t = verify.transitions.find(
      tr => tr.from === "review" && tr.to === "judge-gate" && tr.when({ success: false, verdict: "FAIL" }),
    )!;
    expect(t).toBeDefined();
    expect(t.to).toBe("judge-gate");
  });

  it("judge-gate PASS → halt", () => {
    const t = verify.transitions.find(tr => tr.from === "judge-gate" && tr.to === "halt")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("judge-gate FAIL → halt (GHCP: outcome captured in verdict.md, no re-loop)", () => {
    const t = verify.transitions.find(
      tr => tr.from === "judge-gate" && tr.to === "halt" && tr.when({ success: false, verdict: "FAIL" }),
    )!;
    expect(t).toBeDefined();
    expect(t.to).toBe("halt");
  });
});

describe("verify workflow – write-tests step injects feedback", () => {
  it("includes reviewer issues in prompt when present", async () => {
    const ctx = makeCtx(
      { "write-tests": { step: "write-tests", verdict: "PASS" } },
      {
        artifacts: { "audit-gaps": "gap-report.md" },
        steps: [
          {
            name: "review",
            verdict: "FAIL",
            issues: ["missing edge case for null input"],
          },
        ],
      },
    );

    const writeTestsStep = verify.steps.find(s => s.name === "write-tests")!;
    await writeTestsStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("missing edge case for null input");
    expect(msg).toContain("gap-report.md");
  });

  it("includes failing test output in prompt when validate failed", async () => {
    const ctx = makeCtx(
      { "write-tests": { step: "write-tests", verdict: "PASS" } },
      {
        artifacts: {},
        steps: [
          {
            name: "validate",
            verdict: "FAIL",
            handoffHint: "Test suite: 3 failed\n  FAIL src/foo.test.ts",
          },
        ],
      },
    );

    const writeTestsStep = verify.steps.find(s => s.name === "write-tests")!;
    await writeTestsStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("FAIL src/foo.test.ts");
  });
});
