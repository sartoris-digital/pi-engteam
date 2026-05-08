import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRunState } from "../adw/RunState.js";
import { loadTasks } from "../team/tools/TaskList.js";
import { formatTillDoneDetailed } from "../adw/TillDoneFooter.js";

export function registerRunStatusCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("run-status", {
    description: "Show current status, step, iteration, budget, and TillDone task progress for a run. Usage: /run-status <runId>",
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
      // Phase 5.6 §9.2: include the multi-line TillDone task summary so
      // /run-status surfaces task progress alongside step + budget data.
      let tasksBlock = "";
      try {
        const tasks = await loadTasks(runsDir, runId);
        if (tasks.length > 0) {
          tasksBlock = "\n\n" + formatTillDoneDetailed({
            workflow: state.workflow,
            goal: state.goal,
            tasks,
          });
        }
      } catch { /* best-effort */ }
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
        ].join("\n") + tasksBlock,
        "info",
      );
    },
  });
}
