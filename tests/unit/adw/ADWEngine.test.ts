import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ADWEngine } from "../../../src/adw/ADWEngine.js";
import { loadRunState } from "../../../src/adw/RunState.js";
import type { Workflow, Step, StepContext, StepResult } from "../../../src/workflows/types.js";
import type { RunState } from "../../../src/types.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "engine-test-"));
}

function makePassStep(name: string): Step {
  return {
    name,
    required: true,
    run: async (_ctx: StepContext): Promise<StepResult> => ({
      success: true,
      verdict: "PASS",
    }),
  };
}

function makeFailStep(name: string, failCount: number): Step {
  let calls = 0;
  return {
    name,
    required: true,
    run: async (_ctx: StepContext): Promise<StepResult> => {
      calls++;
      if (calls <= failCount) {
        return { success: false, verdict: "FAIL", issues: ["test failure"] };
      }
      return { success: true, verdict: "PASS" };
    },
  };
}

function makeWorkflow(steps: Step[]): Workflow {
  const transitions = steps.map((s, i) => ({
    from: s.name,
    when: (r: StepResult) => r.verdict === "PASS",
    to: steps[i + 1]?.name ?? "halt",
  }));
  const failTransitions = steps.map(s => ({
    from: s.name,
    when: (r: StepResult) => r.verdict !== "PASS",
    to: "halt" as const,
  }));
  return {
    name: "test-workflow",
    description: "Test workflow",
    steps,
    transitions: [...transitions, ...failTransitions],
    defaults: { maxIterations: 8, maxCostUsd: 20 },
  };
}

function makeMockTeam() {
  return {
    ensureTeammate: vi.fn(),
    ensureAllTeammates: vi.fn(),
    deliver: vi.fn(),
    disposeAll: vi.fn(),
  } as any;
}

function makeMockObserver() {
  return {
    emit: vi.fn(),
    subscribeToSession: vi.fn(() => () => {}),
    subscribeToBus: vi.fn(() => () => {}),
  } as any;
}

describe("ADWEngine", () => {
  it("single PASS step → status succeeded", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("plan");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({ workflow: "test-workflow", goal: "test goal", budget: {} });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("succeeded");
  });

  it("FAIL step → status failed", async () => {
    const dir = await makeTmpDir();
    const step = makeFailStep("plan", 99);
    const workflow: Workflow = {
      name: "test-workflow",
      description: "test",
      steps: [step],
      transitions: [
        { from: "plan", when: (r) => r.verdict !== "PASS", to: "halt" },
      ],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({ workflow: "test-workflow", goal: "test", budget: {} });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
  });

  it("budget exhausted → status failed", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("plan");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({
      workflow: "test-workflow",
      goal: "test",
      budget: { maxIterations: 0 },
    });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
  });

  it("resumeRun loads state from disk and continues", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("plan");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({ workflow: "test-workflow", goal: "test", budget: {} });
    const { saveRunState } = await import("../../../src/adw/RunState.js");
    await saveRunState(dir, { ...run, status: "running" });
    const final = await engine.resumeRun(run.runId);
    expect(final.status).toBe("succeeded");
  });

  it("step with pauseAfter causes executeRun to return waiting_user", async () => {
    const dir = await makeTmpDir();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

    const pausingStep: Step = {
      name: "discover",
      required: true,
      pauseAfter: "answering",
      run: async (): Promise<StepResult> => ({ success: true, verdict: "PASS" }),
    };
    const nextStep = makePassStep("design");
    const workflow: Workflow = {
      name: "test-workflow",
      description: "test",
      steps: [pausingStep, nextStep],
      transitions: [
        { from: "discover", when: (r) => r.verdict === "PASS", to: "design" },
        { from: "discover", when: (r) => r.verdict !== "PASS", to: "halt" },
        { from: "design",   when: (_r) => true,                 to: "halt" },
      ],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });

    const run = await engine.startRun({ workflow: "test-workflow", goal: "test goal", budget: {} });
    const state = await engine.executeRun(run.runId);

    expect(state.status).toBe("waiting_user");
    expect(state.currentStep).toBe("design");

    cwdSpy.mockRestore();
  });

  it("executeUntilPause resumes from waiting_user and runs to completion", async () => {
    const dir = await makeTmpDir();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

    const step1: Step = {
      name: "s1",
      required: true,
      pauseAfter: "approving",
      run: async (): Promise<StepResult> => ({ success: true, verdict: "PASS" }),
    };
    const step2 = makePassStep("s2");
    const workflow: Workflow = {
      name: "test-workflow",
      description: "test",
      steps: [step1, step2],
      transitions: [
        { from: "s1", when: (r) => r.verdict === "PASS", to: "s2" },
        { from: "s1", when: (r) => r.verdict !== "PASS", to: "halt" },
        { from: "s2", when: (_r) => true, to: "halt" },
      ],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });

    const run = await engine.startRun({ workflow: "test-workflow", goal: "test", budget: {} });
    const paused = await engine.executeRun(run.runId);
    expect(paused.status).toBe("waiting_user");

    const final = await engine.executeUntilPause(run.runId);
    expect(final.status).toBe("succeeded");

    cwdSpy.mockRestore();
  });
});
