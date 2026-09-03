import { describe, expect, it } from "vitest";
import { CATALOG } from "../../../src/lanes/catalog.js";
import { compileLane } from "../../../src/lanes/compile.js";
import type { StageHooks } from "../../../src/lanes/hooks.js";
import { checkInvariants } from "../../../src/lanes/invariants.js";
import { loadBuiltinLanes } from "../../../src/lanes/load.js";
import { classifyGrillAnswer } from "../../../src/controller/grill.js";

const hooks: StageHooks = {
  agentStep: (def) => async () => ({ verdict: "PASS", artifacts: { agent: def.agent ?? "" } }),
  hostStep: (def) => async () => ({ verdict: "PASS", artifacts: { host: def.host ?? "" } }),
  humanStep: () => async () => ({ verdict: "PASS" }),
};

describe("grill lane YAML", () => {
  it("matches spec §4.11 stage names and is a valid pre-build lane", async () => {
    const lanes = await loadBuiltinLanes();
    const grill = lanes.grill;
    expect(grill).toBeDefined();
    expect(grill?.class).toBe("pre-build");
    expect(grill?.budget).toEqual({ fixRounds: 1, maxWallSeconds: 3600, maxCostUsd: 6 });
    expect(grill?.stages.map((s) => s.name)).toEqual([
      "frame", "interrogate", "spec", "challenge", "revise", "plan", "handoff",
    ]);
    expect(grill?.stages.find((s) => s.name === "frame")).toMatchObject({ agent: "codebase-cartographer" });
    expect(grill?.stages.find((s) => s.name === "interrogate")).toMatchObject({
      agent: "discoverer",
      mode: "grill",
      maxRounds: 4,
    });
    expect(grill?.stages.find((s) => s.name === "challenge")).toMatchObject({ agent: "architect", mode: "refute" });
    expect(grill?.stages.at(-1)).toMatchObject({ name: "handoff", human: true, packet: "handoff" });
    expect(grill?.stages.some((s) => s.host === "publish")).toBe(false);
    expect(checkInvariants({ ...grill!, name: "grill" }, CATALOG)).toEqual([]);
  });

  it("compileLane(grill) ends on a human handoff and has no implement stage", async () => {
    const grill = (await loadBuiltinLanes()).grill!;
    const wf = compileLane({ ...grill, name: "grill" }, CATALOG, hooks);
    const yamlSteps = wf.steps.filter((s) => s.name !== "escalate");
    expect(yamlSteps.at(-1)).toMatchObject({ name: "handoff", kind: "human" });
    expect(wf.steps.some((s) => s.name === "implement" || s.agent === "implementer")).toBe(false);
    expect(wf.laneClass).toBe("pre-build");
  });
});

describe("classifyGrillAnswer", () => {
  it("classifies firm, soft, and deferred answers", () => {
    expect(classifyGrillAnswer("The users are billing ops who reconcile invoices daily.")).toBe("firm");
    expect(classifyGrillAnswer("maybe later")).toBe("soft");
    expect(classifyGrillAnswer("not sure")).toBe("soft");
    expect(classifyGrillAnswer("defer")).toBe("deferred");
    expect(classifyGrillAnswer("open question for later")).toBe("deferred");
  });

  it("treats a previously-soft short hedge as still soft so the host can re-ask once", () => {
    expect(classifyGrillAnswer("kind of")).toBe("soft");
    expect(classifyGrillAnswer("I think so")).toBe("soft");
  });
});
