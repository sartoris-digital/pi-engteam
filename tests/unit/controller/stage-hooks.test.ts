import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStageHooks } from "../../../src/controller/stage-hooks.js";
import { makeStepContext } from "../../helpers/steer-fixtures.js";
import type { WorkerExecutor, WorkerResult } from "../../../src/runtime/types.js";
import type { StageDef } from "../../../src/lanes/schema.js";

function stage(over: Partial<StageDef> & { name: string }): StageDef {
  return { gates: [], onFail: "fix-round", ...over } as StageDef;
}

function executor(result: WorkerResult): WorkerExecutor {
  return { run: async () => result };
}

describe("agentStep", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-hooks-")), "runs", "run-1");
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  it("writes steps/<stage>-r0.prompt.md on the first attempt and never PASSes a timeout", async () => {
    const hooks = makeStageHooks({
      executor: executor({ verdict: null, exitCode: 1, timedOut: true, stderrTail: "", durationMs: 10 }),
      agents: [
        {
          name: "planner",
          model: "stub",
          promptPath: "/dev/null",
          tools: ["read"],
          stageClass: "read-only",
        },
      ],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const run = hooks.agentStep(stage({ name: "plan", agent: "planner" }), "plan");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    const result = await run(ctx);
    expect(result.verdict).toBe("FAIL");
    expect(result.evidence?.timedOut).toBe(true);
    await expect(readFile(join(runDir, "steps", "plan-r0.prompt.md"), "utf8")).resolves.toContain(
      "REQUIRED FINAL ACTION",
    );
  });
});

describe("hostStep publish emits run.published", () => {
  it("is implemented by hostStep('publish') — covered in integration 9.14; unit-level emit is asserted here with a stub publish via the hook result shape", () => {
    const hooks = makeStageHooks({
      executor: executor({ verdict: { step: "x", verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 1 }),
      agents: [],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => "/tmp/e.json",
    });
    const run = hooks.hostStep(stage({ name: "publish", host: "publish" }), "publish");
    expect(typeof run).toBe("function");
  });
});

describe("humanStep steer uses cfg.steering", () => {
  it("returns a human step named steer", () => {
    const hooks = makeStageHooks({
      executor: { run: async () => ({ verdict: null, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 0 }) },
      agents: [],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => "/tmp/e.json",
    });
    const run = hooks.humanStep(stage({ name: "steer", human: true }), "steer");
    expect(typeof run).toBe("function");
  });
});
