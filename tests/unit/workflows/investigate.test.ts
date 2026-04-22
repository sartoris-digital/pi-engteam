import { describe, it, expect, vi } from "vitest";
import type { StepContext } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { investigate } from "../../../src/workflows/investigate.js";

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
    goal: "test incident",
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

describe("investigate workflow definition", () => {
  it("has the correct name and step names", () => {
    expect(investigate.name).toBe("investigate");
    expect(investigate.steps.map(s => s.name)).toEqual(["gather", "analyze", "judge-gate"]);
  });

  it("has correct defaults", () => {
    expect(investigate.defaults.maxIterations).toBe(6);
    expect(investigate.defaults.maxCostUsd).toBe(15);
    expect(investigate.defaults.maxWallSeconds).toBe(1800);
  });
});

describe("investigate transitions", () => {
  it("gather PASS → analyze", () => {
    const t = investigate.transitions.find(
      t => t.from === "gather" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("analyze");
  });

  it("gather FAIL → halt", () => {
    const t = investigate.transitions.find(
      t => t.from === "gather" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("analyze PASS → judge-gate", () => {
    const t = investigate.transitions.find(
      t => t.from === "analyze" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("analyze FAIL → halt", () => {
    const t = investigate.transitions.find(
      t => t.from === "analyze" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate PASS → halt", () => {
    const t = investigate.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → analyze", () => {
    const t = investigate.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("analyze");
  });
});

describe("investigate step execution", () => {
  it("all steps PASS: gather → analyze → judge-gate each return PASS", async () => {
    const ctx = makeCtxWithVerdicts({});

    const gatherStep = investigate.steps.find(s => s.name === "gather")!;
    const analyzeStep = investigate.steps.find(s => s.name === "analyze")!;
    const judgeGateStep = investigate.steps.find(s => s.name === "judge-gate")!;

    const gatherResult = await gatherStep.run(ctx);
    expect(gatherResult.verdict).toBe("PASS");
    expect(gatherResult.success).toBe(true);

    const analyzeResult = await analyzeStep.run(ctx);
    expect(analyzeResult.verdict).toBe("PASS");
    expect(analyzeResult.success).toBe(true);

    const judgeResult = await judgeGateStep.run(ctx);
    expect(judgeResult.verdict).toBe("PASS");
    expect(judgeResult.success).toBe(true);
  });

  it("gather FAIL → step returns success=false immediately", async () => {
    const ctx = makeCtxWithVerdicts({
      gather: { step: "gather", verdict: "FAIL", issues: ["no logs available"] },
    });

    const gatherStep = investigate.steps.find(s => s.name === "gather")!;
    const result = await gatherStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("no logs available");
  });

  it("analyze stores a stable incident-report artifact key", async () => {
    const ctx = makeCtxWithVerdicts({
      analyze: { step: "analyze", verdict: "PASS", artifacts: ["incident-report.md"] },
    });
    (ctx.run as any).artifacts = { context: "context-pack.md" };

    const analyzeStep = investigate.steps.find(s => s.name === "analyze")!;
    const result = await analyzeStep.run(ctx);
    expect(result.artifacts?.["incident-report"]).toBe("incident-report.md");
  });

  it("judge-gate FAIL includes previous feedback in prompt on re-run", async () => {
    const previousFeedback = ["hypothesis lacks evidence", "missing timeline"];
    const ctx = makeCtxWithVerdicts(
      {
        "judge-gate": { step: "judge-gate", verdict: "FAIL", issues: previousFeedback },
      },
      [{ name: "judge-gate", issues: previousFeedback }],
    );

    (ctx.run as any).artifacts = { "incident-report": "incident-report.md" };

    const judgeGateStep = investigate.steps.find(s => s.name === "judge-gate")!;
    await judgeGateStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as ReturnType<typeof vi.fn>).mock.calls;
    const judgeDeliverCall = deliverCalls.find(
      ([_agent, msg]: [string, any]) => msg.summary === "Execute step: judge-gate",
    );
    expect(judgeDeliverCall).toBeDefined();
    expect(judgeDeliverCall[1].message).toContain("incident-report.md");
    expect(judgeDeliverCall[1].message).toContain("PREVIOUS JUDGE FEEDBACK:");
    expect(judgeDeliverCall[1].message).toContain("hypothesis lacks evidence");
  });

  it("judge-gate FAIL then PASS loop: second run returns PASS", async () => {
    const ctx = makeCtxWithVerdicts(
      {
        "judge-gate": { step: "judge-gate", verdict: "PASS" },
      },
      [{ name: "judge-gate", issues: ["needs more evidence"] }],
    );

    const judgeGateStep = investigate.steps.find(s => s.name === "judge-gate")!;
    const result = await judgeGateStep.run(ctx);
    expect(result.verdict).toBe("PASS");
    expect(result.success).toBe(true);
  });
});
