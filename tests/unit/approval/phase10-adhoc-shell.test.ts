// tests/unit/approval/phase10-adhoc-shell.test.ts
//
// PLAN.md ApprovalWatcher Phase 10 — adhoc-shell workflow.
//
// The workflow exposes a single "open" step that returns
// pauseForUser, transitioning ADWEngine to waiting_user and stamping
// state.pauseForUser. The hold expiry is surfaced as an artifact.

import { describe, it, expect } from "vitest";
import { adhocShell } from "../../../src/workflows/adhoc-shell.js";
import type { StepContext } from "../../../src/workflows/types.js";
import type { RunState } from "../../../src/types.js";

function makeCtx(): StepContext {
  return {
    run: {
      runId: "adhoc-test-1",
      workflow: "adhoc-shell",
      goal: "ad-hoc operator session",
      status: "running",
      currentStep: "open",
      iteration: 0,
      budget: { maxIterations: 1, maxCostUsd: 0, maxWallSeconds: 86_400, maxTokens: 0, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
      steps: [],
      artifacts: {},
      approvals: [],
      planMode: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as RunState,
    // Test exercises only the step.run return value; team/observer/engine
    // are not touched by the open step.
    team: undefined as unknown as StepContext["team"],
    observer: undefined as unknown as StepContext["observer"],
    engine: undefined as unknown as StepContext["engine"],
  };
}

describe("ApprovalWatcher Phase 10 — adhoc-shell workflow", () => {
  it("declares one step, transitions to halt on any verdict", () => {
    expect(adhocShell.name).toBe("adhoc-shell");
    expect(adhocShell.steps).toHaveLength(1);
    expect(adhocShell.steps[0].name).toBe("open");
    expect(adhocShell.transitions[0].from).toBe("open");
    expect(adhocShell.transitions[0].to).toBe("halt");
  });

  it("open step returns pauseForUser with a reason citing the run + expiry", async () => {
    const ctx = makeCtx();
    const result = await adhocShell.steps[0].run(ctx);
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.pauseForUser).toBeTruthy();
    expect(result.pauseForUser?.reason).toContain("adhoc-shell open");
    expect(result.pauseForUser?.reason).toContain("/run-resume to close");
    expect(result.pauseForUser?.reason).toContain(ctx.run.runId);
  });

  it("open step emits adhoc-hold-expires-at artifact (ISO timestamp ~now+8h)", async () => {
    const ctx = makeCtx();
    const before = Date.now();
    const result = await adhocShell.steps[0].run(ctx);
    const after = Date.now();
    expect(result.artifacts).toBeTruthy();
    const expiryIso = result.artifacts?.["adhoc-hold-expires-at"];
    expect(typeof expiryIso).toBe("string");
    if (!expiryIso) return;
    const expiryMs = Date.parse(expiryIso);
    const eightHours = 8 * 3600 * 1000;
    // Allow a 5s wall-clock tolerance.
    expect(expiryMs).toBeGreaterThanOrEqual(before + eightHours - 5_000);
    expect(expiryMs).toBeLessThanOrEqual(after + eightHours + 5_000);
  });

  it("workflow defaults bound the adhoc session to 24h wall time", () => {
    expect(adhocShell.defaults.maxWallSeconds).toBe(86_400);
    expect(adhocShell.defaults.maxIterations).toBe(1);
  });
});
