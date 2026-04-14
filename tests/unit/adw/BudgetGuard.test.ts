import { describe, it, expect } from "vitest";
import { checkBudget, tickBudget } from "../../../src/adw/BudgetGuard.js";
import type { RunState } from "../../../src/types.js";

function makeState(overrides: Partial<RunState["budget"]> & { spent?: Partial<RunState["budget"]["spent"]> } = {}): RunState {
  const { spent: spentOverrides, ...budgetOverrides } = overrides;
  return {
    runId: "r", workflow: "w", goal: "g",
    status: "running", currentStep: "plan",
    iteration: 0,
    budget: {
      maxIterations: 8,
      maxCostUsd: 20,
      maxWallSeconds: 3600,
      maxTokens: 1_000_000,
      spent: { costUsd: 0, wallSeconds: 0, tokens: 0, ...spentOverrides },
      ...budgetOverrides,
    },
    steps: [], artifacts: {}, approvals: [], planMode: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

describe("checkBudget", () => {
  it("returns ok=true with no warnings when all at 0%", () => {
    const result = checkBudget(makeState());
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.exhausted).toHaveLength(0);
  });

  it("warns at 75% of iterations", () => {
    const state = makeState();
    state.iteration = 6;
    const result = checkBudget(state);
    expect(result.warnings).toContain("iterations");
    expect(result.exhausted).not.toContain("iterations");
  });

  it("exhausted at 100% of iterations", () => {
    const state = makeState();
    state.iteration = 8;
    const result = checkBudget(state);
    expect(result.exhausted).toContain("iterations");
    expect(result.ok).toBe(false);
  });

  it("warns at 75% of cost", () => {
    const result = checkBudget(makeState({ spent: { costUsd: 15, wallSeconds: 0, tokens: 0 } }));
    expect(result.warnings).toContain("cost");
  });

  it("exhausted at 100% of cost", () => {
    const result = checkBudget(makeState({ spent: { costUsd: 20, wallSeconds: 0, tokens: 0 } }));
    expect(result.exhausted).toContain("cost");
  });

  it("warns at 75% of wall time", () => {
    const result = checkBudget(makeState({ spent: { costUsd: 0, wallSeconds: 2700, tokens: 0 } }));
    expect(result.warnings).toContain("wall");
  });
});

describe("tickBudget", () => {
  it("adds elapsed seconds to spent.wallSeconds", () => {
    const state = makeState({ spent: { costUsd: 0, wallSeconds: 100, tokens: 0 } });
    const updated = tickBudget(state, 50);
    expect(updated.budget.spent.wallSeconds).toBe(150);
  });

  it("does not mutate the original state", () => {
    const state = makeState();
    const updated = tickBudget(state, 100);
    expect(state.budget.spent.wallSeconds).toBe(0);
    expect(updated.budget.spent.wallSeconds).toBe(100);
  });
});
