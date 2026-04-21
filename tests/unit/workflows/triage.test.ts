import { describe, it, expect, vi } from "vitest";
import type { StepContext } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { triage } from "../../../src/workflows/triage.js";

function makeCtxWithVerdicts(
  verdicts: Record<string, VerdictPayload>,
  steps: Array<{ name: string; issues?: string[] }> = [],
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

  const run = {
    runId: "test-run-id",
    goal: "app crashes on null input",
    artifacts: {} as Record<string, string>,
    steps,
  };

  const ctx: StepContext = {
    run: run as any,
    team: team as any,
    observer: { emit: vi.fn() } as any,
    engine: {} as any,
  };

  return ctx;
}

describe("triage workflow definition", () => {
  it("has the correct name and step names", () => {
    expect(triage.name).toBe("triage");
    expect(triage.steps.map(s => s.name)).toEqual(["classify", "route", "judge-gate"]);
  });

  it("has correct defaults", () => {
    expect(triage.defaults.maxIterations).toBe(8); // L3 fix: raised from 5 for classify→judge back-loop
    expect(triage.defaults.maxCostUsd).toBe(5);
    expect(triage.defaults.maxWallSeconds).toBe(600);
  });
});

describe("triage transitions", () => {
  it("classify PASS → route", () => {
    const t = triage.transitions.find(
      t => t.from === "classify" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("route");
  });

  it("classify FAIL → halt", () => {
    const t = triage.transitions.find(
      t => t.from === "classify" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("route PASS → judge-gate", () => {
    const t = triage.transitions.find(
      t => t.from === "route" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("route FAIL → halt", () => {
    const t = triage.transitions.find(
      t => t.from === "route" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate PASS → halt", () => {
    const t = triage.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → classify", () => {
    const t = triage.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("classify");
  });
});

describe("triage step execution", () => {
  it("all steps PASS: classify → route → judge-gate each return PASS", async () => {
    const ctx = makeCtxWithVerdicts({});

    const classifyStep = triage.steps.find(s => s.name === "classify")!;
    const routeStep = triage.steps.find(s => s.name === "route")!;
    const judgeGateStep = triage.steps.find(s => s.name === "judge-gate")!;

    const classifyResult = await classifyStep.run(ctx);
    expect(classifyResult.verdict).toBe("PASS");
    expect(classifyResult.success).toBe(true);

    const routeResult = await routeStep.run(ctx);
    expect(routeResult.verdict).toBe("PASS");
    expect(routeResult.success).toBe(true);

    const judgeResult = await judgeGateStep.run(ctx);
    expect(judgeResult.verdict).toBe("PASS");
    expect(judgeResult.success).toBe(true);
  });

  it("classify FAIL → step returns success=false immediately", async () => {
    const ctx = makeCtxWithVerdicts({
      classify: { step: "classify", verdict: "FAIL", issues: ["insufficient bug report"] },
    });

    const classifyStep = triage.steps.find(s => s.name === "classify")!;
    const result = await classifyStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("insufficient bug report");
  });

  it("judge-gate FAIL includes previous feedback in prompt on re-run", async () => {
    const previousFeedback = ["severity should be P0", "wrong owner team"];
    const ctx = makeCtxWithVerdicts(
      {
        "judge-gate": { step: "judge-gate", verdict: "FAIL", issues: previousFeedback },
      },
      [{ name: "judge-gate", issues: previousFeedback }],
    );

    const judgeGateStep = triage.steps.find(s => s.name === "judge-gate")!;
    await judgeGateStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as ReturnType<typeof vi.fn>).mock.calls;
    const judgeDeliverCall = deliverCalls.find(
      ([_agent, msg]: [string, any]) => msg.summary === "Execute step: judge-gate",
    );
    expect(judgeDeliverCall).toBeDefined();
    expect(judgeDeliverCall[1].message).toContain("PREVIOUS FEEDBACK:");
    expect(judgeDeliverCall[1].message).toContain("severity should be P0");
  });

  it("judge-gate FAIL then PASS loop: second run returns PASS", async () => {
    const ctx = makeCtxWithVerdicts(
      {
        "judge-gate": { step: "judge-gate", verdict: "PASS" },
      },
      [{ name: "judge-gate", issues: ["routing was wrong"] }],
    );

    const judgeGateStep = triage.steps.find(s => s.name === "judge-gate")!;
    const result = await judgeGateStep.run(ctx);
    expect(result.verdict).toBe("PASS");
    expect(result.success).toBe(true);
  });
});
