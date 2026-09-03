import { describe, expect, it } from "vitest";
import { CompileError, compileLane } from "../../../src/lanes/compile.js";
import { CATALOG } from "../../../src/lanes/catalog.js";
import type { StageHooks } from "../../../src/lanes/hooks.js";
import type { NamedLane, StageDef } from "../../../src/lanes/schema.js";
import { mergeVeto } from "../../../src/fusion/veto.js";
import type { FusionRequest } from "../../../src/fusion/types.js";
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

function worker(verdict: "PASS" | "FAIL" | "NEEDS_MORE", issues?: string[]): WorkerResult {
  return {
    verdict: { step: "judge", verdict, ...(issues ? { issues } : {}) },
    exitCode: 0,
    timedOut: false,
    stderrTail: "",
    durationMs: 4,
  };
}

const hooks: StageHooks = {
  agentStep: (def) => async () => ({ verdict: "PASS", artifacts: { agent: def.agent ?? "" } }),
  hostStep: (def) => async () => ({ verdict: "PASS", artifacts: { host: def.host ?? "" } }),
  humanStep: () => async () => ({ verdict: "PASS" }),
};

function lane(stages: StageDef[]): NamedLane {
  return {
    name: "chore",
    class: "build",
    match: { kind: "chore" },
    priority: 100,
    budget: { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 },
    stages,
  };
}

describe("runFusion", () => {
  it("fans out two WorkerRequests with different models and mergeVeto FAILs if one FAILs", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const calls: WorkerRequest[] = [];
    const executor: WorkerExecutor = {
      async run(req) {
        calls.push(req);
        if (req.agent.model === "model-b") return worker("FAIL", ["nope"]);
        return worker("PASS");
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
      slotTimeoutMs: 300_000,
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.agent.model).sort()).toEqual(["model-a", "model-b"]);
    expect(calls.every((c) => c.stage.startsWith("judge.slot-"))).toBe(true);
    expect(result.verdict).toBe("FAIL");
    expect(calls[0]?.agent).not.toBe(calls[1]?.agent);
    expect(result.issues?.join(" ")).toMatch(/nope/);
  });

  it("fusion.off runs a single slot on the synthesizer/default model", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const calls: WorkerRequest[] = [];
    const executor: WorkerExecutor = {
      async run(req) {
        calls.push(req);
        return worker("PASS");
      },
    };
    const result = await runFusion({
      req: {
        mode: "veto",
        stage: "judge",
        synthesizer: "synth-model",
        slots: [
          { name: "A", model: "model-a" },
          { name: "B", model: "model-b" },
        ],
      },
      executor,
      base: baseReq(),
      merge: mergeVeto,
      slotTimeoutMs: 300_000,
      off: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agent.model).toBe("synth-model");
    expect(calls[0]?.stage).toBe("judge");
    expect(result.verdict).toBe("PASS");
  });

  it("empty stack fans out a single default-model slot", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const calls: WorkerRequest[] = [];
    const executor: WorkerExecutor = {
      async run(req) {
        calls.push(req);
        return worker("PASS");
      },
    };
    await runFusion({
      req: { mode: "sample", stage: "review", slots: [] },
      executor,
      base: baseReq({ stage: "review" }),
      merge: mergeVeto,
      slotTimeoutMs: 1_000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agent.model).toBe("default-model");
  });

  it("fences slot outputs with fenceArray before merge", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const executor: WorkerExecutor = {
      async run() {
        return worker("PASS", ["finding text"]);
      },
    };
    let sawFence = false;
    await runFusion({
      req: {
        mode: "opinion",
        stage: "plan",
        slots: [
          { name: "A", model: "model-a" },
          { name: "B", model: "model-b" },
        ],
      },
      executor,
      base: baseReq({ stage: "plan" }),
      merge: (slots) => {
        sawFence = slots.every((s) => (s.fenced ?? "").includes("UNTRUSTED") && (s.fenced ?? "").includes("nonce-fusion"));
        return { verdict: "PASS" };
      },
      slotTimeoutMs: 1_000,
    });
    expect(sawFence).toBe(true);
  });
});

describe("compileLane fusion", () => {
  it("still compile-errors fusion on implement and host stages", () => {
    expect(() =>
      compileLane(lane([{ name: "implement", agent: "implementer", fusion: { mode: "veto" } }]), CATALOG, hooks),
    ).toThrow(CompileError);
    expect(() =>
      compileLane(lane([{ name: "test", host: "checks", fusion: { mode: "sample" } }]), CATALOG, hooks),
    ).toThrow(/fusion/);
  });

  it("emits one engine step for a fused review stage (no dependsOn DAG)", () => {
    const wf = compileLane(
      lane([{ name: "review", agent: "reviewer", fusion: { mode: "veto", slots: ["A", "B"] } }]),
      CATALOG,
      hooks,
    );
    const review = wf.steps.filter((s) => s.name === "review");
    expect(review).toHaveLength(1);
    expect(wf.steps.some((s) => s.name.startsWith("review.slot-"))).toBe(false);
    expect(review[0] && "dependsOn" in review[0]).toBe(false);
  });
});
