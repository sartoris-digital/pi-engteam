import { describe, it, expect, vi } from "vitest";
import type { StepContext } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { docBackfill } from "../../../src/workflows/doc-backfill.js";

function makeCtxWithVerdicts(
  verdicts: Record<string, VerdictPayload>,
  runSteps: Array<{ name: string; issues?: string[]; handoffHint?: string }> = [],
  artifacts: Record<string, string> = {},
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
    goal: "backfill missing JSDoc and READMEs for public APIs",
    artifacts: { ...artifacts } as Record<string, string>,
    steps: runSteps as any[],
  };

  const ctx: StepContext = {
    run: run as any,
    team: team as any,
    observer: { emit: vi.fn() } as any,
    engine: {} as any,
  };

  return ctx;
}

function makePassCtx(): StepContext {
  return makeCtxWithVerdicts({});
}

describe("docBackfill workflow definition", () => {
  it("has the correct name and step names", () => {
    expect(docBackfill.name).toBe("doc-backfill");
    expect(docBackfill.steps.map(s => s.name)).toEqual([
      "audit",
      "plan",
      "write",
      "review",
      "judge-gate",
    ]);
  });

  it("has correct defaults", () => {
    expect(docBackfill.defaults.maxIterations).toBe(7);
    expect(docBackfill.defaults.maxCostUsd).toBe(15);
    expect(docBackfill.defaults.maxWallSeconds).toBe(3600);
  });
});

describe("docBackfill transitions", () => {
  it("audit PASS (gaps found) → plan", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "audit" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("plan");
  });

  it("audit PASS handoffHint=no-docs-needed → halt", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "audit" && t.when({ success: true, verdict: "PASS", handoffHint: "no-docs-needed" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("audit FAIL → halt", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "audit" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("plan PASS → write", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "plan" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("write");
  });

  it("plan FAIL → halt", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "plan" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("write PASS → review", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "write" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("review");
  });

  it("write FAIL → plan (re-plan on write failure)", () => {
    // M3 fix: write failures now loop back to plan so the planner can adjust
    const t = docBackfill.transitions.find(
      t => t.from === "write" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("plan");
  });

  it("review PASS → judge-gate", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "review" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("review FAIL → write", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "review" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("write");
  });

  it("judge-gate PASS → halt", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → write", () => {
    const t = docBackfill.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("write");
  });
});

describe("docBackfill step execution", () => {
  it("PASS path: all steps return PASS", async () => {
    const ctx = makePassCtx();
    for (const step of docBackfill.steps) {
      const result = await step.run(ctx);
      expect(result.verdict).toBe("PASS");
      expect(result.success).toBe(true);
    }
  });

  it("audit PASS with no-docs-needed → halts successfully", async () => {
    const ctx = makeCtxWithVerdicts({
      audit: { step: "audit", verdict: "PASS", handoffHint: "no-docs-needed" },
    });
    const auditStep = docBackfill.steps.find(s => s.name === "audit")!;
    const result = await auditStep.run(ctx);
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.handoffHint).toBe("no-docs-needed");

    const t = docBackfill.transitions.find(
      t => t.from === "audit" && t.when(result),
    );
    expect(t?.to).toBe("halt");
  });

  it("audit FAIL → step returns success=false", async () => {
    const ctx = makeCtxWithVerdicts({
      audit: { step: "audit", verdict: "FAIL", issues: ["could not scan repository"] },
    });
    const auditStep = docBackfill.steps.find(s => s.name === "audit")!;
    const result = await auditStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("could not scan repository");

    const t = docBackfill.transitions.find(
      t => t.from === "audit" && t.when(result),
    );
    expect(t?.to).toBe("halt");
  });

  it("write injects reviewer issues on loops", async () => {
    const ctx = makeCtxWithVerdicts(
      { write: { step: "write", verdict: "PASS" } },
      [{ name: "review", issues: ["@param types wrong in parseConfig", "missing @returns on fetchUser"] }],
    );
    const writeStep = docBackfill.steps.find(s => s.name === "write")!;
    await writeStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as ReturnType<typeof vi.fn>).mock.calls;
    const writeCall = deliverCalls.find(
      ([_agent, msg]: [string, any]) => msg.summary === "Execute step: write",
    );
    expect(writeCall).toBeDefined();
    expect(writeCall[1].message).toContain("@param types wrong in parseConfig");
    expect(writeCall[1].message).toContain("missing @returns on fetchUser");
  });

  it("review FAIL surfaces issues and routes back to write", async () => {
    const ctx = makeCtxWithVerdicts({
      review: {
        step: "review",
        verdict: "FAIL",
        issues: ["fetchUser @returns description is incorrect"],
      },
    });
    const reviewStep = docBackfill.steps.find(s => s.name === "review")!;
    const result = await reviewStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("fetchUser @returns description is incorrect");

    const t = docBackfill.transitions.find(
      t => t.from === "review" && t.when(result),
    );
    expect(t?.to).toBe("write");
  });
});
