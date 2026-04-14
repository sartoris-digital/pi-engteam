import { describe, it, expect, vi } from "vitest";
import type { VerdictPayload } from "../../../src/types.js";
import type { StepContext } from "../../../src/workflows/types.js";
import { debug } from "../../../src/workflows/debug.js";

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
    const ctx = makeCtx();
    const gatherStep = debug.steps.find(s => s.name === "gather-context")!;

    const promise = gatherStep.run(ctx);

    // Wait for knowledge-retriever listener
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "gather-context-code",
      ),
    );
    fireVerdict(ctx, "gather-context-code", {
      step: "gather-context-code",
      verdict: "PASS",
      artifacts: ["debug-code-context.md"],
    });
    // Flush microtask queue so the step continuation registers the traces listener
    await Promise.resolve();
    await Promise.resolve();

    // Wait for observability-archivist listener
    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "gather-context-traces",
      ),
    );
    fireVerdict(ctx, "gather-context-traces", {
      step: "gather-context-traces",
      verdict: "PASS",
      artifacts: ["debug-traces.md"],
    });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.artifacts?.["code-context"]).toBe("debug-code-context.md");
    expect(result.artifacts?.["trace-context"]).toBe("debug-traces.md");
  });

  it("FAIL path: knowledge-retriever fails → halt immediately, no observability call", async () => {
    const ctx = makeCtx();
    const gatherStep = debug.steps.find(s => s.name === "gather-context")!;

    const promise = gatherStep.run(ctx);

    await vi.waitFor(() =>
      (ctx.engine as any).registerVerdictListener.mock.calls.some(
        ([_r, s]: [string, string]) => s === "gather-context-code",
      ),
    );
    fireVerdict(ctx, "gather-context-code", {
      step: "gather-context-code",
      verdict: "FAIL",
      issues: ["repo not accessible"],
    });

    const result = await promise;
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
    const ctx = makeCtx({
      artifacts: { "root-cause": "debug-report.md" },
      steps: [
        {
          name: "analyze",
          verdict: "PASS",
          issues: ["null pointer in payment handler at line 42"],
        },
      ],
    });

    const proposeStep = debug.steps.find(s => s.name === "propose-fix")!;
    const promise = proposeStep.run(ctx);

    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "propose-fix", { step: "propose-fix", verdict: "PASS" });
    await promise;

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("null pointer in payment handler at line 42");
    expect(msg).toContain("debug-report.md");
  });
});

describe("debug workflow – judge-gate step injects prior feedback", () => {
  it("includes prior judge feedback in prompt on second iteration", async () => {
    const ctx = makeCtx({
      steps: [
        {
          name: "judge-gate",
          verdict: "FAIL",
          issues: ["option B rollback plan is incomplete"],
        },
      ],
    });

    const judgeStep = debug.steps.find(s => s.name === "judge-gate")!;
    const promise = judgeStep.run(ctx);

    await vi.waitFor(() => (ctx.engine as any).registerVerdictListener.mock.calls.length > 0);
    fireVerdict(ctx, "judge-gate", { step: "judge-gate", verdict: "PASS" });
    await promise;

    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const msg = deliverCalls[0][1].message as string;
    expect(msg).toContain("option B rollback plan is incomplete");
  });
});
