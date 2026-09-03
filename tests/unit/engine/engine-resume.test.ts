import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine, EngineError } from "../../../src/engine/engine.js";
import { readEvidence, verifyEvidence } from "../../../src/engine/evidence.js";
import { loadRunState, readRunSecret, runDirPath } from "../../../src/engine/state.js";
import type { SteerDecision } from "../../../src/steer/dialog.js";
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

/** A steer step that pauses until the engine hands it a resume decision. */
function pausingSteer(seen: SteerDecision[] = []) {
  return makeStep({ name: "steer", kind: "human", onFail: "escalate:needs-decision" }, async (ctx) => {
    const decision = ctx.state.resumeDecision;
    if (!decision) return { verdict: "PASS", pauseForUser: { reason: "steer", packetPath: join(ctx.runDir, "steer-packet.md") } };
    seen.push(decision);
    return { verdict: "PASS" };
  });
}

describe("Engine.resumeRun", () => {
  it("excludes paused time from wallSecondsUsed and hands the decision to the step", async () => {
    const runsDir = await tmpRunsDir();
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const seen: SteerDecision[] = [];
    const steps = [
      makeStep({ name: "plan", kind: "agent", agent: "planner" }, async () => {
        clock += 1_000;
        return { verdict: "PASS" };
      }),
      pausingSteer(seen),
      makeStep({ name: "implement", kind: "agent", agent: "implementer" }, async () => {
        clock += 1_000;
        return { verdict: "PASS" };
      }),
    ];
    const workflow = makeWorkflow("wall", steps, { maxWallSeconds: 60 });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub, now });
    const run = await engine.startRun(startParams(workflow));

    const paused = await engine.executeRun(run.runId);
    expect(paused.status).toBe("waiting_user");
    expect(paused.wallSecondsUsed).toBeCloseTo(1, 6);

    clock += 10_000_000; // ~2.8 h waiting for the operator — must not count
    const done = await engine.resumeRun(run.runId, { decision: { action: "approve", notes: "ship it" } });
    expect(done.status).toBe("succeeded");
    expect(done.escalation).toBeUndefined();
    expect(done.wallSecondsUsed).toBeCloseTo(2, 6);
    expect(done.pauseForUser).toBeUndefined();
    expect(seen).toEqual([{ action: "approve", notes: "ship it" }]);
    expect(done.steps.map((s) => [s.name, s.round])).toEqual([["plan", 0], ["steer", 0], ["steer", 1], ["implement", 0]]);

    // The engine persists no steer-decision artifact: src/steer/stage.ts owns that file.
    expect(done.resumeDecision).toBeUndefined();
    expect(done.artifacts["steer-decision"]).toBeUndefined();
    const runDir = runDirPath(runsDir, run.runId);
    expect((await verifyEvidence(runDir, "steer", 1, await readRunSecret(runDir))).ok).toBe(true);
  });

  it("a run whose steps outlive maxWallSeconds escalates budget-exhausted, not loop-exhausted", async () => {
    const runsDir = await tmpRunsDir();
    let clock = 0;
    const log: string[] = [];
    const steps = buildLaneSteps(
      {
        implement: async () => {
          log.push("implement");
          clock += 100_000; // 100 s of wall in one step
          return { verdict: "PASS" };
        },
      },
      log,
    );
    const workflow = makeWorkflow("chore", steps, { fixRounds: 2, fixTarget: "implement", maxWallSeconds: 60 });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub, now: () => clock });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.escalation?.code).toBe("budget-exhausted");
    expect(final.escalation?.detail).toContain("wall");
    expect(final.rounds).toEqual({});
    expect(log).toEqual(["plan", "gate", "steer", "implement", "escalate"]); // the terminal step still runs
    expect(final.wallSecondsUsed).toBeCloseTo(100, 6);
  });

  it("accumulated step cost over maxCostUsd escalates budget-exhausted", async () => {
    const runsDir = await tmpRunsDir();
    const steps = buildLaneSteps({
      plan: async () => ({ verdict: "PASS", costUsd: 5 }),
      gate: async () => ({ verdict: "PASS", costUsd: 4 }),
    });
    const workflow = makeWorkflow("chore", steps, { fixRounds: 2, fixTarget: "implement", maxCostUsd: 8 });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.costUsd).toBe(9);
    expect(final.escalation?.code).toBe("budget-exhausted");
    expect(final.escalation?.detail).toContain("cost");
    expect(final.steps.map((s) => s.name)).toEqual(["plan", "gate", "escalate"]);
  });

  it("a final step that exceeds maxWallSeconds is budget-exhausted, not succeeded", async () => {
    const runsDir = await tmpRunsDir();
    let clock = 0;
    const steps = [
      makeStep({ name: "publish", host: "publish" }, async () => {
        clock += 100_000;
        return { verdict: "PASS" };
      }),
    ];
    const workflow = makeWorkflow("one", steps, { maxWallSeconds: 60 });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub, now: () => clock });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.escalation?.code).toBe("budget-exhausted");
    expect(final.escalation?.detail).toContain("wall");
    expect(final.wallSecondsUsed).toBeCloseTo(100, 6);
  });

  it("a final step that exceeds maxCostUsd is budget-exhausted, not succeeded", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [makeStep({ name: "publish", host: "publish" }, async () => ({ verdict: "PASS", costUsd: 9 }))];
    const workflow = makeWorkflow("one", steps, { maxCostUsd: 8 });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.costUsd).toBe(9);
    expect(final.escalation?.code).toBe("budget-exhausted");
    expect(final.escalation?.detail).toContain("cost");
  });

  it("consumes resumeDecision on disk before the step so a crash cannot replay it", async () => {
    const runsDir = await tmpRunsDir();
    const seen: Array<SteerDecision | undefined> = [];
    const diskDuringStep: Array<SteerDecision | undefined> = [];
    const steps = [
      makeStep({ name: "steer", kind: "human", onFail: "escalate:needs-decision" }, async (ctx) => {
        seen.push(ctx.state.resumeDecision);
        diskDuringStep.push((await loadRunState(runsDir, ctx.state.runId))?.resumeDecision);
        if (!ctx.state.resumeDecision) {
          return { verdict: "PASS", pauseForUser: { reason: "steer", packetPath: join(ctx.runDir, "steer-packet.md") } };
        }
        return { verdict: "PASS", commit: { message: "steer: checkpoint" } };
      }),
      makeStep({ name: "implement", kind: "agent", agent: "implementer" }),
    ];
    let crashOnce = true;
    const engine = new Engine({
      runsDir,
      evalWhen: evalWhenStub,
      checkpoint: async () => {
        if (crashOnce) {
          crashOnce = false;
          throw new Error("crash after step");
        }
        return null;
      },
    });
    const run = await engine.startRun(startParams(makeWorkflow("steer", steps)));
    expect((await engine.executeRun(run.runId)).status).toBe("waiting_user");

    await expect(engine.resumeRun(run.runId, { decision: { action: "approve", notes: "ship it" } })).rejects.toThrow(
      /crash after step/,
    );
    expect(seen.filter((d) => d?.action === "approve")).toHaveLength(1);
    expect(diskDuringStep[1]).toBeUndefined();
    expect((await loadRunState(runsDir, run.runId))?.resumeDecision).toBeUndefined();

    const recovered = await engine.executeRun(run.runId);
    expect(recovered.status).toBe("waiting_user");
    expect(seen.filter((d) => d?.action === "approve")).toHaveLength(1);
    expect(seen[2]).toBeUndefined();
    expect(recovered.resumeDecision).toBeUndefined();
  });

  it("resumes a failed run from a named step, clearing the escalation and resetting one round", async () => {
    const runsDir = await tmpRunsDir();
    let testCalls = 0;
    const steps = buildLaneSteps({
      test: async () => {
        testCalls += 1;
        return testCalls <= 3 ? { verdict: "FAIL", issues: ["red"] } : { verdict: "PASS" };
      },
    });
    const workflow = makeWorkflow("chore", steps, { fixRounds: 2, fixTarget: "implement" });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(workflow));
    const failed = await engine.executeRun(run.runId);
    expect(failed.escalation?.code).toBe("loop-exhausted");
    expect(failed.rounds["implement"]).toBe(3);

    await expect(engine.resumeRun(run.runId)).rejects.toThrow(/pass fromStep/);
    const resumed = await engine.resumeRun(run.runId, { fromStep: "test", resetRounds: ["implement"] });
    expect(resumed.status).toBe("succeeded");
    expect(resumed.escalation).toBeUndefined();
    expect(resumed.rounds["implement"]).toBe(2);
    expect(resumed.steps.map((s) => s.name).slice(-4)).toEqual(["test", "review", "judge", "publish"]);
    expect((await readEvidence(runDirPath(runsDir, run.runId), "test"))?.round).toBe(3);
  });

  it("refuses to resume a succeeded run, an unknown step, or an unregistered workflow", async () => {
    const runsDir = await tmpRunsDir();
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("one", [makeStep({ name: "a" })])));
    await engine.executeRun(run.runId);
    await expect(engine.resumeRun(run.runId)).rejects.toBeInstanceOf(EngineError);
    await expect(engine.resumeRun(run.runId, { fromStep: "nope" })).rejects.toThrow(/cannot resume/);
    const other = new Engine({ runsDir, evalWhen: evalWhenStub });
    await expect(other.resumeRun(run.runId)).rejects.toThrow(/registerWorkflow/);
  });
});
