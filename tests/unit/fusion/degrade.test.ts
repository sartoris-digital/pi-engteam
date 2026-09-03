import { describe, expect, it } from "vitest";
import { mergeSample } from "../../../src/fusion/sample.js";
import { mergeVeto } from "../../../src/fusion/veto.js";
import { runFusion } from "../../../src/fusion/run.js";
import type { FusionRequest, FusionSlot } from "../../../src/fusion/types.js";
import { FACTORY_EVENTS } from "../../../src/observer/events.js";
import type { FactoryEvent } from "../../../src/observer/events.js";
import type { WorkerExecutor, WorkerRequest, WorkerResult } from "../../../src/runtime/types.js";

function baseReq(over: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId: "run-1",
    runDir: "/tmp/run",
    runsDir: "/tmp",
    stage: "judge",
    round: 0,
    agent: { name: "judge", model: "default-model", promptPath: "/dev/null", tools: ["read"], stageClass: "read-only" },
    promptPath: "/tmp/p.md",
    cwd: "/tmp/ws",
    projectRoot: "/tmp/repo",
    policyFile: "/dev/null",
    policySha: "0".repeat(64),
    extraUpsert: [],
    denyUpsert: [],
    nonce: "nonce-fusion",
    timeoutMs: 180_000,
    signal: new AbortController().signal,
    piBinary: "pi",
    tools: ["read"],
    ...over,
  };
}

function ok(model: string): WorkerResult {
  return { verdict: { step: "x", verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 3 };
}

describe("runFusion degradation", () => {
  it("veto with one timed-out slot is FAIL, not PASS", async () => {
    const events: FactoryEvent[] = [];
    const executor: WorkerExecutor = {
      async run(req) {
        if (req.agent.model === "model-b") {
          return { verdict: { step: req.stage, verdict: "PASS" }, exitCode: 1, timedOut: true, stderrTail: "", durationMs: 300 };
        }
        return { verdict: { step: req.stage, verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 4 };
      },
    };
    const req: FusionRequest = {
      mode: "veto",
      stage: "judge",
      slots: [
        { name: "A", model: "model-a" },
        { name: "B", model: "model-b" },
      ],
    };
    const result = await runFusion({
      req,
      executor,
      base: baseReq(),
      merge: mergeVeto,
      slotTimeoutMs: 300,
      emit: (e) => events.push(e),
    });
    expect(result.verdict).toBe("FAIL");
    expect(events.some((e) => e.type === "factory.fusion.degraded")).toBe(true);
    const degraded = events.find((e) => e.type === "factory.fusion.degraded");
    expect(degraded?.data).toMatchObject({ requested: ["A", "B"], ran: ["A"] });
  });

  it("sample with one timeout merges remaining and records evidence.ran length 1", async () => {
    const executor: WorkerExecutor = {
      async run(req) {
        if (req.agent.model === "model-b") {
          return { verdict: null, exitCode: null, timedOut: true, stderrTail: "timeout", durationMs: 300 };
        }
        return {
          verdict: { step: req.stage, verdict: "PASS", flags: ["security"] },
          exitCode: 0,
          timedOut: false,
          stderrTail: "",
          durationMs: 5,
        };
      },
    };
    const result = await runFusion({
      req: {
        mode: "sample",
        stage: "review",
        slots: [
          { name: "A", model: "model-a" },
          { name: "B", model: "model-b" },
        ],
      },
      executor,
      base: baseReq({ stage: "review" }),
      merge: mergeSample,
      slotTimeoutMs: 300,
    });
    expect(result.verdict).toBe("PASS");
    expect(result.evidence?.fusion?.ran).toHaveLength(1);
    expect(result.evidence?.fusion?.ran?.[0]?.name).toBe("A");
    expect(result.evidence?.fusion?.mode).toBe("sample");
    expect(result.evidence?.fusion?.merge.discarded).toEqual(["B"]);
    expect(result.evidence?.fusion?.merge.method).toBe("sample");
  });

  it("drops a throwing slot and continues sample with the survivor", async () => {
    const executor: WorkerExecutor = {
      async run(req) {
        if (req.agent.model === "model-a") throw new Error("provider down");
        return ok(req.agent.model);
      },
    };
    const result = await runFusion({
      req: {
        mode: "sample",
        stage: "review",
        slots: [
          { name: "A", model: "model-a" },
          { name: "B", model: "model-b" },
        ],
      },
      executor,
      base: baseReq({ stage: "review" }),
      merge: mergeSample,
      slotTimeoutMs: 1_000,
    });
    expect(result.verdict).toBe("PASS");
    expect(result.evidence?.fusion?.ran).toHaveLength(1);
    expect(result.evidence?.fusion?.ran?.[0]?.name).toBe("B");
  });
});

describe("resolvePinnedModel", () => {
  it("degrades an unavailable pin to the default model and is never silent", async () => {
    const { resolvePinnedModel } = await import("../../../src/fusion/degrade.js");
    const stack: FusionSlot[] = [
      { name: "A", model: "model-a" },
      { name: "B", model: "model-b" },
    ];
    expect(resolvePinnedModel("B", stack, "default-model")).toEqual({
      model: "model-b",
      degraded: false,
      requested: "B",
    });
    expect(resolvePinnedModel("B", stack, "default-model", new Set(["B"]))).toEqual({
      model: "default-model",
      degraded: true,
      requested: "B",
    });
    expect(resolvePinnedModel("Z", stack, "default-model")).toEqual({
      model: "default-model",
      degraded: true,
      requested: "Z",
    });
  });
});

describe("FACTORY_EVENTS", () => {
  it("includes factory.fusion.degraded", () => {
    expect(FACTORY_EVENTS).toContain("factory.fusion.degraded");
  });
});
