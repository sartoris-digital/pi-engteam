import type { RunState, Step, Workflow } from "./types.js";

export interface BudgetCheck {
  exhausted: ("wall" | "cost" | "iterations")[];
}

/** Slack added on top of clean-pass steps + fixRounds × cycle. */
export const ITERATION_SLACK = 2;

/** The terminal, budget-exempt host step every escalation runs. */
export function isTerminalStep(step: Step): boolean {
  return step.kind === "host" && step.host === "escalate";
}

export function cleanPassSteps(workflow: Workflow): number {
  return workflow.steps.filter((s) => !isTerminalStep(s)).length;
}

/**
 * Number of steps from the earliest fix-round back-edge target to the latest
 * fix-round source, inclusive. 0 when no fix-round back-edge exists.
 */
export function fixCycleLength(workflow: Workflow): number {
  const index = new Map<string, number>();
  workflow.steps.forEach((s, i) => index.set(s.name, i));
  let earliestTarget = Number.POSITIVE_INFINITY;
  let latestSource = -1;
  for (const step of workflow.steps) {
    if (step.onFail !== "fix-round") continue;
    const from = index.get(step.name);
    if (from === undefined) continue;
    for (const t of workflow.transitions) {
      if (t.from !== step.name || t.to === "halt" || t.to === "escalate") continue;
      const to = index.get(t.to);
      if (to === undefined || to > from) continue; // forward edge, not a fix cycle
      earliestTarget = Math.min(earliestTarget, to);
      latestSource = Math.max(latestSource, from);
    }
  }
  return latestSource < 0 ? 0 : latestSource - earliestTarget + 1;
}

/** maxIterations backstop: never trips before the per-stage round counters. */
export function computeIterationBudget(workflow: Workflow): number {
  return cleanPassSteps(workflow) + workflow.budget.fixRounds * fixCycleLength(workflow) + ITERATION_SLACK;
}

export function checkBudget(state: RunState, workflow: Workflow): BudgetCheck {
  const exhausted: BudgetCheck["exhausted"] = [];
  const { maxWallSeconds, maxCostUsd } = state.budget;
  const maxIterations = state.budget.maxIterations > 0 ? state.budget.maxIterations : computeIterationBudget(workflow);
  if (maxWallSeconds > 0 && state.wallSecondsUsed >= maxWallSeconds) exhausted.push("wall");
  if (maxCostUsd > 0 && state.costUsd >= maxCostUsd) exhausted.push("cost");
  if (state.iteration >= maxIterations) exhausted.push("iterations");
  return { exhausted };
}
