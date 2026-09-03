import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/config/json.js";
import { computeIterationBudget, isTerminalStep } from "../../../src/engine/budget.js";
import type { StepResult } from "../../../src/engine/types.js";
import { CATALOG } from "../../../src/lanes/catalog.js";
import {
  CompileError,
  DEFAULT_STAGE_TIMEOUT_SECONDS,
  compileLane,
  laneSha8,
  workflowName,
} from "../../../src/lanes/compile.js";
import type { StageHooks } from "../../../src/lanes/hooks.js";
import type { NamedLane, StageDef } from "../../../src/lanes/schema.js";

const hooks: StageHooks = {
  agentStep: (def) => async () => ({ verdict: "PASS", artifacts: { agent: def.agent ?? "" } }),
  hostStep: (def) => async () => ({ verdict: "PASS", artifacts: { host: def.host ?? "" } }),
  humanStep: () => async () => ({ verdict: "PASS" }),
};

function lane(over: Partial<NamedLane> & { stages: StageDef[] }): NamedLane {
  return {
    name: "chore",
    class: "build",
    match: { kind: "chore" },
    priority: 100,
    budget: { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 },
    onExhausted: "escalate",
    ...over,
  };
}

const choreStages: StageDef[] = [
  { name: "scope-check", host: "scope-check", locked: true },
  { name: "plan", agent: "planner", mode: "approach", onFail: "escalate:needs-decision" },
  { name: "steer", human: true, packet: "steer-packet", locked: true, onFail: "escalate:needs-decision" },
  { name: "implement", agent: "implementer", verify: true, onFail: "fix-round" },
  { name: "test", host: "checks", locked: true, onFail: "fix-round", gates: ["checks-green"] },
  { name: "review", agent: "reviewer", onFail: "fix-round", maxRounds: 1 },
  { name: "security", agent: "security-auditor", when: "tier == 'elevated'", onFail: "fix-round", maxRounds: 1 },
  { name: "judge", agent: "judge", safetyGating: true, locked: true, onFail: "fix-round" },
  { name: "publish", host: "publish", locked: true, onFail: "escalate:publish-refused" },
];

