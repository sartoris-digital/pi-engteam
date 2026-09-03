import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../../../src/engine/engine.js";
import { readGeneratedJson, runDirPath } from "../../../src/engine/state.js";
import type { Escalation, Step, Transition } from "../../../src/engine/types.js";
import {
  buildLaneSteps,
  cleanupTmpDirs,
  evalWhenStub,
  makeStep,
  makeWorkflow,
  startParams,
  tmpRunsDir,
} from "./helpers.js";

afterEach(cleanupTmpDirs);

describe("fix rounds", () => {
  it("N forced FAILs at `test` escalate loop-exhausted via the round counter, never the backstop", async () => {
    const runsDir = await tmpRunsDir();
    const log: string[] = [];
    const steps = buildLaneSteps(
      {
        test: async () => {
          log.push("test");
          return { verdict: "FAIL", issues: ["forced failure"] };
        },
      },
      log,
    );
    const workflow = makeWorkflow("chore", steps, { fixRounds: 2, fixTarget: "implement" });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);

    expect(final.status).toBe("failed");
    expect(final.escalation?.code).toBe("loop-exhausted");
    expect(final.rounds["implement"]).toBe(workflow.budget.fixRounds + 1);
    expect(final.iteration).toBeLessThan(final.budget.maxIterations);
    expect(final.escalation?.detail).toContain("fix rounds for 'implement' exhausted");
    expect(final.escalation?.step).toBe("test");
    expect(log.filter((n) => n === "implement")).toHaveLength(workflow.budget.fixRounds + 1);
    expect(log.filter((n) => n === "test")).toHaveLength(workflow.budget.fixRounds + 1);
    expect(log).not.toContain("review");
    expect(log.at(-1)).toBe("escalate");
    expect(final.steps.filter((s) => s.name === "implement").map((s) => s.round)).toEqual([0, 1, 2]);
    expect(final.steps.filter((s) => s.name === "test").map((s) => s.round)).toEqual([0, 1, 2]);
  });

  it("the same holds with fixRounds 4 (feature-sized) — counters first, backstop never", async () => {
    const runsDir = await tmpRunsDir();
    const steps = buildLaneSteps({ judge: async () => ({ verdict: "FAIL", issues: ["AC2 unmet"] }) });
    const workflow = makeWorkflow("feature", steps, { fixRounds: 4, fixTarget: "implement" });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow, { kind: "feature" }));
    const final = await engine.executeRun(run.runId);
    expect(final.escalation?.code).toBe("loop-exhausted");
    expect(final.rounds["implement"]).toBe(5);
    expect(final.iteration).toBeLessThan(final.budget.maxIterations);
    expect(final.escalation?.detail).not.toContain("iteration backstop");
  });

  it("a stage's own maxRounds trips loop-exhausted before the lane fixRounds", async () => {
    const runsDir = await tmpRunsDir();
    const steps = buildLaneSteps({ review: async () => ({ verdict: "FAIL", issues: ["no citation"] }) });
    const review = steps.find((s) => s.name === "review") as Step;
    review.maxRounds = 1;
    const workflow = makeWorkflow("chore", steps, { fixRounds: 5, fixTarget: "implement" });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.escalation?.code).toBe("loop-exhausted");
    expect(final.escalation?.detail).toContain("'review' exceeded maxRounds 1");
    expect(final.rounds).toEqual({ implement: 2, review: 2 });
  });

  it("a PASS-only cycle with no fix-round steps is stopped by the iteration backstop", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [makeStep({ name: "a" }), makeStep({ name: "b" })];
    const transitions: Transition[] = [
      { from: "a", when: () => true, to: "b" },
      { from: "b", when: () => true, to: "a" },
    ];
    const workflow = makeWorkflow("cycle", steps, { transitions });
    expect(workflow.budget.maxIterations).toBe(2 + 2);
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.escalation?.code).toBe("loop-exhausted");
    expect(final.escalation?.detail).toContain("iteration backstop");
    expect(final.iteration).toBe(4);
    expect(final.rounds).toEqual({});
    const onDisk = await readGeneratedJson<Escalation>(join(runDirPath(runsDir, run.runId), "escalation.json"));
    expect(onDisk?.code).toBe("loop-exhausted");
  });

  it("a fix round that then passes clears the way to publish", async () => {
    const runsDir = await tmpRunsDir();
    let testCalls = 0;
    const steps = buildLaneSteps({
      test: async () => {
        testCalls += 1;
        return testCalls === 1 ? { verdict: "FAIL", issues: ["1 failing"] } : { verdict: "PASS" };
      },
    });
    const workflow = makeWorkflow("chore", steps, { fixRounds: 2, fixTarget: "implement" });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("succeeded");
    expect(final.rounds).toEqual({ implement: 1 });
    expect(final.iteration).toBe(9);
  });
});
