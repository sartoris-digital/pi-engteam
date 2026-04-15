import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ADWEngine } from "../../src/adw/ADWEngine.js";
import { planBuildReview } from "../../src/workflows/plan-build-review.js";
import type { VerdictPayload } from "../../src/types.js";

describe("plan-build-review workflow integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "eng-integ-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("runs plan→build→review to succeeded status when all agents PASS", async () => {
    const mockObserver = { emit: vi.fn() } as any;

    const mockTeam = {
      deliver: vi.fn(),
      setStepContext: vi.fn(),
      markStepComplete: vi.fn(),
    } as any;

    const workflows = new Map([["plan-build-review", planBuildReview]]);

    const engine = new ADWEngine({
      runsDir: tmpDir,
      workflows,
      team: mockTeam,
      observer: mockObserver,
    });

    // When deliver is called, immediately notify the engine with a PASS verdict for that step
    mockTeam.deliver.mockImplementation(async (_agentName: string, msg: any) => {
      const stepName = (msg.summary as string)?.replace("Execute step: ", "") ?? "unknown";
      // Use setImmediate to simulate the async agent responding after the current microtask
      setImmediate(() => {
        engine.notifyVerdict(state.runId, {
          step: stepName,
          verdict: "PASS",
          artifacts: [`${stepName}-output.md`],
        } satisfies VerdictPayload);
      });
    });

    const state = await engine.startRun({
      workflow: "plan-build-review",
      goal: "Add a hello world function",
      budget: { maxIterations: 10, maxCostUsd: 50, maxWallSeconds: 60 },
    });

    const finalState = await engine.executeRun(state.runId);

    expect(finalState.status).toBe("succeeded");
    expect(finalState.steps.length).toBeGreaterThanOrEqual(3);
    expect(finalState.steps.map(s => s.name)).toContain("plan");
    expect(finalState.steps.map(s => s.name)).toContain("build");
    expect(finalState.steps.map(s => s.name)).toContain("review");
  });

  it("halts with failed status when plan step returns FAIL", async () => {
    const mockObserver = { emit: vi.fn() } as any;
    const mockTeam = { deliver: vi.fn(), setStepContext: vi.fn(), markStepComplete: vi.fn() } as any;
    const workflows = new Map([["plan-build-review", planBuildReview]]);

    const engine = new ADWEngine({
      runsDir: tmpDir,
      workflows,
      team: mockTeam,
      observer: mockObserver,
    });

    mockTeam.deliver.mockImplementation(async (_agentName: string, msg: any) => {
      const stepName = (msg.summary as string)?.replace("Execute step: ", "") ?? "unknown";
      setImmediate(() => {
        engine.notifyVerdict(state.runId, {
          step: stepName,
          verdict: "FAIL",
          issues: ["Goal is not feasible"],
        } satisfies VerdictPayload);
      });
    });

    const state = await engine.startRun({
      workflow: "plan-build-review",
      goal: "Do something impossible",
      budget: { maxIterations: 10, maxCostUsd: 50, maxWallSeconds: 60 },
    });

    const finalState = await engine.executeRun(state.runId);

    expect(finalState.status).toBe("failed");
    // Should have stopped after plan — build should never run
    expect(finalState.steps.map(s => s.name)).not.toContain("build");
  });

  it("persists final state to disk after completion", async () => {
    const mockObserver = { emit: vi.fn() } as any;
    const mockTeam = { deliver: vi.fn(), setStepContext: vi.fn(), markStepComplete: vi.fn() } as any;
    const workflows = new Map([["plan-build-review", planBuildReview]]);

    const engine = new ADWEngine({
      runsDir: tmpDir,
      workflows,
      team: mockTeam,
      observer: mockObserver,
    });

    mockTeam.deliver.mockImplementation(async (_agentName: string, msg: any) => {
      const stepName = (msg.summary as string)?.replace("Execute step: ", "") ?? "unknown";
      setImmediate(() => {
        engine.notifyVerdict(state.runId, { step: stepName, verdict: "PASS", artifacts: [] });
      });
    });

    const state = await engine.startRun({
      workflow: "plan-build-review",
      goal: "Persistence test",
      budget: { maxIterations: 10, maxCostUsd: 50, maxWallSeconds: 60 },
    });

    await engine.executeRun(state.runId);

    // Verify state was persisted to disk by loading it independently
    const { loadRunState } = await import("../../src/adw/RunState.js");
    const loaded = await loadRunState(tmpDir, state.runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.runId).toBe(state.runId);
  });
});
