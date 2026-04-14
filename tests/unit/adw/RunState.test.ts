import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRunState, saveRunState, loadRunState, updateStep } from "../../../src/adw/RunState.js";
import type { RunState } from "../../../src/types.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "runstate-test-"));
}

describe("RunState", () => {
  it("createRunState sets correct defaults", async () => {
    const state = await createRunState({
      runId: "run-1",
      workflow: "plan-build-review",
      goal: "Add login feature",
      budget: { maxIterations: 5 },
    });
    expect(state.runId).toBe("run-1");
    expect(state.status).toBe("pending");
    expect(state.iteration).toBe(0);
    expect(state.planMode).toBe(true);
    expect(state.budget.maxIterations).toBe(5);
    expect(state.budget.maxCostUsd).toBe(20);
    expect(state.budget.spent.costUsd).toBe(0);
    expect(state.steps).toEqual([]);
    expect(state.artifacts).toEqual({});
  });

  it("saveRunState writes JSON to state.json", async () => {
    const dir = await makeTmpDir();
    const state = await createRunState({
      runId: "run-save",
      workflow: "plan-build-review",
      goal: "Test save",
      budget: {},
    });
    await saveRunState(dir, state);
    const raw = await readFile(join(dir, "run-save", "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.runId).toBe("run-save");
  });

  it("saveRunState writes atomically (via .tmp rename)", async () => {
    const dir = await makeTmpDir();
    const state = await createRunState({
      runId: "run-atomic",
      workflow: "plan-build-review",
      goal: "Atomic write test",
      budget: {},
    });
    await saveRunState(dir, state);
    const { access } = await import("fs/promises");
    const tmpExists = await access(join(dir, "run-atomic", "state.json.tmp"))
      .then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);
  });

  it("loadRunState returns null for missing run", async () => {
    const dir = await makeTmpDir();
    const result = await loadRunState(dir, "nonexistent");
    expect(result).toBeNull();
  });

  it("saveRunState + loadRunState round-trips", async () => {
    const dir = await makeTmpDir();
    const state = await createRunState({
      runId: "run-rt",
      workflow: "plan-build-review",
      goal: "Round trip",
      budget: { maxCostUsd: 15 },
    });
    await saveRunState(dir, state);
    const loaded = await loadRunState(dir, "run-rt");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("run-rt");
    expect(loaded!.budget.maxCostUsd).toBe(15);
  });

  it("updateStep adds new step record", () => {
    const state: RunState = {
      runId: "r", workflow: "w", goal: "g",
      status: "running", currentStep: "plan",
      iteration: 0,
      budget: { maxIterations: 8, maxCostUsd: 20, maxWallSeconds: 3600, maxTokens: 1000000, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
      steps: [],
      artifacts: {},
      approvals: [],
      planMode: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = updateStep(state, "plan", { verdict: "PASS", endedAt: new Date().toISOString() });
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0].name).toBe("plan");
    expect(updated.steps[0].verdict).toBe("PASS");
  });

  it("updateStep updates existing step record", () => {
    const baseState: RunState = {
      runId: "r", workflow: "w", goal: "g",
      status: "running", currentStep: "plan",
      iteration: 0,
      budget: { maxIterations: 8, maxCostUsd: 20, maxWallSeconds: 3600, maxTokens: 1000000, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
      steps: [{ name: "plan", startedAt: new Date().toISOString() }],
      artifacts: {},
      approvals: [],
      planMode: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = updateStep(baseState, "plan", { verdict: "PASS" });
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0].verdict).toBe("PASS");
  });
});
