import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompileError, compileLane } from "../../../src/lanes/compile.js";
import { CATALOG } from "../../../src/lanes/catalog.js";
import type { StageHooks } from "../../../src/lanes/hooks.js";
import type { NamedLane, StageDef } from "../../../src/lanes/schema.js";
import { mergeDebate } from "../../../src/fusion/debate.js";
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

describe("runFusion debate rounds", () => {
  let runDir = "";

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), "fusion-debate-"));
  });

  afterAll(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });

  /** One opinion per slot per round, so every round is textually distinct. */
  function opinionExecutor(fail: Record<string, number> = {}): { executor: WorkerExecutor; calls: WorkerRequest[] } {
    const seen = new Map<string, number>();
    const calls: WorkerRequest[] = [];
    const executor: WorkerExecutor = {
      async run(req) {
        calls.push(req);
        const model = req.agent.model;
        const round = (seen.get(model) ?? 0) + 1;
        seen.set(model, round);
        if (fail[model] === round) throw new Error(`${model} provider down`);
        return worker("PASS", [`${model} position in round ${round}`]);
      },
    };
    return { executor, calls };
  }

  function debateReq(over: Partial<FusionRequest> = {}): FusionRequest {
    return {
      mode: "debate",
      stage: "judge",
      slots: [
        { name: "A", model: "model-a" },
        { name: "B", model: "model-b" },
      ],
      ...over,
    };
  }

  it("re-dispatches every slot in round 2 with the other slot's fenced prior opinion", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const { executor, calls } = opinionExecutor();
    const result = await runFusion({
      req: debateReq({ rounds: 2 }),
      executor,
      base: baseReq({ runDir }),
      merge: mergeDebate,
      slotTimeoutMs: 1_000,
    });

    expect(calls).toHaveLength(4);
    const round2 = calls.filter((c) => c.round === 1);
    expect(round2).toHaveLength(2);
    expect(round2.every((c) => c.promptPath !== "/tmp/p.md")).toBe(true);

    const toA = round2.find((c) => c.agent.model === "model-a");
    const toB = round2.find((c) => c.agent.model === "model-b");
    const promptA = await readFile(toA?.promptPath ?? "", "utf8");
    const promptB = await readFile(toB?.promptPath ?? "", "utf8");

    // A hears B's complete round-1 opinion, fenced with the run nonce, and not its own.
    expect(promptA).toContain("## [B] model-b — CONCRETE OPINION");
    expect(promptA).toContain("<<<UNTRUSTED_FUSION-B_nonce-fusion_BEGIN>>>");
    expect(promptA).toContain("model-b position in round 1");
    expect(promptA).not.toContain("UNTRUSTED_FUSION-A_");
    expect(promptA).toContain('REQUIRED FINAL ACTION: call VerdictEmit with step="judge.slot-A"');

    expect(promptB).toContain("## [A] model-a — CONCRETE OPINION");
    expect(promptB).toContain("<<<UNTRUSTED_FUSION-A_nonce-fusion_BEGIN>>>");
    expect(promptB).toContain("model-a position in round 1");
    expect(promptB).not.toContain("UNTRUSTED_FUSION-B_");

    // The progression is recorded, and the merge sees the final round.
    const progression = result.artifacts?.debateRounds ?? "";
    expect(progression).toContain("## Round 1");
    expect(progression).toContain("## Round 2");
    expect(progression).toContain("model-a position in round 2");
    expect(result.artifacts?.debate ?? "").toContain("position in round 2");
    expect(result.artifacts?.debate ?? "").not.toContain("position in round 1");
  });

  it("drops a slot that errors mid-debate and continues with the rest", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const { executor, calls } = opinionExecutor({ "model-c": 1 });
    const result = await runFusion({
      req: debateReq({
        rounds: 2,
        slots: [
          { name: "A", model: "model-a" },
          { name: "B", model: "model-b" },
          { name: "C", model: "model-c" },
        ],
      }),
      executor,
      base: baseReq({ runDir }),
      merge: mergeDebate,
      slotTimeoutMs: 1_000,
      emit: () => undefined,
    });

    // 3 slots in round 1, only the two survivors in round 2.
    expect(calls).toHaveLength(5);
    expect(calls.filter((c) => c.round === 1).map((c) => c.agent.model).sort()).toEqual(["model-a", "model-b"]);
    expect(result.evidence?.fusion?.merge.discarded).toEqual(["C"]);
    expect(result.evidence?.fusion?.ran?.map((s) => s.name)).toEqual(["A", "B"]);

    // The dead participant is labelled in the survivors' packet, never silently missing.
    const promptA = await readFile(
      calls.find((c) => c.round === 1 && c.agent.model === "model-a")?.promptPath ?? "",
      "utf8",
    );
    expect(promptA).toContain("## [C] model-c — PARTICIPANT UNAVAILABLE");
    expect(promptA).not.toContain("provider down");
  });

  it("stops early when only one slot survives", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const { executor, calls } = opinionExecutor({ "model-b": 1 });
    const result = await runFusion({
      req: debateReq({ rounds: 3 }),
      executor,
      base: baseReq({ runDir }),
      merge: mergeDebate,
      slotTimeoutMs: 1_000,
      emit: () => undefined,
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.round === 0)).toBe(true);
    expect(result.evidence?.fusion?.merge.discarded).toEqual(["B"]);
    expect(result.artifacts?.debateRounds).toBeUndefined();
  });

  it("stops early when no position changed between rounds", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const calls: WorkerRequest[] = [];
    const executor: WorkerExecutor = {
      async run(req) {
        calls.push(req);
        return worker("PASS", ["the bug is in parse()"]);
      },
    };
    await runFusion({
      req: debateReq({ rounds: 3 }),
      executor,
      base: baseReq({ runDir }),
      merge: mergeDebate,
      slotTimeoutMs: 1_000,
    });
    // Round 1 + round 2 only: round 2 repeated round 1 verbatim, so round 3 never runs.
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.round === 2)).toHaveLength(0);
  });

  it.each([{ name: "rounds absent", rounds: undefined }, { name: "rounds = 1", rounds: 1 }])(
    "$name fans out exactly once on the original prompt",
    async ({ rounds }) => {
      const { runFusion } = await import("../../../src/fusion/run.js");
      const { executor, calls } = opinionExecutor();
      const result = await runFusion({
        req: debateReq(rounds === undefined ? {} : { rounds }),
        executor,
        base: baseReq({ runDir }),
        merge: mergeDebate,
        slotTimeoutMs: 1_000,
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.promptPath === "/tmp/p.md")).toBe(true);
      expect(calls.every((c) => c.round === 0)).toBe(true);
      expect(result.artifacts?.debateRounds).toBeUndefined();
      expect(result.artifacts?.debate ?? "").toContain("position in round 1");
    },
  );

  it("caps a debate at three rounds however many were requested", async () => {
    const { runFusion } = await import("../../../src/fusion/run.js");
    const { executor, calls } = opinionExecutor();
    await runFusion({
      req: debateReq({ rounds: 9 }),
      executor,
      base: baseReq({ runDir }),
      merge: mergeDebate,
      slotTimeoutMs: 1_000,
    });
    expect(calls).toHaveLength(6);
    expect(calls.filter((c) => c.round === 2)).toHaveLength(2);
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
