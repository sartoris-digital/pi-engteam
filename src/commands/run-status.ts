import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadRunState } from "../adw/RunState.js";

export function registerRunStatusCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand({
    name: "run-status",
    description: "Show current status, step, iteration, and budget for a run",
    argsSchema: Type.Object({
      runId: Type.String({ description: "Run ID" }),
    }),
    handler: async (args, _ctx) => {
      const state = await loadRunState(runsDir, args.runId);
      if (!state) return { message: `Run ${args.runId} not found.` };
      return {
        message: [
          `Run: ${state.runId}`,
          `Status: ${state.status}`,
          `Workflow: ${state.workflow}`,
          `Current step: ${state.currentStep}`,
          `Iteration: ${state.iteration}/${state.budget.maxIterations}`,
          `Cost: $${state.budget.spent.costUsd.toFixed(4)}/$${state.budget.maxCostUsd}`,
          `Wall time: ${Math.round(state.budget.spent.wallSeconds)}s/${state.budget.maxWallSeconds}s`,
          `Last verdict: ${state.steps.at(-1)?.verdict ?? "none"}`,
        ].join("\n"),
      };
    },
  });
}
