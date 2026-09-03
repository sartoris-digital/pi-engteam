import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../../../src/engine/index.js";
import { cleanupTmpDirs, evalWhenStub, makeStep, makeWorkflow, startParams, tmpRunsDir } from "./helpers.js";

afterEach(cleanupTmpDirs);

describe("engine barrel", () => {
  it("exports the public engine API and nothing internal", () => {
    const names = Object.keys(engine).sort();
    expect(names).toEqual(
      [
        "ESCALATION_CODES", "Engine", "EngineError", "HUMAN_ACTIONS", "ITERATION_SLACK", "RUN_STATUSES",
        "agentLabel", "checkBudget", "cleanPassSteps", "computeIterationBudget", "evidencePath", "fixCycleLength",
        "resetRoundIterationGrant",
        "isEscalationCode", "isSafeRunId", "isTerminalStep", "listEvidence", "listRuns", "loadRunState", "markerLine",
        "newRunState", "readEvidence", "readGeneratedFile", "readGeneratedJson", "readRunSecret", "runDirPath",
        "saveRunState", "stripMarker", "ulid", "verifyEvidence", "writeEvidence", "writeGeneratedFile", "writeGeneratedJson",
      ].sort(),
    );
    expect(names).not.toContain("writeFileAtomic");
    expect(names).not.toContain("toPlainRecord");
    expect(names).not.toContain("RUN_SUBDIRS");
  });

  it("drives a one-step run through the barrel", async () => {
    const runsDir = await tmpRunsDir();
    const e = new engine.Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await e.startRun(startParams(makeWorkflow("one", [makeStep({ name: "a" })])));
    expect((await e.executeRun(run.runId)).status).toBe("succeeded");
    expect(await engine.listRuns(runsDir)).toEqual([run.runId]);
  });
});
