import { describe, it, expect, vi } from "vitest";
import type { StepContext } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { refactorCampaign } from "../../../src/workflows/refactor-campaign.js";

function makeCtxWithVerdicts(
  verdicts: Record<string, VerdictPayload>,
  runSteps: Array<{ name: string; issues?: string[]; handoffHint?: string }> = [],
  artifacts: Record<string, string> = {},
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

  const team = { deliver: vi.fn() };

  const run = {
    runId: "test-run-id",
    goal: "rename UserService to AccountService across codebase",
    artifacts: { ...artifacts } as Record<string, string>,
    steps: runSteps as any[],
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

function makePassCtx(): StepContext {
  return makeCtxWithVerdicts({});
}

describe("refactorCampaign workflow definition", () => {
  it("has the correct name and step names", () => {
    expect(refactorCampaign.name).toBe("refactor-campaign");
    expect(refactorCampaign.steps.map(s => s.name)).toEqual([
      "map",
      "design",
      "implement",
      "verify",
      "review",
      "judge-gate",
    ]);
  });

  it("has correct defaults", () => {
    expect(refactorCampaign.defaults.maxIterations).toBe(8);
    expect(refactorCampaign.defaults.maxCostUsd).toBe(40);
    expect(refactorCampaign.defaults.maxWallSeconds).toBe(7200);
  });
});

describe("refactorCampaign transitions", () => {
  it("map PASS → design", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "map" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("design");
  });

  it("map FAIL → halt", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "map" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("design PASS → implement", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "design" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("design FAIL → halt", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "design" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("implement PASS → verify", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "implement" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("verify");
  });

  it("implement FAIL → design", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "implement" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("design");
  });

  it("verify PASS → review", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "verify" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("review");
  });

  it("verify FAIL → implement", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "verify" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("review PASS → judge-gate", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "review" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("review FAIL → implement", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "review" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("judge-gate PASS → halt", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → design", () => {
    const t = refactorCampaign.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("design");
  });
});

describe("refactorCampaign step execution", () => {
  it("PASS path: all steps return PASS", async () => {
    const ctx = makePassCtx();
    for (const step of refactorCampaign.steps) {
      const result = await step.run(ctx);
      expect(result.verdict).toBe("PASS");
      expect(result.success).toBe(true);
    }
  });

  it("map FAIL → step returns success=false with issues", async () => {
    const ctx = makeCtxWithVerdicts({
      map: { step: "map", verdict: "FAIL", issues: ["cannot determine affected files"] },
    });
    const mapStep = refactorCampaign.steps.find(s => s.name === "map")!;
    const result = await mapStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("cannot determine affected files");

    // Transition routes to halt
    const t = refactorCampaign.transitions.find(
      t => t.from === "map" && t.when(result),
    );
    expect(t?.to).toBe("halt");
  });

  it("implement injects verify regressions and reviewer issues on loops", async () => {
    const ctx = makeCtxWithVerdicts(
      { implement: { step: "implement", verdict: "PASS" } },
      [
        { name: "verify", handoffHint: "TestFoo fails: expected 1 got 2" },
        { name: "review", issues: ["old name UserService still present in utils.ts"] },
      ],
    );
    const implementStep = refactorCampaign.steps.find(s => s.name === "implement")!;
    await implementStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as ReturnType<typeof vi.fn>).mock.calls;
    const implCall = deliverCalls.find(
      ([_agent, msg]: [string, any]) => msg.summary === "Execute step: implement",
    );
    expect(implCall).toBeDefined();
    expect(implCall[1].message).toContain("TestFoo fails: expected 1 got 2");
    expect(implCall[1].message).toContain("old name UserService still present in utils.ts");
  });

  it("verify FAIL surfaces regressions", async () => {
    const ctx = makeCtxWithVerdicts({
      verify: {
        step: "verify",
        verdict: "FAIL",
        issues: ["TestAccountService.create failed"],
        handoffHint: "TestAccountService.create failed: expected 'AccountService' got 'UserService'",
      },
    });
    const verifyStep = refactorCampaign.steps.find(s => s.name === "verify")!;
    const result = await verifyStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.handoffHint).toContain("AccountService");

    // Transition routes back to implement
    const t = refactorCampaign.transitions.find(
      t => t.from === "verify" && t.when(result),
    );
    expect(t?.to).toBe("implement");
  });
});
