import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../../../src/engine/engine.js";
import { readEvidence } from "../../../src/engine/evidence.js";
import { loadRunState, runDirPath } from "../../../src/engine/state.js";
import type { Step } from "../../../src/engine/types.js";
import { cleanupTmpDirs, evalWhenStub, makeStep, makeWorkflow, startParams, tmpRunsDir } from "./helpers.js";

afterEach(cleanupTmpDirs);

/** Resolves with the given result only once ctx.signal aborts. */
function untilAborted(
  result: Parameters<Step["run"]>[0] extends never ? never : Awaited<ReturnType<Step["run"]>>,
  onEntered?: () => void,
): Step["run"] {
  return async (ctx) => {
    onEntered?.();
    if (!ctx.signal.aborted) {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return result;
  };
}

describe("Engine.cancelRun", () => {
  it("aborts the running step and finalises cancelled at the next boundary", async () => {
    const runsDir = await tmpRunsDir();
    const log: string[] = [];
    let entered = (): void => undefined;
    const implementEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const steps = [
      makeStep({ name: "plan" }, async () => {
        log.push("plan");
        return { verdict: "PASS" };
      }),
      makeStep(
        { name: "implement", kind: "agent", agent: "implementer" },
        untilAborted({ verdict: "FAIL", issues: ["worker killed"] }, entered),
      ),
      makeStep({ name: "test" }, async () => {
        log.push("test");
        return { verdict: "PASS" };
      }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("cancel", steps)));
    const running = engine.executeRun(run.runId);
    await implementEntered;
    const ack = await engine.cancelRun(run.runId);
    expect(ack.phase).toBe("cancelling");
    const final = await running;
    expect(final.status).toBe("cancelled");
    expect(final.phase).toBeUndefined();
    expect(final.escalation).toBeUndefined();
    expect(log).toEqual(["plan"]);
    expect(final.steps.map((s) => [s.name, s.verdict])).toEqual([["plan", "PASS"], ["implement", "FAIL"]]);
    expect((await loadRunState(runsDir, run.runId))?.status).toBe("cancelled");
    await expect(engine.executeRun(run.runId)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels a run that is waiting for the user without executing anything", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [
      makeStep({ name: "steer", kind: "human" }, async () => ({ verdict: "PASS", pauseForUser: { reason: "steer" } })),
      makeStep({ name: "implement" }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("wait", steps)));
    expect((await engine.executeRun(run.runId)).status).toBe("waiting_user");
    const cancelled = await engine.cancelRun(run.runId);
    expect(cancelled.status).toBe("cancelled");
    expect((await loadRunState(runsDir, run.runId))?.status).toBe("cancelled");
    await expect(engine.resumeRun(run.runId)).rejects.toThrow(/cannot resume/);
  });
});

describe("step timeout", () => {
  it(
    "a step exceeding timeoutSeconds is FAIL with timedOut evidence — a late PASS is never accepted",
    async () => {
      const runsDir = await tmpRunsDir();
      const steps = [
        makeStep(
          { name: "implement", kind: "agent", agent: "implementer", timeoutSeconds: 0.05, onFail: "escalate:worker-crash" },
          untilAborted({ verdict: "PASS" }),
        ),
        makeStep({ name: "escalate", host: "escalate" }),
      ];
      const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
      const run = await engine.startRun(startParams(makeWorkflow("timeout", steps)));
      const final = await engine.executeRun(run.runId);
      expect(final.status).toBe("failed");
      expect(final.steps[0]?.verdict).toBe("FAIL");
      expect(final.steps[0]?.issues?.[0]).toMatch(/timed out after 0\.05s/);
      expect(final.escalation?.code).toBe("worker-crash");
      const ev = await readEvidence(runDirPath(runsDir, run.runId), "implement", 0);
      expect(ev?.timedOut).toBe(true);
      expect(ev?.verdict).toBe("FAIL");
    },
    { timeout: 1000 },
  );

  it("a step that throws becomes FAIL + worker-crash instead of crashing the engine", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [
      makeStep({ name: "implement", kind: "agent", agent: "implementer" }, async () => {
        throw new Error("spawn ENOENT");
      }),
      makeStep({ name: "escalate", host: "escalate" }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("throw", steps)));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.escalation?.code).toBe("worker-crash");
    expect(final.steps[0]?.issues?.[0]).toBe("step 'implement' threw: spawn ENOENT");
    expect((await loadRunState(runsDir, run.runId))?.status).toBe("failed");
  });
});
