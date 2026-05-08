import { describe, it, expect } from "vitest";
import { resolveDag, validateWorkflow } from "../../../src/adw/DagResolver.js";
import type { Workflow, Step, StepContext, StepResult } from "../../../src/workflows/types.js";

function s(name: string, opts: Partial<Step> = {}): Step {
  return {
    name,
    required: true,
    run: async (_c: StepContext): Promise<StepResult> => ({ success: true, verdict: "PASS" }),
    ...opts,
  };
}

function wf(name: string, steps: Step[]): Workflow {
  return { name, description: "t", steps, transitions: [], defaults: {} };
}

describe("DagResolver", () => {
  it("linear workflow without dependsOn produces one step per level (legacy chain)", () => {
    const w = wf("legacy", [s("a"), s("b"), s("c")]);
    const levels = resolveDag(w);
    expect(levels).toHaveLength(3);
    expect(levels[0].parallel.map((x) => x.name)).toEqual(["a"]);
    expect(levels[1].parallel.map((x) => x.name)).toEqual(["b"]);
    expect(levels[2].parallel.map((x) => x.name)).toEqual(["c"]);
  });

  it("steps with same dependsOn collapse into a single parallel level", () => {
    const w = wf("fan-out", [
      s("dispatch", { dependsOn: [] }),
      s("a", { dependsOn: ["dispatch"] }),
      s("b", { dependsOn: ["dispatch"] }),
      s("c", { dependsOn: ["dispatch"] }),
    ]);
    const levels = resolveDag(w);
    expect(levels).toHaveLength(2);
    expect(new Set(levels[1].parallel.map((x) => x.name))).toEqual(new Set(["a", "b", "c"]));
  });

  it("fan-in: a single step depending on multiple parallel siblings runs in its own level", () => {
    const w = wf("fan-in", [
      s("dispatch", { dependsOn: [] }),
      s("a", { dependsOn: ["dispatch"] }),
      s("b", { dependsOn: ["dispatch"] }),
      s("synth", { dependsOn: ["a", "b"] }),
    ]);
    const levels = resolveDag(w);
    expect(levels).toHaveLength(3);
    expect(levels[2].parallel.map((x) => x.name)).toEqual(["synth"]);
  });

  it("parallel: false moves a step to the sequential slot of its level", () => {
    const w = wf("seq-flag", [
      s("dispatch", { dependsOn: [] }),
      s("a", { dependsOn: ["dispatch"] }),
      s("b", { dependsOn: ["dispatch"], parallel: false }),
      s("c", { dependsOn: ["dispatch"] }),
    ]);
    const levels = resolveDag(w);
    expect(levels[1].parallel.map((x) => x.name)).toEqual(["a", "c"]);
    expect(levels[1].sequential.map((x) => x.name)).toEqual(["b"]);
  });

  it("rejects an unknown dependency reference", () => {
    const w = wf("bad-dep", [s("a", { dependsOn: ["does-not-exist"] })]);
    expect(() => resolveDag(w)).toThrow(/unknown dependency/);
  });

  it("rejects a self cycle", () => {
    const w = wf("self-cycle", [s("a", { dependsOn: ["a"] })]);
    expect(() => resolveDag(w)).toThrow(/cycle detected/);
  });

  it("rejects a 2-step cycle", () => {
    const w = wf("two-cycle", [
      s("a", { dependsOn: ["b"] }),
      s("b", { dependsOn: ["a"] }),
    ]);
    expect(() => resolveDag(w)).toThrow(/cycle detected/);
  });

  it("rejects a 3-step cycle", () => {
    const w = wf("three-cycle", [
      s("a", { dependsOn: ["c"] }),
      s("b", { dependsOn: ["a"] }),
      s("c", { dependsOn: ["b"] }),
    ]);
    expect(() => resolveDag(w)).toThrow(/cycle detected/);
  });

  it("validateWorkflow throws on cycle so registration fails early", () => {
    const w = wf("cyc", [
      s("a", { dependsOn: ["b"] }),
      s("b", { dependsOn: ["a"] }),
    ]);
    expect(() => validateWorkflow(w)).toThrow(/cycle detected/);
  });

  it("validateWorkflow accepts a legitimate diamond DAG", () => {
    const w = wf("diamond", [
      s("root", { dependsOn: [] }),
      s("left", { dependsOn: ["root"] }),
      s("right", { dependsOn: ["root"] }),
      s("merge", { dependsOn: ["left", "right"] }),
    ]);
    expect(() => validateWorkflow(w)).not.toThrow();
  });

  it("declaration order is preserved when steps land in the same level", () => {
    const w = wf("order", [
      s("d", { dependsOn: [] }),
      s("z", { dependsOn: ["d"] }),
      s("y", { dependsOn: ["d"] }),
      s("x", { dependsOn: ["d"] }),
    ]);
    const levels = resolveDag(w);
    expect(levels[1].parallel.map((x) => x.name)).toEqual(["z", "y", "x"]);
  });

  it("consult-shaped workflow resolves to 4 levels (dispatch, positions, adversarial, synthesis)", () => {
    const w = wf("consult-shape", [
      s("dispatch", { dependsOn: [] }),
      s("pos-eng", { dependsOn: ["dispatch"] }),
      s("pos-val", { dependsOn: ["dispatch"] }),
      s("pos-inv", { dependsOn: ["dispatch"] }),
      s("adv-eng", { dependsOn: ["pos-eng", "pos-val", "pos-inv"] }),
      s("adv-val", { dependsOn: ["pos-eng", "pos-val", "pos-inv"] }),
      s("adv-inv", { dependsOn: ["pos-eng", "pos-val", "pos-inv"] }),
      s("synth", { dependsOn: ["adv-eng", "adv-val", "adv-inv"] }),
    ]);
    const levels = resolveDag(w);
    expect(levels).toHaveLength(4);
    expect(levels[0].parallel.map((x) => x.name)).toEqual(["dispatch"]);
    expect(levels[1].parallel).toHaveLength(3);
    expect(levels[2].parallel).toHaveLength(3);
    expect(levels[3].parallel.map((x) => x.name)).toEqual(["synth"]);
  });

  it("a workflow with no dependsOn declared at all stays linear", () => {
    const w = wf("legacy2", [s("plan"), s("build"), s("review")]);
    const levels = resolveDag(w);
    expect(levels.map((l) => l.parallel.map((s) => s.name))).toEqual([["plan"], ["build"], ["review"]]);
  });

  it("partial-failure independence: levels resolve regardless of step run() outcomes (resolver is structural only)", () => {
    const w = wf("structural-only", [
      s("a", { dependsOn: [] }),
      s("b", { dependsOn: ["a"] }),
    ]);
    const levels = resolveDag(w);
    expect(levels).toHaveLength(2);
    // resolver does not execute steps; verdict propagation is the engine's job.
  });
});
