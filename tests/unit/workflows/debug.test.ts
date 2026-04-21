import { describe, it, expect, vi } from "vitest";
import type { VerdictPayload } from "../../../src/types.js";
import type { StepContext } from "../../../src/workflows/types.js";
import { debug } from "../../../src/workflows/debug.js";

function makeCtx(
  verdicts: Record<string, VerdictPayload> = {},
  overrides?: Partial<StepContext["run"]>,
): StepContext {
  const team = {
    deliver: vi.fn(async (agentName: string, msg: any) => {
      // H4 fix: look up by agentName first (for multi-agent steps like gather-context),
      // then fall back to the step name extracted from the message summary.
      if (verdicts[agentName]) return verdicts[agentName];
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
      runId: "run-debug-1",
      workflow: "debug",
      goal: "Debug the crash in payment service",
      status: "running",
      currentStep: "gather-context",
      iteration: 0,
      budget: {
        maxIterations: 6,
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
    engine: {} as any,
  };

  return ctx;
}

describe("debug workflow – structure", () => {
  it("has correct name and step count", () => {
    expect(debug.name).toBe("debug");
    expect(debug.steps).toHaveLength(4);
    expect(debug.steps.map(s => s.name)).toEqual([
      "gather-context", "analyze", "propose-fix", "judge-gate",
    ]);
  });

  it("defaults are set correctly", () => {
    expect(debug.defaults.maxIterations).toBe(6);
    expect(debug.defaults.maxCostUsd).toBe(20);
    expect(debug.defaults.maxWallSeconds).toBe(3600);
  });
});

describe("debug workflow – gather-context step", () => {
  it("PASS path: both sub-agents pass → success with artifacts", async () => {
    // H4 fix: key verdicts by agentName since both calls now use step="gather-context"
    const ctx = makeCtx({
      "knowledge-retriever": { step: "gather-context", verdict: "PASS", artifacts: ["debug-code-context.md"] },
      "observability-archivist": { step: "gather-context", verdict: "PASS", artifacts: ["debug-traces.md"] },
    });
    const gatherStep = debug.steps.find(s => s.name === "gather-context")!;

    const result = await gatherStep.run(ctx);
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.artifacts?.["code-context"]).toBe("debug-code-context.md");
    expect(result.artifacts?.["trace-context"]).toBe("debug-traces.md");
  });

  it("FAIL path: knowledge-retriever fails → halt immediately, no observability call", async () => {
    // H4 fix: key by agentName
    const ctx = makeCtx({
      "knowledge-retriever": { step: "gather-context", verdict: "FAIL", issues: ["repo not accessible"] },
    });
    const gatherStep = debug.steps.find(s => s.name === "gather-context")!;

    const result = await gatherStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");

    // observability-archivist should NOT have been called
    const deliverCalls = (ctx.team.deliver as any).mock.calls as Array<[string, unknown]>;
    const archivistCalls = deliverCalls.filter(([agent]) => agent === "observability-archivist");
    expect(archivistCalls).toHaveLength(0);
  });
});

describe("debug workflow – transitions", () => {
  it("gather-context PASS → analyze", () => {
    const t = debug.transitions.find(tr => tr.from === "gather-context" && tr.to === "analyze")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("gather-context FAIL → halt", () => {
    const t = debug.transitions.find(tr => tr.from === "gather-context" && tr.to === "halt")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("analyze PASS → propose-fix", () => {
    const t = debug.transitions.find(tr => tr.from === "analyze" && tr.to === "propose-fix")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("analyze FAIL → halt", () => {
    const t = debug.transitions.find(tr => tr.from === "analyze" && tr.to === "halt")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("propose-fix PASS → judge-gate", () => {
    const t = debug.transitions.find(tr => tr.from === "propose-fix" && tr.to === "judge-gate")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("propose-fix FAIL → analyze", () => {
    const t = debug.transitions.find(tr => tr.from === "propose-fix" && tr.to === "analyze")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });

  it("judge-gate PASS → halt", () => {
    const t = debug.transitions.find(tr => tr.from === "judge-gate" && tr.to === "halt")!;
    expect(t.when({ success: true, verdict: "PASS" })).toBe(true);
  });

  it("judge-gate FAIL → analyze", () => {
    const t = debug.transitions.find(tr => tr.from === "judge-gate" && tr.to === "analyze")!;
    expect(t.when({ success: false, verdict: "FAIL" })).toBe(true);
  });
});

describe("debug workflow – propose-fix step injects analysis notes", () => {
  it("includes analysis issues in prompt when present", async () => {
    const ctx = makeCtx(
      { "propose-fix": { step: "propose-fix", verdict: "PASS" } },
      {
        artifacts: { "root-cause": "debug-report.md" },
        steps: [
          {
            name: "analyze",
            verdict: "PASS",
            issues: ["null pointer in payment handler at line 42"],
          },
        ],
      },
    );

    const proposeStep = debug.steps.find(s => s.name === "propose-fix")!;
    await proposeStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("null pointer in payment handler at line 42");
    expect(msg).toContain("debug-report.md");
  });
});

describe("debug workflow – judge-gate step injects prior feedback", () => {
  it("includes prior judge feedback in prompt on second iteration", async () => {
    const ctx = makeCtx(
      { "judge-gate": { step: "judge-gate", verdict: "PASS" } },
      {
        steps: [
          {
            name: "judge-gate",
            verdict: "FAIL",
            issues: ["option B rollback plan is incomplete"],
          },
        ],
      },
    );

    const judgeStep = debug.steps.find(s => s.name === "judge-gate")!;
    await judgeStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("option B rollback plan is incomplete");
  });
});