describe("compileLane", () => {
  it("maps agent/host/human stages onto Step.kind and wires the matching hook", async () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    expect(wf.steps.find((s) => s.name === "plan")).toMatchObject({ kind: "agent", agent: "planner", mode: "approach" });
    expect(wf.steps.find((s) => s.name === "test")).toMatchObject({ kind: "host", host: "checks" });
    expect(wf.steps.find((s) => s.name === "steer")).toMatchObject({ kind: "human" });
    const impl = wf.steps.find((s) => s.name === "implement")!;
    expect(await impl.run({} as never)).toMatchObject({ verdict: "PASS", artifacts: { agent: "implementer" } });
  });

  it("copies gates, onFail, when, locked, safetyGating, verify, maxRounds and default timeout", () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    expect(DEFAULT_STAGE_TIMEOUT_SECONDS).toBe(1800);
    const test = wf.steps.find((s) => s.name === "test")!;
    expect(test.gates).toEqual(["checks-green"]);
    expect(test.onFail).toBe("fix-round");
    expect(test.locked).toBe(true);
    expect(test.timeoutSeconds).toBe(1800);
    const judge = wf.steps.find((s) => s.name === "judge")!;
    expect(judge.safetyGating).toBe(true);
    const impl = wf.steps.find((s) => s.name === "implement")!;
    expect(impl.verify).toBe(true);
    const sec = wf.steps.find((s) => s.name === "security")!;
    expect(sec.when).toBe("tier == 'elevated'");
    expect(sec.maxRounds).toBe(1);
  });

  it("appends a terminal host escalate step when the YAML omitted it", () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    const last = wf.steps[wf.steps.length - 1]!;
    expect(last).toMatchObject({ name: "escalate", kind: "host", host: "escalate" });
    expect(isTerminalStep(last)).toBe(true);
    expect(wf.steps.filter((s) => s.name === "escalate")).toHaveLength(1);
  });

  it("generates linear PASS transitions and halt from the last non-terminal step", () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    const pass = (from: string): string | "halt" | "escalate" => {
      const t = wf.transitions.find((x) => x.from === from && x.when({ verdict: "PASS" } as StepResult));
      return t?.to ?? "missing";
    };
    expect(pass("scope-check")).toBe("plan");
    expect(pass("plan")).toBe("steer");
    expect(pass("publish")).toBe("halt");
  });

  it("routes fix-round FAIL back to the most recent implement-class stage", () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    const failTo = (from: string): string | "halt" | "escalate" => {
      const t = wf.transitions.find((x) => x.from === from && x.when({ verdict: "FAIL" } as StepResult));
      return t?.to ?? "missing";
    };
    expect(failTo("implement")).toBe("implement");
    expect(failTo("test")).toBe("implement");
    expect(failTo("review")).toBe("implement");
    expect(failTo("judge")).toBe("implement");
  });

  it("routes escalate:* FAIL to escalate and continue FAIL to the next step", () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    const failTo = (from: string): string | "halt" | "escalate" => {
      const t = wf.transitions.find((x) => x.from === from && x.when({ verdict: "FAIL" } as StepResult));
      return t?.to ?? "missing";
    };
    expect(failTo("plan")).toBe("escalate");
    expect(failTo("publish")).toBe("escalate");
    const linear = compileLane(
      lane({
        stages: [
          { name: "scope-check", host: "scope-check", onFail: "continue" },
          { name: "plan", agent: "planner", onFail: "continue" },
        ],
      }),
      CATALOG,
      hooks,
    );
    const t = linear.transitions.find((x) => x.from === "scope-check" && x.when({ verdict: "FAIL" } as StepResult));
    expect(t?.to).toBe("plan");
  });

  it("names the workflow factory-sdlc:<lane>@<sha8> using config canonicalJson", () => {
    const named = lane({ stages: choreStages });
    const wf = compileLane(named, CATALOG, hooks);
    const payload = {
      name: named.name,
      class: named.class,
      match: named.match,
      priority: named.priority,
      budget: named.budget,
      stages: named.stages,
      publish: named.publish,
      gateless: named.gateless,
      onExhausted: named.onExhausted,
    };
    const sha8 = createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 8);
    expect(laneSha8(named)).toBe(sha8);
    expect(workflowName(named)).toBe(`factory-sdlc:chore@${sha8}`);
    expect(wf.name).toBe(workflowName(named));
    expect(wf.lane).toBe("chore");
    expect(wf.laneClass).toBe("build");
    expect(laneSha8(named)).toBe(laneSha8({ ...named, match: { kind: "chore" } })); // key order
  });

  it("fills maxIterations from computeIterationBudget", () => {
    const wf = compileLane(lane({ stages: choreStages }), CATALOG, hooks);
    expect(wf.budget.fixRounds).toBe(2);
    expect(wf.budget.maxWallSeconds).toBe(2700);
    expect(wf.budget.maxCostUsd).toBe(8);
    expect(wf.budget.maxIterations).toBe(computeIterationBudget(wf));
    expect(wf.budget.maxIterations).toBe(9 + 2 * 5 + 2); // chore-shaped: 9 clean, cycle 5
  });

  it("throws CompileError on unknown catalog ids and on fusion of implement/host stages", () => {
    expect(() =>
      compileLane(lane({ stages: [{ name: "plan", agent: "not-an-agent" }] }), CATALOG, hooks),
    ).toThrow(CompileError);
    expect(() =>
      compileLane(lane({ stages: [{ name: "plan", agent: "planner", mode: "not-a-mode" }] }), CATALOG, hooks),
    ).toThrow(CompileError);
    expect(() =>
      compileLane(lane({ stages: [{ name: "plan", agent: "planner", gates: ["not-a-gate"] }] }), CATALOG, hooks),
    ).toThrow(CompileError);
    expect(() =>
      compileLane(
        lane({ stages: [{ name: "implement", agent: "implementer", fusion: { mode: "veto" } }] }),
        CATALOG,
        hooks,
      ),
    ).toThrow(/fusion/);
    expect(() =>
      compileLane(lane({ stages: [{ name: "test", host: "checks", fusion: { mode: "sample" } }] }), CATALOG, hooks),
    ).toThrow(/fusion/);
  });
});
