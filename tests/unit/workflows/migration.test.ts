import { describe, it, expect, vi } from "vitest";
import type { StepContext } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { migration } from "../../../src/workflows/migration.js";

function makeCtxWithVerdicts(
  verdicts: Record<string, VerdictPayload>,
  runSteps: Array<{ name: string; issues?: string[]; handoffHint?: string }> = [],
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
    goal: "add user_preferences table",
    artifacts: {} as Record<string, string>,
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

describe("migration workflow definition", () => {
  it("has the correct name and step names", () => {
    expect(migration.name).toBe("migration");
    expect(migration.steps.map(s => s.name)).toEqual([
      "plan",
      "security-review",
      "implement",
      "test",
      "judge-gate",
    ]);
  });

  it("has correct defaults", () => {
    expect(migration.defaults.maxIterations).toBe(8);
    expect(migration.defaults.maxCostUsd).toBe(25);
    expect(migration.defaults.maxWallSeconds).toBe(3600);
  });
});

describe("migration transitions", () => {
  it("plan PASS → security-review", () => {
    const t = migration.transitions.find(
      t => t.from === "plan" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("security-review");
  });

  it("plan FAIL → halt", () => {
    const t = migration.transitions.find(
      t => t.from === "plan" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("security-review PASS → implement", () => {
    const t = migration.transitions.find(
      t => t.from === "security-review" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("security-review FAIL → plan", () => {
    const t = migration.transitions.find(
      t => t.from === "security-review" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("plan");
  });

  it("implement PASS → test", () => {
    const t = migration.transitions.find(
      t => t.from === "implement" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("test");
  });

  it("implement FAIL → halt", () => {
    const t = migration.transitions.find(
      t => t.from === "implement" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("test PASS → judge-gate", () => {
    const t = migration.transitions.find(
      t => t.from === "test" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("test FAIL → implement", () => {
    const t = migration.transitions.find(
      t => t.from === "test" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("judge-gate PASS → halt", () => {
    const t = migration.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → plan", () => {
    const t = migration.transitions.find(
      t => t.from === "judge-gate" && t.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("plan");
  });
});

describe("migration step execution", () => {
  it("PASS path: all steps return PASS", async () => {
    const ctx = makePassCtx();
    for (const step of migration.steps) {
      const result = await step.run(ctx);
      expect(result.verdict).toBe("PASS");
      expect(result.success).toBe(true);
    }
  });

  it("plan FAIL → step returns success=false with issues", async () => {
    const ctx = makeCtxWithVerdicts({
      plan: { step: "plan", verdict: "FAIL", issues: ["schema change not feasible"] },
    });
    const planStep = migration.steps.find(s => s.name === "plan")!;
    const result = await planStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("schema change not feasible");
  });

  it("security-review FAIL loops back: step returns FAIL with issues", async () => {
    const ctx = makeCtxWithVerdicts({
      "security-review": {
        step: "security-review",
        verdict: "FAIL",
        issues: ["unsafe column drop without backup", "PII column unencrypted"],
      },
    });
    const secReviewStep = migration.steps.find(s => s.name === "security-review")!;
    const result = await secReviewStep.run(ctx);
    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("unsafe column drop without backup");
    expect(result.issues).toContain("PII column unencrypted");

    // Verify the transition routes back to plan
    const t = migration.transitions.find(
      t => t.from === "security-review" && t.when(result),
    );
    expect(t?.to).toBe("plan");
  });

  it("plan injects security-review feedback on re-plan", async () => {
    const ctx = makeCtxWithVerdicts(
      { plan: { step: "plan", verdict: "PASS" } },
      [{ name: "security-review", issues: ["privilege escalation risk", "missing rollback"] }],
    );
    const planStep = migration.steps.find(s => s.name === "plan")!;
    await planStep.run(ctx);

    const deliverCalls = (ctx.team.deliver as ReturnType<typeof vi.fn>).mock.calls;
    const planCall = deliverCalls.find(
      ([_agent, msg]: [string, any]) => msg.summary === "Execute step: plan",
    );
    expect(planCall).toBeDefined();
    expect(planCall[1].message).toContain("privilege escalation risk");
    expect(planCall[1].message).toContain("missing rollback");
  });
});
