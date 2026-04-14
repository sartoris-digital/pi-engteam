import type { RunState, BudgetStatus } from "../types.js";

const WARN_THRESHOLD = 0.75;

export function checkBudget(state: RunState): BudgetStatus {
  const { budget, iteration } = state;
  const { maxIterations, maxCostUsd, maxWallSeconds, maxTokens, spent } = budget;

  const warnings: BudgetStatus["warnings"] = [];
  const exhausted: BudgetStatus["exhausted"] = [];

  function check(
    dimension: "iterations" | "cost" | "wall" | "tokens",
    current: number,
    max: number,
  ) {
    if (max <= 0) return;
    const ratio = current / max;
    if (ratio >= 1) exhausted.push(dimension);
    else if (ratio >= WARN_THRESHOLD) warnings.push(dimension);
  }

  check("iterations", iteration, maxIterations);
  check("cost", spent.costUsd, maxCostUsd);
  check("wall", spent.wallSeconds, maxWallSeconds);
  check("tokens", spent.tokens, maxTokens);

  return {
    ok: exhausted.length === 0,
    warnings,
    exhausted,
  };
}

export function tickBudget(state: RunState, elapsedSeconds: number): RunState {
  return {
    ...state,
    budget: {
      ...state.budget,
      spent: {
        ...state.budget.spent,
        wallSeconds: state.budget.spent.wallSeconds + elapsedSeconds,
      },
    },
  };
}
