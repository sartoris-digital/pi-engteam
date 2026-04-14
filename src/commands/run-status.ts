import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRunState } from "../adw/RunState.js";

export function registerRunStatusCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("run-status", {
    description: "Show current status, step, iteration, and budget for a run. Usage: /run-status <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-status <runId>", "error");
        return;
      }
      const state = await loadRunState(runsDir, runId);
      if (!state) {
        ctx.ui.notify(`Run ${runId} not found.`, "error");
        return;
      }
      ctx.ui.notify(
        [
          `Run: ${state.runId}`,
          `Status: ${state.status}`,
          `Workflow: ${state.workflow}`,
          `Current step: ${state.currentStep}`,
          `Iteration: ${state.iteration}/${state.budget.maxIterations}`,
          `Cost: $${state.budget.spent.costUsd.toFixed(4)}/$${state.budget.maxCostUsd}`,
          `Wall time: ${Math.round(state.budget.spent.wallSeconds)}s/${state.budget.maxWallSeconds}s`,
          `Last verdict: ${state.steps.at(-1)?.verdict ?? "none"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
