import { describe, expect, it } from "vitest";
import {
  ITERATION_SLACK,
  checkBudget,
  cleanPassSteps,
  computeIterationBudget,
  fixCycleLength,
  isTerminalStep,
} from "../../../src/engine/budget.js";
import type { RunState, Step, Transition, Workflow } from "../../../src/engine/types.js";

function step(name: string, extra: Partial<Step> = {}): Step {
  return { name, kind: "host", host: name, gates: [], onFail: "continue", run: async () => ({ verdict: "PASS" }), ...extra };
}

/** Linear PASS chain; FAIL on fix-round steps goes to fixTarget, otherwise to "escalate". */
function transitions(steps: Step[], fixTarget?: string): Transition[] {
  const active = steps.filter((s) => !isTerminalStep(s));
  const out: Transition[] = [];
  active.forEach((s, i) => {
    const next = active[i + 1]?.name ?? "halt";
    out.push({ from: s.name, when: (r) => r.verdict === "PASS", to: next });
    if (s.onFail === "fix-round" && fixTarget) out.push({ from: s.name, when: (r) => r.verdict !== "PASS", to: fixTarget });
    else if (s.onFail === "continue") out.push({ from: s.name, when: (r) => r.verdict !== "PASS", to: next });
    else out.push({ from: s.name, when: (r) => r.verdict !== "PASS", to: "escalate" });
  });
  return out;
}

function workflow(steps: Step[], fixRounds: number, fixTarget?: string): Workflow {
  return {
    name: "factory-sdlc:test@deadbeef",
    lane: "test",
    laneClass: "build",
    steps,
    transitions: transitions(steps, fixTarget),
    budget: { fixRounds, maxWallSeconds: 2700, maxCostUsd: 8, maxIterations: 0 },
  };
}

const buildSteps: Step[] = [
  step("plan", { kind: "agent", agent: "planner", onFail: "escalate:needs-decision" }),
  step("gate", { kind: "agent", agent: "tester", onFail: "escalate:gate-invalid" }),
  step("steer", { kind: "human", onFail: "escalate:needs-decision" }),
  step("implement", { kind: "agent", agent: "implementer", onFail: "fix-round" }),
  step("test", { host: "checks", onFail: "fix-round" }),
  step("review", { kind: "agent", agent: "reviewer", onFail: "fix-round" }),
  step("judge", { kind: "agent", agent: "judge", safetyGating: true, onFail: "fix-round" }),
  step("publish", { host: "publish", onFail: "escalate:publish-refused" }),
  step("escalate", { host: "escalate" }),
];

describe("computeIterationBudget", () => {
  it("counts clean-pass steps without the terminal escalate step", () => {
    expect(isTerminalStep(buildSteps[8]!)).toBe(true);
    expect(cleanPassSteps(workflow(buildSteps, 2, "implement"))).toBe(8);
  });

  it("cycle = earliest back-edge target .. latest fix-round source, inclusive", () => {
    expect(fixCycleLength(workflow(buildSteps, 2, "implement"))).toBe(4); // implement,test,review,judge
  });

  it("= clean + fixRounds × cycle + slack", () => {
    expect(ITERATION_SLACK).toBe(2);
    expect(computeIterationBudget(workflow(buildSteps, 2, "implement"))).toBe(8 + 2 * 4 + 2);
    expect(computeIterationBudget(workflow(buildSteps, 4, "implement"))).toBe(8 + 4 * 4 + 2);
  });

  it("chore-shaped lane: 9 clean steps, cycle 5, 2 rounds → 21", () => {
    const chore: Step[] = [
      step("scope-check"),
      step("plan", { kind: "agent", agent: "planner", onFail: "escalate:needs-decision" }),
      step("steer", { kind: "human", onFail: "escalate:needs-decision" }),
      step("implement", { kind: "agent", agent: "implementer", onFail: "fix-round" }),
      step("test", { host: "checks", onFail: "fix-round" }),
      step("review", { kind: "agent", agent: "reviewer", onFail: "fix-round", maxRounds: 1 }),
      step("security", { kind: "agent", agent: "security-auditor", when: "tier == 'elevated'", onFail: "fix-round", maxRounds: 1 }),
      step("judge", { kind: "agent", agent: "judge", safetyGating: true, onFail: "fix-round" }),
      step("publish", { host: "publish", onFail: "escalate:publish-refused" }),
      step("escalate", { host: "escalate" }),
    ];
    expect(fixCycleLength(workflow(chore, 2, "implement"))).toBe(5);
    expect(computeIterationBudget(workflow(chore, 2, "implement"))).toBe(9 + 2 * 5 + 2);
  });

  it("a workflow without fix-round back-edges gets clean + slack", () => {
    const linear = [step("a"), step("b"), step("c")];
    expect(fixCycleLength(workflow(linear, 3))).toBe(0);
    expect(computeIterationBudget(workflow(linear, 3))).toBe(3 + 2);
  });
});

describe("checkBudget", () => {
  function state(over: Partial<RunState>): RunState {
    return {
      runId: "run-1",
      workflow: "factory-sdlc:test@deadbeef",
      lane: "test",
      kind: "chore",
      tier: "low",
      status: "running",
      currentStep: "plan",
      iteration: 0,
      rounds: {},
      steps: [],
      artifacts: {},
      ticket: { tracker: "local", ref: "local-1", title: "t" },
      workspaceDir: "/tmp/ws",
      mainCheckout: "/tmp/repo",
      branch: "b",
      baseSha: "0",
      hostCommits: [],
      budget: { fixRounds: 2, maxWallSeconds: 60, maxCostUsd: 8, maxIterations: 18 },
      wallSecondsUsed: 0,
      costUsd: 0,
      configSha: "c",
      nonce: "n",
      startedAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      ...over,
    };
  }
  const wf = workflow(buildSteps, 2, "implement");

  it("is empty inside every cap", () => {
    expect(checkBudget(state({ iteration: 17, wallSecondsUsed: 59.9, costUsd: 7.99 }), wf)).toEqual({ exhausted: [] });
  });

  it("reports wall, cost and iterations independently", () => {
    expect(checkBudget(state({ wallSecondsUsed: 60 }), wf).exhausted).toEqual(["wall"]);
    expect(checkBudget(state({ costUsd: 8 }), wf).exhausted).toEqual(["cost"]);
    expect(checkBudget(state({ iteration: 18 }), wf).exhausted).toEqual(["iterations"]);
    expect(checkBudget(state({ wallSecondsUsed: 61, costUsd: 9, iteration: 19 }), wf).exhausted).toEqual(["wall", "cost", "iterations"]);
  });

  it("derives maxIterations from the workflow when the state carries none", () => {
    const s = state({ budget: { fixRounds: 2, maxWallSeconds: 60, maxCostUsd: 8, maxIterations: 0 }, iteration: 18 });
    expect(checkBudget(s, wf).exhausted).toEqual(["iterations"]);
    s.iteration = 17;
    expect(checkBudget(s, wf).exhausted).toEqual([]);
  });

  it("a zero wall or cost cap means uncapped", () => {
    const s = state({ budget: { fixRounds: 2, maxWallSeconds: 0, maxCostUsd: 0, maxIterations: 18 }, wallSecondsUsed: 1e9, costUsd: 1e9 });
    expect(checkBudget(s, wf).exhausted).toEqual([]);
  });
});
