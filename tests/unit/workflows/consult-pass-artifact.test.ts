import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildConsultWorkflow } from "../../../src/workflows/consult.js";
import type { StepContext, StepResult, Step } from "../../../src/workflows/types.js";
import type { RunState } from "../../../src/types.js";

async function makeCtx(deliver: any): Promise<StepContext> {
  const runsDir = await mkdtemp(join(tmpdir(), "consult-pass-art-"));
  const runId = "test-run";
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "conversation.jsonl"), "");
  const run: RunState = {
    runId,
    workflow: "consult",
    goal: "test goal",
    status: "running",
    currentStep: "position-eng",
    iteration: 1,
    budget: {
      maxIterations: 10,
      maxCostUsd: 25,
      maxWallSeconds: 1800,
      maxTokens: 1_000_000,
      spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
    },
    steps: [],
    artifacts: {},
    approvals: [],
    planMode: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    run,
    team: { deliver } as any,
    observer: { emit: vi.fn() } as any,
    engine: { getRunsDir: () => runsDir } as any,
  };
}

describe("consult PASS-without-artifact downgrade — Phase 6 round-4 M1", () => {
  it("position step downgrades PASS-without-artifact to FAIL", async () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 1);
    const posEng = wf.steps.find((s) => s.name === "position-eng") as Step;
    expect(posEng).toBeDefined();
    // Mock team.deliver to return PASS with no artifacts.
    const deliver = vi.fn(async () => ({
      step: "position-eng",
      verdict: "PASS",
      issues: [],
      artifacts: [], // empty!
    }));
    const ctx = await makeCtx(deliver);
    const result: StepResult = await posEng.run(ctx);
    expect(result.verdict).toBe("FAIL");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no artifact path/i);
  });

  it("adversarial step downgrades PASS-without-artifact to FAIL", async () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 1);
    const advEng = wf.steps.find((s) => s.name === "adversarial-eng") as Step;
    expect(advEng).toBeDefined();
    const deliver = vi.fn(async () => ({
      step: "adversarial-eng",
      verdict: "PASS",
      issues: [],
      artifacts: undefined, // missing!
    }));
    const ctx = await makeCtx(deliver);
    // Seed prior-round position artifacts so the step proceeds past the
    // "all positions missing" early-FAIL.
    ctx.run.artifacts = {
      "position-eng": "<run>/positions/engineering-lead.md",
      "position-valid": "<run>/positions/validation-lead.md",
      "position-invest": "<run>/positions/investigation-lead.md",
    };
    const result: StepResult = await advEng.run(ctx);
    expect(result.verdict).toBe("FAIL");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no artifact path/i);
  });

  it("synthesis step downgrades PASS-without-artifact to FAIL", async () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 1);
    const synth = wf.steps.find((s) => s.name === "synthesis") as Step;
    expect(synth).toBeDefined();
    const deliver = vi.fn(async () => ({
      step: "synthesis",
      verdict: "PASS",
      issues: [],
      artifacts: [],
    }));
    const ctx = await makeCtx(deliver);
    const result: StepResult = await synth.run(ctx);
    expect(result.verdict).toBe("FAIL");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no artifact path/i);
  });

  it("position step PASSes when verdict.artifacts has a path", async () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 1);
    const posEng = wf.steps.find((s) => s.name === "position-eng") as Step;
    const deliver = vi.fn(async () => ({
      step: "position-eng",
      verdict: "PASS",
      issues: [],
      artifacts: ["positions/engineering-lead.md"],
    }));
    const ctx = await makeCtx(deliver);
    const result: StepResult = await posEng.run(ctx);
    expect(result.verdict).toBe("PASS");
    expect(result.success).toBe(true);
    expect(result.artifacts).toEqual({ "position-eng": "positions/engineering-lead.md" });
  });
});
